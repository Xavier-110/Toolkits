import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../server/database.js';
import {Auth} from '../server/auth.js';
import {Workspace} from '../server/workspace.js';
import {encodeArchive,decodeArchive} from '../src/archive.js';
test('tags preserve snapshots, protect cleanup and round trip archives',async()=>{
  const db=openDatabase(':memory:');try{
    const auth=new Auth(db);await auth.bootstrap('admin','Initial-Password-123');const login=await auth.login('admin','Initial-Password-123');await auth.changePassword(login.token,'Initial-Password-123','Changed-Password-456');const actor=(await auth.login('admin','Changed-Password-456')).user;
    const ws=new Workspace(db),run=(type,data,extra={})=>ws.execute(actor,{type,data,...extra}).result;
    const ids={};for(const [kind,key]of [['regions','regionId'],['environmentTypes','environmentTypeId'],['configNames','configNameId']])ids[key]=run('dictionary',{kind,code:kind,label:kind}).id;
    run('binding',{...ids,enabled:true});const payload=value=>({...ids,jsonContent:JSON.stringify({value}),fieldDescriptions:{},itemMetadata:{},description:'',tags:[],note:'',requestId:randomUUID()});
    const first=run('save',payload('one')),original=JSON.stringify(first.version);
    const old=ws.read();old.schemaVersion=3;delete old.versionTags;const raw=JSON.stringify(old);db.prepare('UPDATE workspace SET data=? WHERE id=1').run(raw);
    assert.equal(ws.read().schemaVersion,4);assert.deepEqual(ws.read().versionTags,[]);assert.equal(db.prepare('SELECT data FROM workspace WHERE id=1').get().data,raw);assert.equal(ws.export(actor).versions[0].snapshotHash,first.version.snapshotHash);
    const tag=run('versionTag',{configSetId:first.configId,versionId:first.version.id,name:'release-1'});
    assert.equal(JSON.parse(db.prepare('SELECT data FROM workspace WHERE id=1').get().data).schemaVersion,4);
    assert.equal(JSON.stringify(ws.read().versions[0]),original);assert.equal(ws.read().versions.length,1);
    assert.throws(()=>run('versionTag',{configSetId:first.configId,versionId:first.version.id,name:'RELEASE-1'}),/已存在/);
    run('save',payload('two'),{id:first.configId,expectedRevision:1});
    assert.throws(()=>run('clean',{versionIds:[first.version.id]},{id:first.configId,expectedRevision:2}),/tag/);
    const archive=ws.export(actor);assert.equal(archive.schemaVersion,4);assert.equal(archive.versionTags[0].id,tag.id);
    const decoded=decodeArchive(encodeArchive(archive,4096).bytes);assert.deepEqual(decoded,archive);
    const targetDb=openDatabase(':memory:');try{targetDb.prepare('INSERT INTO users(id,username,passwordHash,role,enabled,mustChangePassword,createdAt) VALUES(?,?,?,?,?,?,?)').run(...Object.values(auth.db.prepare('SELECT id,username,passwordHash,role,enabled,mustChangePassword,createdAt FROM users WHERE id=?').get(actor.id)));const target=new Workspace(targetDb);target.execute(actor,{type:'import',data:{backup:decoded}});assert.equal(target.read().versionTags[0].versionId,tag.versionId);assert.equal(target.read().versions[0].hash,ws.read().versions[0].hash);}finally{targetDb.close();}
    assert.throws(()=>run('deleteVersionTag',{id:tag.id,expectedRevision:99}),/修改|变化/);
    run('deleteVersionTag',{id:tag.id,expectedRevision:tag.revision});assert.equal(ws.read().versionTags.length,0);
    run('clean',{versionIds:[first.version.id]},{id:first.configId,expectedRevision:2});assert.equal(ws.read().versions.length,1);
  }finally{db.close();}
});
