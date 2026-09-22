import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/database.js';
import { Auth } from '../server/auth.js';
import { Workspace } from '../server/workspace.js';

test('SQLite reopen retains users, configuration snapshots and authors',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'ops-persistence-')),filename=path.join(dir,'test.sqlite');let db=openDatabase(filename);
  try{
    const auth=new Auth(db),user=await auth.bootstrap('admin','Initial-Password-123'),ws=new Workspace(db),run=(type,data)=>ws.execute(user,{type,data}).result;
    const first=await auth.login('admin','Initial-Password-123');await auth.changePassword(first.token,'Initial-Password-123','Changed-Password-456');
    const r=run('dictionary',{kind:'regions',code:'r',label:'Region'}).id,e=run('dictionary',{kind:'environmentTypes',code:'dev',label:'Development'}).id,n=run('dictionary',{kind:'configNames',code:'app',label:'App'}).id;
    const identity={regionId:r,environmentTypeId:e,configNameId:n};run('binding',{...identity,enabled:true});
    const result=run('save',{...identity,jsonContent:'{"name":"persisted"}',fieldDescriptions:{'/name':'name'},itemMetadata:{},description:'test',tags:[],note:'first',requestId:'persist-1'}),snapshot=ws.read();
    db.close();db=openDatabase(filename);const reopened=new Workspace(db).read();assert.deepEqual(reopened,snapshot);assert.equal(reopened.versions[0].submittedByUsername,'admin');assert.equal(reopened.configs[0].latestVersionId,result.version.id);
    const session=await new Auth(db).login('admin','Changed-Password-456');assert.equal(session.user.id,user.id);
  }finally{db.close();if(!path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep))throw Error('Unsafe cleanup path');rmSync(dir,{recursive:true,force:true});}
});
