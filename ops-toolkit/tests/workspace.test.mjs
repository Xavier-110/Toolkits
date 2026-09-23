import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/database.js';
import { Workspace } from '../server/workspace.js';
import { legacyWorkspace, legacyBackup as exportBackup } from './fixtures/legacy-backup.mjs';
import { createHash } from 'node:crypto';

function fixture(t) {
  const db=openDatabase(':memory:');t.after(()=>db.close());
  for(const [id,role] of [['admin','admin'],['writer','operate'],['reader','readonly']]) db.prepare('INSERT INTO users VALUES (?,?,?,?,1,0,?)').run(id,id,'unused',role,'2026-09-21T00:00:00Z');
  const ws=new Workspace(db,()=>Date.parse('2026-09-21T08:00:00Z'));
  const run=(type,data={},id,expectedRevision,actor='admin')=>ws.execute({id:actor},{type,data,...(id===undefined?{}:{id}),...(expectedRevision===undefined?{}:{expectedRevision})}).result;
  const r=run('dictionary',{kind:'regions',code:'cn',label:'China'}).id;
  const e=run('dictionary',{kind:'environmentTypes',code:'prod',label:'Production'}).id;
  const n=run('dictionary',{kind:'configNames',code:'app',label:'App'}).id;
  run('binding',{regionId:r,environmentTypeId:e,configNameId:n,enabled:true});
  const data={regionId:r,environmentTypeId:e,configNameId:n,jsonContent:'{"a":1}',fieldDescriptions:{'/a':'field'},itemMetadata:{'/a':true},description:'overall',tags:['x'],note:'first',requestId:'req-1'};
  return {ws,db,run,data};
}
test('manual save snapshots content, descriptions, author and idempotent retry',t=>{
  const {ws,run,data}=fixture(t);const first=run('save',data,undefined,undefined,'writer');
  assert.equal(first.version.versionNumber,1);
  assert.equal(ws.read().versions[0].submittedByUsername,'writer');
  assert.equal(ws.read().versions[0].fieldDescriptions['/a'],'field');
  assert.deepEqual(run('save',data,undefined,undefined,'writer'),first);
  assert.equal(ws.read().versions.length,1);
  assert.throws(()=>run('save',{...data,jsonContent:'{"a":2}'},undefined,undefined,'writer'),e=>e.status===409);
});
test('existing triple requires explicit id and revision; old write commands fail',t=>{
  const {ws,run,data}=fixture(t);const first=run('save',data);
  assert.throws(()=>run('save',{...data,requestId:'req-2'}),e=>e.status===409);
  assert.throws(()=>run('save',{...data,requestId:'req-2'},first.configId,-1),e=>e.status===409);
  const next=run('save',{...data,jsonContent:'{"a":2}',requestId:'req-2'},first.configId,ws.read().configs[0].revision);
  assert.equal(next.version.versionNumber,2);
  assert.equal(ws.tick(),0);
  assert.equal(ws.read().versions.length,2);
  for(const type of ['create','draft','submit','restore','replace','metadata']) assert.throws(()=>run(type,{},first.configId),e=>e.status===400);
});
test('dictionary is admin-only and disabled bindings prevent writes',t=>{
  const {run,data}=fixture(t);
  assert.throws(()=>run('dictionary',{kind:'regions',code:'eu',label:'Europe'},undefined,undefined,'writer'),e=>e.status===403);
  assert.throws(()=>run('save',data,undefined,undefined,'reader'),e=>e.status===403);
  run('binding',{regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:data.configNameId,enabled:false,expectedRevision:0});
  assert.throws(()=>run('save',data),e=>e.status===409);
});
test('schema one state is retained as unmapped legacy',t=>{
  const {db,ws}=fixture(t);db.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify({schemaVersion:1,revision:5,projects:[],environments:[],configs:[],versions:[],drafts:[],recoveryDrafts:[],settings:{theme:'dark'}}));
  const state=ws.read();assert.equal(state.schemaVersion,4);assert.equal(state.legacy.length,0);assert.equal(state.configs.length,0);
});
test('v1 import keeps individual histories unmapped, then maps IDs and recovery drafts',t=>{
  const {ws,run,data}=fixture(t),old=legacyWorkspace({project:'old-project',environment:'old-env',name:'old-name',description:'whole'});
  const oldId=old.configs[0].id;
  old.drafts[0].rawInput='{broken';old.drafts[0].validationState='invalid';
  const oldVersion=old.versions[0];oldVersion.submittedByUsername='historical';
  const backup=exportBackup(old);const imported=run('import',{backup});assert.equal(imported.legacy,1);
  const pending=ws.read().legacy[0];assert.equal(pending.projectName,'old-project');assert.equal(pending.sourceConfigId,oldId);
  const mapped=run('mapLegacy',{legacyId:pending.id,regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:data.configNameId});
  assert.equal(mapped.configId,oldId);assert.equal(ws.read().legacy.length,0);
  assert.equal(ws.read().versions[0].id,oldVersion.id);assert.equal(ws.read().versions[0].submittedByUsername,'historical');assert.equal(ws.read().versions[0].provenance,'imported');
  assert.equal(ws.read().recoveryDrafts[0].rawInput,'{broken');
  const recoveryId=ws.read().recoveryDrafts[0].id;run('discardRecovery',{},recoveryId,undefined,'writer');assert.equal(ws.read().recoveryDrafts.length,0);
});
test('schema3 import rejects tampered history and strips extra credentials',t=>{
  const {ws,run,data}=fixture(t);run('save',data);
  const pkg=ws.export({id:'admin',username:'admin'});
  const tampered=structuredClone(pkg);tampered.versions[0].jsonContent='{"a":9}';delete tampered.digest;tampered.digest=createHash('sha256').update(JSON.stringify(tampered)).digest('hex');
  assert.throws(()=>run('import',{backup:tampered}),e=>e.status===400);
  const clean=structuredClone(pkg);clean.configs[0].passwordHash='secret';clean.versions[0].sessionToken='secret';
  delete clean.digest;clean.digest=createHash('sha256').update(JSON.stringify(clean)).digest('hex');
  assert.deepEqual(run('import',{backup:clean,skipConflicts:true}),{imported:0,skipped:1});
  assert.ok(!JSON.stringify(ws.read()).includes('secret'));
});

