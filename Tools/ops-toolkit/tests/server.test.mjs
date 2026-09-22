import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../server/http.js';
import { encodeArchive, decodeArchive } from '../src/archive.js';
const initial='Initial-Password-123', changed='Changed-Password-456';
async function fixture(t) {
  const service=createService({dbPath:':memory:'});await service.auth.bootstrap('admin',initial);
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>service.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  async function request(path,method='GET',data,session={},extra={}) {
    const res=await fetch(base+path,{method,headers:{Origin:base,...(data?{'Content-Type':'application/json'}:{}),...(session.cookie?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra},body:data?JSON.stringify(data):undefined});
    return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')};
  }
  async function login(username,password) {const r=await request('/api/login','POST',{username,password});return {...r,...r.body,cookie:r.cookie?.split(';')[0]};}
  const first=await login('admin',initial);await request('/api/password','POST',{oldPassword:initial,password:changed},first);
  return {service,base,request,login,admin:await login('admin',changed)};
}
test('authentication, password rotation, cookie flags and CSRF boundary',async t=>{
  const {request,admin,login}=await fixture(t);
  assert.equal((await request('/api/workspace')).status,401);
  assert.equal((await request('/api/workspace','GET',null,admin)).status,200);
  const raw=await request('/api/login','POST',{username:'admin',password:changed});
  assert.match(raw.cookie,/HttpOnly/);assert.match(raw.cookie,/SameSite=Strict/);
  assert.ok(!JSON.stringify(raw.body).includes('token'));
  assert.equal((await request('/api/commands','POST',{type:'settings',data:{}},admin,{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await request('/api/commands','POST',{type:'settings',data:{}},admin,{Origin:'https://evil.example'})).status,403);
  await request('/api/users','POST',{username:'alice',password:initial,role:'operate'},admin);
  const alice=await login('alice',initial);
  assert.equal((await request('/api/workspace','GET',null,alice)).status,403);
  assert.equal((await request('/api/password','POST',{oldPassword:initial,password:changed},alice)).status,200);
  assert.equal((await request('/api/me','GET',null,alice)).status,401);
});

test('HTTP delete previews and commands accept early schema3 without recoveryDrafts',async t=>{
  const {service,request,admin}=await fixture(t);
  const command=async(type,data)=>request('/api/commands','POST',{type,data},admin);
  const regionId=(await command('dictionary',{kind:'regions',code:'cn',label:'China'})).body.result.id;
  const environmentTypeId=(await command('dictionary',{kind:'environmentTypes',code:'prod',label:'Production'})).body.result.id;
  const configNameId=(await command('dictionary',{kind:'configNames',code:'app',label:'App'})).body.result.id;
  await command('bindings',{regionId,environmentTypeId,configNameIds:[configNameId]});
  const state=service.workspace.read();delete state.recoveryDrafts;
  service.workspace.db.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(state));
  const loaded=await request('/api/workspace','GET',null,admin);assert.equal(loaded.status,200);assert.deepEqual(loaded.body.recoveryDrafts,[]);
  for(const target of [{targetType:'binding',id:state.bindings[0].id},{targetType:'dictionary',kind:'regions',id:regionId}]){
    const preview=await request('/api/environment-delete-preview?'+new URLSearchParams(target),'GET',null,admin);
    assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.counts.recoveryDrafts,0);
  }
  const preview=(await request('/api/environment-delete-preview?'+new URLSearchParams({targetType:'dictionary',kind:'regions',id:regionId}),'GET',null,admin)).body;
  const removed=await command('deleteEnvironment',{targetType:'dictionary',kind:'regions',id:regionId,expectedRevision:preview.targetRevision,expectedWorkspaceRevision:preview.workspaceRevision,deleteConfigs:true});
  assert.equal(removed.status,200,JSON.stringify(removed.body));assert.deepEqual(removed.body.state.recoveryDrafts,[]);assert.equal(removed.body.state.bindings.length,0);
});
test('HTTP role matrix protects users, commands, exports and serialized state',async t=>{
  const {request,admin,login}=await fixture(t);
  for(const [username,role] of [['writer','operate'],['reader','readonly']]) {
    await request('/api/users','POST',{username,password:initial,role},admin);
    const first=await login(username,initial);await request('/api/password','POST',{oldPassword:initial,password:changed},first);
  }
  const writer=await login('writer',changed),reader=await login('reader',changed);
  for(const s of [writer,reader])assert.equal((await request('/api/users','GET',null,s)).status,403);
  assert.equal((await request('/api/commands','POST',{type:'settings',data:{}},reader)).status,403);
  assert.equal((await request('/api/backup','GET',null,reader)).status,403);
  const old=await request('/api/commands','POST',{type:'create',data:{project:'P',environment:'dev',name:'C',type:'json',draft:{rawInput:'{}',inputFormat:'json'}}},writer);
  assert.equal(old.status,400);
  const r=(await request('/api/commands','POST',{type:'dictionary',data:{kind:'regions',code:'cn',label:'China'}},admin)).body.result.id;
  const e=(await request('/api/commands','POST',{type:'dictionary',data:{kind:'environmentTypes',code:'prod',label:'Production'}},admin)).body.result.id;
  const n=(await request('/api/commands','POST',{type:'dictionary',data:{kind:'configNames',code:'app',label:'App'}},admin)).body.result.id;
  await request('/api/commands','POST',{type:'binding',data:{regionId:r,environmentTypeId:e,configNameId:n,enabled:true}},admin);
  const created=await request('/api/commands','POST',{type:'save',data:{regionId:r,environmentTypeId:e,configNameId:n,jsonContent:'{}',fieldDescriptions:{},itemMetadata:{},description:'',tags:[],note:'',requestId:'http-1'}},writer);
  assert.equal(created.status,200);
  const result=await request('/api/workspace','GET',null,reader);assert.equal(result.status,200);
  assert.equal(result.body.versions[0].submittedByUsername,'writer');assert.ok(!JSON.stringify(result.body).includes('passwordHash'));
  assert.equal((await request('/api/commands','POST',{type:'delete',id:created.body.result.configId,expectedRevision:0,data:{}},writer)).status,409);
  assert.equal((await request('/api/backup','GET',null,writer)).body.schemaVersion,3);
  assert.equal((await request('/api/export?kind=configs&regionId='+r,'GET',null,writer)).body.counts.configs,1);
  const previewPath='/api/environment-delete-preview?targetType=dictionary&kind=regions&id='+r;
  assert.equal((await request(previewPath)).status,401);
  for(const session of [writer,reader]){
    assert.equal((await request(previewPath,'GET',null,session)).status,403);
    assert.equal((await request('/api/commands','POST',{type:'bindings',data:{regionId:r,environmentTypeId:e,configNameIds:[n]}},session)).status,403);
    assert.equal((await request('/api/commands','POST',{type:'deleteEnvironment',data:{targetType:'dictionary',kind:'regions',id:r,deleteConfigs:true}},session)).status,403);
  }
  const preview=(await request(previewPath,'GET',null,admin)).body;
  assert.equal(preview.counts.configs,1);assert.equal(preview.counts.versions,1);
  const deletion={type:'deleteEnvironment',data:{targetType:'dictionary',kind:'regions',id:r,deleteConfigs:false,expectedRevision:preview.targetRevision,expectedWorkspaceRevision:preview.workspaceRevision}};
  assert.equal((await request('/api/commands','POST',deletion,admin,{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await request('/api/commands','POST',deletion,admin)).status,200);
  assert.equal((await request('/api/workspace','GET',null,reader)).body.configs.length,1);
  assert.equal((await request('/api/export?regionId='+r,'GET',null,writer)).body.dictionaries.regions[0].enabled,false);
});
test('logout, invalid JSON and login throttling have explicit errors',async t=>{
  const {request,base,admin}=await fixture(t);
  const invalid=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{'});
  assert.equal(invalid.status,400);
  const large=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'x'.repeat(18000)})});
  assert.equal(large.status,413);
  await request('/api/logout','POST',{},admin);
  assert.equal((await request('/api/me','GET',null,admin)).status,401);
  for(let i=0;i<10;i++)await request('/api/login','POST',{username:'missing',password:initial});
  assert.equal((await request('/api/login','POST',{username:'missing',password:initial})).status,429);
});
test('revoking the initiating session during password hashing prevents user creation',async t=>{
  const {service,request,admin}=await fixture(t);
  let entered;const hashing=new Promise(resolve=>entered=resolve);
  const prepare=service.auth.prepareUser.bind(service.auth);
  service.auth.prepareUser=(data)=>{const result=prepare(data);entered();return result;};
  const pending=request('/api/users','POST',{username:'race-user',password:initial,role:'operate'},admin);
  await hashing;assert.equal((await request('/api/logout','POST',{},admin)).status,200);
  assert.equal((await pending).status,401);
  assert.ok(!service.auth.list(admin.user.id).some(user=>user.username==='race-user'));
});
test('archive upload authenticates JSON and rejects corruption before mutation',async t=>{
  const {service,request,base,admin}=await fixture(t);
  const pkg=service.workspace.export(admin.user);
  const encoded=encodeArchive(pkg);
  const submit=async(bytes,type,csrf=admin.csrf)=>{const res=await fetch(base+'/api/import-archive?skipConflicts=true',{method:'POST',headers:{Origin:base,Cookie:admin.cookie,'X-CSRF-Token':csrf,'Content-Type':type},body:bytes});return {status:res.status,body:await res.json()};};
  assert.equal((await submit(encoded.bytes,encoded.type,'bad')).status,403);
  assert.equal((await submit(encoded.bytes,encoded.type)).status,200);
  const broken=encoded.bytes.slice();broken[broken.length-30]^=1;
  assert.equal((await submit(broken,encoded.type)).status,400);
  assert.equal(service.workspace.read().configs.length,0);
  assert.equal((await request('/api/legacy-export','GET',null,admin)).body.legacy.length,0);
});
test('archive HTTP route accepts a valid package larger than 20 MiB',async t=>{
  const {service,base,admin}=await fixture(t),actor=admin.user;
  const ws=service.workspace;
  const ids={};for(const [kind,code] of [['regions','r'],['environmentTypes','e'],['configNames','n']])ids[kind]=ws.execute(actor,{type:'dictionary',data:{kind,code,label:code}}).result.id;
  const identity={regionId:ids.regions,environmentTypeId:ids.environmentTypes,configNameId:ids.configNames};
  ws.execute(actor,{type:'binding',data:{...identity,enabled:true}});
  let configId,revision;for(let i=0;i<22;i++){const result=ws.execute(actor,{type:'save',...(configId?{id:configId,expectedRevision:revision}:{}),data:{...identity,jsonContent:JSON.stringify({value:'x'.repeat(970000),index:i}),fieldDescriptions:{},itemMetadata:{},description:'',tags:[],note:'',requestId:`large-${i}`}}).result;configId=result.configId;revision=ws.read().configs[0].revision;}
  const pkg=ws.export(actor),archive=encodeArchive(pkg);
  assert.equal(archive.type,'application/zip');assert.ok(archive.bytes.length>20*1024*1024);
  assert.equal(decodeArchive(archive.bytes).versions.length,22);
  const res=await fetch(base+'/api/import-archive?skipConflicts=true',{method:'POST',headers:{Origin:base,Cookie:admin.cookie,'X-CSRF-Token':admin.csrf,'Content-Type':archive.type},body:archive.bytes});
  const response=await res.json();assert.equal(res.status,200,JSON.stringify(response));assert.equal(response.result.skipped,1);
});
