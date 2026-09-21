import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.js';
import { Workspace } from '../server/workspace.js';
import { emptyState, addConfig, makeDraft, exportBackup } from '../src/store.js';

function fixture(t, file = ':memory:') {
  const db = openDatabase(file); t.after(() => db.close());
  let clock = Date.parse('2026-09-21T08:00:00Z');
  for (const [id,role] of [['alice','operate'],['bob','admin'],['reader','readonly']]) db.prepare('INSERT OR IGNORE INTO users VALUES (?,?,?,?,1,0,?)').run(id,id,'unused',role,new Date(clock).toISOString());
  const ws = new Workspace(db, () => clock);
  const create = () => ws.execute({id:'alice'}, {type:'create',data:{project:'P',environment:'dev',name:'C',type:'json',draft:makeDraft('{"a":1}','json')}}).result;
  const command = (id,type,data={}, actor='alice',revision=ws.read().configs.find(c=>c.id===id)?.revision) => ws.execute({id:actor}, {type,id,expectedRevision:revision,data});
  return {db, ws, create, command, advance: ms => clock += ms};
}
test('server assigns editor and separate submitter with authoritative times', t => {
  const {ws,create,command,advance} = fixture(t), id=create();
  const first = ws.read().versions[0]; assert.equal(first.submittedByUsername,'alice');
  advance(1000); command(id,'draft',{draft:makeDraft('{"a":2}','json')});
  advance(2000); command(id,'submit',{note:'reviewed'},'bob');
  const v = ws.read().versions.at(-1);
  assert.equal(v.editedByUsername,'alice'); assert.equal(v.submittedByUsername,'bob');
  assert.equal(v.editedAt,'2026-09-21T08:00:01.000Z'); assert.equal(v.submittedAt,'2026-09-21T08:00:03.000Z');
  assert.equal(v.createdAt,v.submittedAt);
  command(id,'submit'); assert.equal(ws.read().versions.length,2);
});
test('readonly, forged identity, unknown commands and stale revisions cannot mutate', t => {
  const {ws,create,command} = fixture(t),id=create(),before=ws.read();
  assert.throws(()=>command(id,'draft',{draft:makeDraft('{}','json')},'reader'),e=>e.status===403);
  assert.throws(()=>command(id,'draft',{draft:{...makeDraft('{}','json'),editedByUsername:'bob'}}),/字段/);
  assert.throws(()=>command(id,'replace-state',{workspace:emptyState()}),/命令/);
  assert.throws(()=>command(id,'delete',{},'alice',-1),e=>e.status===409);
  assert.deepEqual(ws.read(),before);
});
test('auto archive uses saved editor, timing, validity and current permissions', t => {
  const {db,ws,create,command,advance}=fixture(t),id=create();
  command(id,'draft',{draft:makeDraft('{"a":2}','json')});
  advance(59000); ws.tick(); assert.equal(ws.read().versions.length,1);
  advance(1000); ws.tick(); assert.equal(ws.read().versions.length,2);
  assert.equal(ws.read().versions.at(-1).source,'auto');
  assert.equal(ws.read().versions.at(-1).submittedByUsername,'alice');
  command(id,'draft',{draft:makeDraft('{"a":3}','json')});
  db.prepare("UPDATE users SET role='readonly' WHERE id='alice'").run();
  advance(61000); ws.tick(); assert.equal(ws.read().versions.length,2);
  command(id,'submit',{},'bob'); assert.equal(ws.read().versions.at(-1).submittedByUsername,'bob');
  command(id,'draft',{draft:makeDraft('{broken','json')},'bob');
  advance(61000); ws.tick(); assert.equal(ws.read().versions.length,3);
});
test('restore preserves prior draft and stamps restorer without changing old version', t => {
  const {ws,create,command,advance}=fixture(t),id=create(),old=ws.read().versions[0];
  advance(1000); command(id,'draft',{draft:makeDraft('{"a":2}','json')}); command(id,'submit');
  command(id,'draft',{draft:makeDraft('{bad','json')}); advance(1000);
  command(id,'restore',{versionId:old.id},'bob');
  assert.deepEqual(ws.read().versions[0],old);
  assert.equal(ws.read().versions.at(-1).editedByUsername,'bob');
  assert.equal(ws.read().versions.at(-1).restoredFromVersionId,old.id);
  assert.equal(ws.read().recoveryDrafts.at(-1).rawInput,'{bad');
});
test('imports v1 and v2 as unverified history; filters credentials and avoids auto-archiving', t => {
  const {ws,advance}=fixture(t),state=emptyState();
  addConfig(state,{project:'P',environment:'dev',name:'Old',type:'json'},makeDraft('{}','json'));
  state.versions[0].submittedByUsername='bob'; state.versions[0].submittedByUserId='bob';
  state.versions[0].passwordHash='secret'; state.settings.token='secret';
  state.drafts[0].rawInput='{"x":1}'; state.drafts[0].editedByUserId='bob';
  const backup=exportBackup(state);
  ws.execute({id:'alice'},{type:'import',data:{backup,skipConflicts:false,importSettings:true}});
  let v=ws.read().versions[0]; assert.equal(v.provenance,'imported');
  assert.equal(v.submittedByUserId,null); assert.equal(v.importedByUsername,'alice');
  advance(120000); ws.tick(); assert.equal(ws.read().versions.length,1);
  const exported=ws.backup({id:'alice'}); assert.equal(exported.schemaVersion,2);
  assert.ok(!JSON.stringify(exported).includes('secret'));
  ws.execute({id:'alice'},{type:'import',data:{backup:exported}});
  assert.equal(ws.read().configs.length,2);
  assert.throws(()=>ws.backup({id:'reader'}),e=>e.status===403);
});
test('SQLite persists committed data across restart', t => {
  const dir=mkdtempSync(join(tmpdir(),'ops-workspace-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'test.sqlite'); const db=openDatabase(file);
  db.prepare('INSERT INTO users VALUES (?,?,?,?,1,0,?)').run('alice','alice','unused','operate',new Date().toISOString());
  const ws=new Workspace(db); ws.execute({id:'alice'},{type:'create',data:{project:'P',environment:'dev',name:'C',type:'json',draft:makeDraft('{}','json')}}); db.close();
  const reopened=openDatabase(file); assert.equal(new Workspace(reopened).read().versions[0].submittedByUsername,'alice'); reopened.close();
});
test('automatic archive does not invalidate a still-current editor draft',t=>{
  const {ws,create,command,advance}=fixture(t),id=create();
  command(id,'draft',{draft:makeDraft('{"a":2}','json')});
  const revision=ws.read().configs[0].revision;
  advance(61000);ws.tick();assert.equal(ws.read().versions.length,2);
  command(id,'draft',{draft:makeDraft('{"a":3}','json')},'alice',revision);
  assert.equal(ws.read().drafts[0].rawInput,'{"a":3}');
});
test('metadata, archive, clean and delete operate on the intended configuration only',t=>{
  const {ws,create,command}=fixture(t),id=create();
  command(id,'metadata',{name:'Renamed',description:'D',tags:['T'],itemMetadata:{'/a':true}},'bob');
  assert.equal(ws.read().configs[0].updatedByUsername,'bob');
  command(id,'archive');assert.throws(()=>command(id,'draft',{draft:makeDraft('{}','json')}),e=>e.status===409);
  command(id,'archive');command(id,'draft',{draft:makeDraft('{"a":2}','json')});command(id,'submit');
  const [old,latest]=ws.read().versions;
  assert.throws(()=>command(id,'clean',{versionIds:[latest.id]}),/最新版本/);
  command(id,'clean',{versionIds:[old.id]});assert.equal(ws.read().versions.length,1);
  command(id,'delete');assert.equal(ws.read().configs.length,0);assert.equal(ws.read().drafts.length,0);assert.equal(ws.read().versions.length,0);
});
test('auto and manual archive do not duplicate version numbers or erase old authors',t=>{
  const {ws,create,command,advance}=fixture(t),id=create();
  command(id,'draft',{draft:makeDraft('{"a":2}','json')});const revision=ws.read().configs[0].revision;
  advance(61000);ws.tick();const automatic=structuredClone(ws.read().versions.at(-1));
  command(id,'submit',{note:'same content'},'bob',revision);
  assert.equal(ws.read().versions.length,2);assert.deepEqual(ws.read().versions.at(-1),automatic);
});
