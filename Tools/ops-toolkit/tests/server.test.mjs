import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../server/http.js';
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
  const created=await request('/api/commands','POST',{type:'create',data:{project:'P',environment:'dev',name:'C',type:'json',draft:{rawInput:'{}',inputFormat:'json'}}},writer);
  assert.equal(created.status,200);
  const result=await request('/api/workspace','GET',null,reader);assert.equal(result.status,200);
  assert.equal(result.body.versions[0].submittedByUsername,'writer');assert.ok(!JSON.stringify(result.body).includes('passwordHash'));
  assert.equal((await request('/api/commands','POST',{type:'delete',id:created.body.result,expectedRevision:0,data:{}},writer)).status,409);
  assert.equal((await request('/api/backup','GET',null,writer)).body.schemaVersion,2);
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
