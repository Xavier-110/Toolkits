// Opt-in only: creates toolkit tables and data in explicitly disposable empty databases.
// Does not drop tables or remove remote data; use a fresh database/schema each run.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StorageManager,openManagedStorage,snapshotDigest} from '../server/storage-manager.js';
import {seed,password} from './online-fixture.mjs';
if(!process.env.OPS_TEST_DATABASES)throw Error('Set OPS_TEST_DATABASES to an ignored local JSON file containing disposable empty database connections');
const inputs=JSON.parse(await readFile(process.env.OPS_TEST_DATABASES,'utf8'));
if(inputs.disposable!==true||!Array.isArray(inputs.connections)||!inputs.connections.length)throw Error('Require disposable:true and connections[]; never use production credentials');
for(const connection of inputs.connections){
  assert.ok(['mysql','postgres','oracle'].includes(connection.type));const dir=await mkdtemp(join(tmpdir(),'toolkit-remote-'));let manager=StorageManager.local(join(dir,'source.sqlite'));
  try{
    const service={get auth(){return manager.services.auth;},get workspace(){return manager.services.workspace;}},data=await seed(service);
    await data.command('versionTag',{configSetId:data.configs[0].id,versionId:data.configs[0].first.id,name:'baseline'});
    const before=await manager.store.snapshot();await manager.migrate(data.session.user.id,{connection,requestId:'remote-first',expectedRevision:0});assert.equal(snapshotDigest(await manager.store.snapshot()),snapshotDigest(before));
    await assert.rejects(manager.services.auth.session(data.session.token));const session=await manager.services.auth.login('admin',password),reader=await manager.services.auth.login('readonly',password);await assert.rejects(manager.services.workspace.execute(reader.user,{type:'settings',data:{expiryWarningDays:1}}));
    await assert.rejects(manager.store.transaction(async tx=>{await tx.updateUser(session.user.id,{enabled:0});throw Error('rollback-probe');}),/rollback-probe/);assert.equal((await manager.store.getUser(session.user.id)).enabled,1);
    const payload={...data.configs[0].identity,jsonContent:JSON.stringify({EMPTY:'',LARGE:'中文'.repeat(100000)}),fieldDescriptions:{},itemMetadata:{},description:'',tags:[],note:'large text',requestId:'large-save'};await manager.services.workspace.execute(session.user,{type:'save',id:data.configs[0].id,expectedRevision:2,data:payload});const snapshot=await manager.store.snapshot();
    await manager.close();manager=await openManagedStorage(join(dir,'source.sqlite'));assert.equal(snapshotDigest(await manager.store.snapshot()),snapshotDigest(snapshot));assert.equal((await manager.services.auth.login('admin',password)).user.id,session.user.id);
    await assert.rejects(manager.migrate(session.user.id,{connection,requestId:'nonempty-target',expectedRevision:1}),/已有工具箱数据/);assert.equal(snapshotDigest(await manager.store.snapshot()),snapshotDigest(snapshot));
    await manager.migrate(session.user.id,{connection:{type:'sqlite'},requestId:'return-local',expectedRevision:1});assert.equal(snapshotDigest(await manager.store.snapshot()),snapshotDigest(snapshot));console.log(`PASS real ${connection.type}: migration, roles, rollback, restart, nonempty rejection, large text, empty string and return to SQLite`);
  }finally{await manager.close();await rm(dir,{recursive:true,force:true});}
}