test('v2 historical backups import and map without the retired browser runtime',t=>{
  const {ws,run,data}=fixture(t),old=legacyWorkspace();
  const backup=exportBackup(old,2);
  assert.equal(run('import',{backup}).legacy,1);
  const pending=ws.read().legacy[0];
  run('mapLegacy',{legacyId:pending.id,regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:data.configNameId});
  assert.equal(ws.read().legacy.length,0);
  assert.equal(ws.read().configs[0].id,old.configs[0].id);
  assert.equal(ws.read().versions[0].id,old.versions[0].id);
});
test('copy creates an independent config with source provenance',t=>{
  const {ws,run,data}=fixture(t);const source=run('save',data);
  const other=run('dictionary',{kind:'regions',code:'eu',label:'Europe'}).id;
  run('binding',{regionId:other,environmentTypeId:data.environmentTypeId,configNameId:data.configNameId,enabled:true});
  const copied=run('save',{...data,regionId:other,sourceConfigId:source.configId,requestId:'copy-1'});
  assert.notEqual(copied.configId,source.configId);assert.equal(ws.read().configs[1].sourceConfigId,source.configId);
  assert.throws(()=>run('save',{...data,regionId:other,sourceConfigId:'missing',requestId:'copy-2'}),e=>e.status===400||e.status===409);
});
test('schema3 package imports atomically with historical author marked unverified',t=>{
  const {ws,run,data}=fixture(t);run('save',data);const pkg=ws.export({id:'admin',username:'admin'});
  const db=openDatabase(':memory:');t.after(()=>db.close());
  for(const [id,role] of [['admin','admin'],['writer','operate']])db.prepare('INSERT INTO users VALUES (?,?,?,?,1,0,?)').run(id,id,'unused',role,'2026-09-21T00:00:00Z');
  const other=new Workspace(db);assert.throws(()=>other.execute({id:'writer'},{type:'import',data:{backup:pkg}}),e=>e.status===403);
  assert.equal(other.read().configs.length,0);
  const imported=other.execute({id:'admin'},{type:'import',data:{backup:pkg}}).result;assert.equal(imported.imported,1);
  assert.equal(other.read().versions[0].submittedByUsername,'admin');assert.equal(other.read().versions[0].provenance,'imported');
  assert.equal(other.read().versions[0].submittedByUserId,null);
});
test('import copyMappings remaps config and version IDs to an admin-defined target',t=>{
  const {ws,run,data}=fixture(t);const first=run('save',data);const pkg=ws.export({id:'admin',username:'admin'});
  const newName=run('dictionary',{kind:'configNames',code:'copy',label:'Copy'}).id;
  run('binding',{regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:newName,enabled:true});
  const imported=run('import',{backup:pkg,copyMappings:[{configId:first.configId,regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:newName}]});
  assert.equal(imported.imported,1);const copy=ws.read().configs.find(c=>c.configNameId===newName);
  assert.notEqual(copy.id,first.configId);assert.equal(copy.sourceConfigId,first.configId);
  const version=ws.read().versions.find(v=>v.configSetId===copy.id);assert.notEqual(version.id,first.version.id);assert.equal(copy.latestVersionId,version.id);
});
test('version export carries recovery records and import validates their references',t=>{
  const {ws,db,run,data}=fixture(t);const saved=run('save',data);
  const state=ws.read();state.recoveryDrafts.push({id:'recovery-a',configSetId:saved.configId,legacyId:'old-a',reason:'invalid draft',rawInput:'{broken',inputFormat:'json',createdAt:'2026-09-21T08:00:00Z',provenance:'imported'});db.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(state));
  const pkg=ws.export({id:'admin',username:'admin'});assert.equal(pkg.counts.recoveryDrafts,1);assert.equal(pkg.recoveryDrafts[0].rawInput,'{broken');
  const bad=structuredClone(pkg);bad.recoveryDrafts[0].configSetId='missing';delete bad.digest;bad.digest=createHash('sha256').update(JSON.stringify(bad)).digest('hex');
  assert.throws(()=>run('import',{backup:bad}),e=>e.status===400);
  assert.deepEqual(run('import',{backup:pkg,skipConflicts:true}),{imported:0,skipped:1});assert.equal(ws.read().recoveryDrafts.length,1);
  const newName=run('dictionary',{kind:'configNames',code:'recovery-copy',label:'Recovery copy'}).id;run('binding',{regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:newName,enabled:true});
  run('import',{backup:pkg,copyMappings:[{configId:saved.configId,regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:newName}]});
  const copied=ws.read().configs.find(c=>c.configNameId===newName),recovered=ws.read().recoveryDrafts.find(r=>r.configSetId===copied.id);assert.ok(recovered);assert.notEqual(recovered.id,'recovery-a');
});
test('legacy export round trips pending rows and strips injected credentials',t=>{
  const {ws,run}=fixture(t),old=legacyWorkspace();
  run('import',{backup:exportBackup(old)});const pkg=ws.legacyExport({id:'admin',username:'admin'});assert.equal(pkg.counts.legacy,1);
  pkg.legacy[0].versions[0].passwordHash='secret';pkg.legacy[0].drafts[0].token='secret';delete pkg.digest;pkg.digest=createHash('sha256').update(JSON.stringify(pkg)).digest('hex');
  const db=openDatabase(':memory:');t.after(()=>db.close());db.prepare('INSERT INTO users VALUES (?,?,?,?,1,0,?)').run('admin','admin','unused','admin','2026-09-21T00:00:00Z');const target=new Workspace(db);
  const imported=target.execute({id:'admin'},{type:'import',data:{backup:pkg}}).result;assert.equal(imported.legacy,1);assert.equal(target.read().legacy.length,1);assert.ok(!JSON.stringify(target.read()).includes('secret'));
  assert.throws(()=>target.execute({id:'admin'},{type:'import',data:{backup:pkg}}),e=>e.status===409);
});
test('legacy export import rejects tampered version content, hash, and recovery associations',t=>{
  const {ws,run}=fixture(t),old=legacyWorkspace();
  old.drafts[0].rawInput='{broken';old.drafts[0].validationState='invalid';
  run('import',{backup:exportBackup(old)});const pkg=ws.legacyExport({id:'admin',username:'admin'});
  const db=openDatabase(':memory:');t.after(()=>db.close());db.prepare('INSERT INTO users VALUES (?,?,?,?,1,0,?)').run('admin','admin','unused','admin','2026-09-21T00:00:00Z');const target=new Workspace(db);
  const changed=edit=>{const copy=structuredClone(pkg);edit(copy.legacy[0]);delete copy.digest;copy.digest=createHash('sha256').update(JSON.stringify(copy)).digest('hex');return copy;};
  for(const mutation of [
    row=>{row.versions[0].normalizedContent.a=999;},
    row=>{row.versions[0].rawInput='{"a":999}';},
    row=>{row.versions[0].restoredFromVersionId='missing-version';},
    row=>{row.latestVersionId='missing-version';},
    row=>{row.nextVersionNumber=1;},
    row=>{row.drafts[0].baseVersionId='missing-version';},
  ])assert.throws(()=>target.execute({id:'admin'},{type:'import',data:{backup:changed(mutation)}}),e=>e.status===400);
  assert.equal(target.read().legacy.length,0);
  assert.equal(target.execute({id:'admin'},{type:'import',data:{backup:pkg}}).result.legacy,1);
  assert.equal(target.read().legacy[0].drafts[0].rawInput,'{broken');
});
test('mapLegacy rejects tampered stored history without changing workspace state',t=>{
  const {ws,db,run,data}=fixture(t),old=legacyWorkspace();
  run('import',{backup:exportBackup(old)});const stored=ws.read();stored.legacy[0].versions[0].normalizedContent.a=999;
  db.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(stored));
  assert.throws(()=>run('mapLegacy',{legacyId:stored.legacy[0].id,regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:data.configNameId}),e=>e.status===400);
  assert.deepEqual(ws.read(),stored);
});
test('schema3 import rejects self and future restore links but accepts an earlier version',t=>{
  const {ws,run,data}=fixture(t);const first=run('save',data);const second=run('save',{...data,jsonContent:'{"a":2}',requestId:'restore-link-2'},first.configId,ws.read().configs[0].revision);
  const valid=ws.export({id:'admin',username:'admin'}),older=valid.versions.find(v=>v.id===first.version.id),newer=valid.versions.find(v=>v.id===second.version.id);
  newer.restoredFromVersionId=older.id;delete valid.digest;valid.digest=createHash('sha256').update(JSON.stringify(valid)).digest('hex');
  const db=openDatabase(':memory:');t.after(()=>db.close());db.prepare('INSERT INTO users VALUES (?,?,?,?,1,0,?)').run('admin','admin','unused','admin','2026-09-21T00:00:00Z');const target=new Workspace(db);
  const corrupted=edit=>{const copy=structuredClone(valid);edit(copy);delete copy.digest;copy.digest=createHash('sha256').update(JSON.stringify(copy)).digest('hex');return copy;};
  for(const bad of [
    corrupted(pkg=>{pkg.versions.find(v=>v.id===older.id).restoredFromVersionId=older.id;}),
    corrupted(pkg=>{pkg.versions.find(v=>v.id===older.id).restoredFromVersionId=newer.id;}),
  ]){assert.throws(()=>target.execute({id:'admin'},{type:'import',data:{backup:bad}}),e=>e.status===400);assert.equal(target.read().configs.length,0);}
  assert.equal(target.execute({id:'admin'},{type:'import',data:{backup:valid}}).result.imported,1);
  assert.equal(target.read().versions.find(v=>v.id===newer.id).restoredFromVersionId,older.id);
});
test('schema3 binding IDs are valid and unique within packages and existing workspace',t=>{
  const {ws,run,data}=fixture(t);run('save',data);
  const otherRegion=run('dictionary',{kind:'regions',code:'west',label:'West'}).id;
  run('binding',{regionId:otherRegion,environmentTypeId:data.environmentTypeId,configNameId:data.configNameId,enabled:true});
  run('save',{...data,regionId:otherRegion,requestId:'second-binding'});
  const pkg=ws.export({id:'admin',username:'admin'});assert.equal(pkg.bindings.length,2);
  const changed=edit=>{const copy=structuredClone(pkg);edit(copy);delete copy.digest;copy.digest=createHash('sha256').update(JSON.stringify(copy)).digest('hex');return copy;};
  const db=openDatabase(':memory:');t.after(()=>db.close());db.prepare('INSERT INTO users VALUES (?,?,?,?,1,0,?)').run('admin','admin','unused','admin','2026-09-21T00:00:00Z');const target=new Workspace(db);
  for(const bad of [
    changed(p=>{delete p.bindings[0].id;}),
    changed(p=>{p.bindings[0].id='  ';}),
    changed(p=>{p.bindings[1].id=p.bindings[0].id;}),
  ]){const before=target.read();assert.throws(()=>target.execute({id:'admin'},{type:'import',data:{backup:bad}}),e=>e.status===400);assert.deepEqual(target.read(),before);}
  const current=target.read();current.dictionaries=structuredClone(pkg.dictionaries);current.bindings=[{...pkg.bindings[1],id:pkg.bindings[0].id}];db.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(current));
  assert.throws(()=>target.execute({id:'admin'},{type:'import',data:{backup:pkg}}),e=>e.status===409);assert.deepEqual(target.read(),current);
  current.bindings=[];db.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(current));
  assert.equal(target.execute({id:'admin'},{type:'import',data:{backup:pkg}}).result.imported,2);assert.equal(new Set(target.read().bindings.map(b=>b.id)).size,2);
});
test('archived config and disabled dictionary package restores as history',t=>{
  const {ws,run,data}=fixture(t);const saved=run('save',data);run('archive',{},saved.configId,ws.read().configs[0].revision);
  const region=ws.read().dictionaries.regions[0];run('dictionary',{kind:'regions',id:region.id,enabled:false,expectedRevision:region.revision});
  run('binding',{regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:data.configNameId,enabled:false,expectedRevision:0});const pkg=ws.export({id:'admin',username:'admin'});
  const db=openDatabase(':memory:');t.after(()=>db.close());db.prepare('INSERT INTO users VALUES (?,?,?,?,1,0,?)').run('admin','admin','unused','admin','2026-09-21T00:00:00Z');const target=new Workspace(db);
  assert.equal(target.execute({id:'admin'},{type:'import',data:{backup:pkg}}).result.imported,1);assert.ok(target.read().configs[0].archivedAt);
});
