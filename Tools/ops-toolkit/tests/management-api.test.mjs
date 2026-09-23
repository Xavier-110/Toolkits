import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createService} from '../server/http.js';
import {seed,password} from './online-fixture.mjs';
test('management API enforces roles, masks reports and relogins after migration',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'toolkit-api-')),service=createService({dbPath:join(dir,'source.sqlite'),schedule:false});t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  const data=await seed(service);await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${service.server.address().port}`;
  const request=async(path,method='GET',body,session=data.session)=>{const r=await fetch(base+'/api'+path,{method,headers:{Origin:base,'Content-Type':'application/json',Cookie:'ops_session='+session.token,'X-CSRF-Token':session.csrf},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const pair={leftVersionId:data.configs[0].first.id,rightVersionId:data.configs[1].latest.id};
  for(const role of ['operate','readonly']){const session=await service.auth.login(role,password);for(const [path,method,body]of [['/admin/storage','GET'],['/admin/storage/test','POST',{type:'sqlite'}],['/admin/storage/migrate','POST',{}],['/admin/storage/cancel','POST',{}],['/admin/backups','GET'],['/admin/backups','POST',{}],['/admin/backup-schedule','PATCH',{}]])assert.equal((await request(path,method,body,session)).status,403,path);assert.deepEqual((await request('/storage-summary','GET',undefined,session)).body,{type:'sqlite',status:'ready',revision:0});assert.equal((await request('/compare','POST',pair,session)).status,200);assert.equal((await request('/compare-report','POST',pair,session)).status,role==='readonly'?403:200);}
  const report=await request('/compare-report','POST',pair);assert.equal(report.status,200);assert.equal(report.body.counts.content,2);assert.ok(!JSON.stringify(report).includes('secret-'));assert.equal(report.body.generatedBy,'admin');
  assert.equal((await request('/admin/backup-schedule','PATCH',{enabled:true,time:'02:00',retain:2})).status,200);const backup=await request('/admin/backups','POST',{});assert.equal(backup.status,200);const file=await request('/admin/backups/'+backup.body.id+'/download');assert.equal(file.status,200);assert.equal(file.body.snapshot.users.length,3);assert.equal(file.body.snapshot.sessions,undefined);
  assert.equal((await request('/admin/storage/migrate','POST',{connection:{type:'sqlite'},requestId:'http-switch',expectedRevision:0})).status,200);assert.equal((await request('/me')).status,401);
  const next=await service.auth.login('admin',password);assert.equal((await request('/workspace','GET',undefined,next)).body.versions.length,4);
});
