import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {StorageManager} from '../server/storage-manager.js';
import {openStore} from '../server/storage.js';
import {BackupManager,restoreSystemBackup,validateSystemBackup} from '../server/backups.js';
async function administrator(manager){const a=manager.services.auth;await a.bootstrap('admin','Initial-Password-123');const s=await a.login('admin','Initial-Password-123');await a.changePassword(s.token,'Initial-Password-123','Changed-Password-456');return (await a.login('admin','Changed-Password-456')).user;}
test('failed activation can retry; changed source requires cancelling journal without deleting target',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'toolkit-retry-')),manager=StorageManager.local(join(dir,'source.sqlite'));
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});const actor=await administrator(manager);
  const write=manager.secure.write.bind(manager.secure);let failActivation=true;
  manager.secure.write=async data=>{if(!data.pending&&failActivation)throw Error('injected pointer failure');return write(data);};
  await assert.rejects(manager.migrate(actor.id,{connection:{type:'sqlite'},requestId:'retry',expectedRevision:0}),/injected/);
  const target=manager.document.pending.target.filename;assert.equal(manager.document.active.filename,join(dir,'source.sqlite'));
  await manager.services.workspace.execute(actor,{type:'settings',data:{expiryWarningDays:88}});
  await assert.rejects(manager.migrate(actor.id,{connection:{type:'sqlite'},requestId:'retry',expectedRevision:0}),/源数据已变化/);
  failActivation=false;await manager.cancelMigration(actor.id,{requestId:'retry',expectedRevision:0});
  assert.equal(manager.document.pending,undefined);const preserved=await openStore({type:'sqlite',filename:target});assert.equal((await preserved.getWorkspace()).settings.expiryWarningDays,30);await preserved.close();
  await manager.migrate(actor.id,{connection:{type:'sqlite'},requestId:'new-attempt',expectedRevision:1});assert.equal((await manager.store.getWorkspace()).settings.expiryWarningDays,88);
});
test('system restore validates all records and rejects even dictionary-only nonempty targets',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'toolkit-restore-')),manager=StorageManager.local(join(dir,'source.sqlite')),target=await openStore({type:'sqlite',filename:join(dir,'restore.sqlite')});
  t.after(async()=>{await target.close();await manager.close();await rm(dir,{recursive:true,force:true});});await administrator(manager);const backups=new BackupManager(manager);await backups.configure({enabled:true,time:'02:00',retain:2});const created=await backups.create();const pkg=JSON.parse(await backups.download(created.id));
  const resign=p=>{delete p.digest;p.digest=createHash('sha256').update(JSON.stringify(p)).digest('hex');return p;};
  const corrupt=structuredClone(pkg);corrupt.snapshot.workspace.versions.push({id:'orphan',configSetId:'missing'});assert.throws(()=>validateSystemBackup(resign(corrupt)));
  const count=structuredClone(pkg);count.counts.users=100;assert.throws(()=>validateSystemBackup(resign(count)),/数量/);
  const state=await target.getWorkspace();state.dictionaries.regions.push({id:'existing',code:'existing',label:'existing'});await target.setWorkspace(state);
  await assert.rejects(restoreSystemBackup(pkg,target),/非空/);state.dictionaries.regions=[];await target.setWorkspace(state);
  await restoreSystemBackup(pkg,target);assert.equal((await target.getWorkspace()).management.backup.enabled,false);assert.equal((await target.users())[0].passwordHash,pkg.snapshot.users[0].passwordHash);await assert.rejects(restoreSystemBackup(pkg,target),/非空/);
});
test('storage migration preserves source and reopens committed target without sessions',async t=>{
  const {StorageManager,openManagedStorage}=await import('../server/storage-manager.js');
  const dir=await mkdtemp(join(tmpdir(),'toolkit-storage-'));
  let manager=StorageManager.local(join(dir,'source.sqlite'));t.after(async()=>{if(manager)await manager.close();await rm(dir,{recursive:true,force:true});});
  const {auth}=manager.services;await auth.bootstrap('admin','Initial-Password-123');const initial=await auth.login('admin','Initial-Password-123');await auth.changePassword(initial.token,'Initial-Password-123','Changed-Password-456');const session=await auth.login('admin','Changed-Password-456');
  await manager.services.workspace.execute(session.user,{type:'settings',data:{expiryWarningDays:77}});
  const before=await manager.store.snapshot();const response=await manager.migrate(session.user.id,{connection:{type:'sqlite'},requestId:'switch-1',expectedRevision:0});
  assert.equal(response.migrated,true);assert.equal((await manager.services.workspace.read()).settings.expiryWarningDays,77);await assert.rejects(async()=>manager.services.auth.session(session.token));
  const source=await readFile(join(dir,'source.sqlite'));assert.ok(source.length>0);await manager.close();manager=await openManagedStorage(join(dir,'source.sqlite'));
  assert.equal((await manager.services.auth.login('admin','Changed-Password-456')).user.id,session.user.id);assert.equal((await manager.store.snapshot()).users[0].passwordHash,before.users[0].passwordHash);
});
test('scheduled backups retain only successful files and reject corrupt system snapshots',async t=>{
  const {StorageManager}=await import('../server/storage-manager.js');const {BackupManager,validateSystemBackup}=await import('../server/backups.js');
  const dir=await mkdtemp(join(tmpdir(),'toolkit-backups-'));
  const manager=StorageManager.local(join(dir,'source.sqlite'));t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  await manager.services.auth.bootstrap('admin','Initial-Password-123');let clock=Date.parse('2026-09-22T10:00:00Z');const backups=new BackupManager(manager,{clock:()=>clock});
  await backups.configure({enabled:true,time:'00:00',retain:2});
  await backups.tick();await backups.tick();assert.equal((await backups.list()).files.length,1);
  clock+=86400000;await backups.tick();clock+=86400000;await backups.tick();const files=(await backups.list()).files;assert.equal(files.length,2);
  const pkg=JSON.parse((await backups.download(files[0].id)).toString());validateSystemBackup(pkg);assert.equal(pkg.snapshot.users.length,1);assert.ok(!pkg.snapshot.sessions);
  pkg.snapshot.workspace.settings.expiryWarningDays=123;assert.throws(()=>validateSystemBackup(pkg),/摘要/);
});
test('failed backups preserve previous files and concurrent requests share one snapshot',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'toolkit-backup-failure-')),manager=StorageManager.local(join(dir,'source.sqlite'));t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});await administrator(manager);const backups=new BackupManager(manager);await backups.configure({enabled:false,time:'02:00',retain:1});
  const results=await Promise.all([backups.create(),backups.create()]);assert.equal(results[0].id,results[1].id);const first=await backups.download(results[0].id);await writeFile(join(dir,'backups','unrelated.txt'),'keep');
  const snapshot=manager.store.snapshot.bind(manager.store);manager.store.snapshot=async()=>{throw Error('injected snapshot failure');};await assert.rejects(backups.create(),/injected/);assert.deepEqual(await backups.download(results[0].id),first);assert.match((await backups.list()).schedule.lastResult,/失败/);
  manager.store.snapshot=snapshot;await backups.create();assert.equal((await backups.list()).files.length,1);assert.equal(await readFile(join(dir,'backups','unrelated.txt'),'utf8'),'keep');await assert.rejects(backups.download('../unrelated'),/编号/);
});
