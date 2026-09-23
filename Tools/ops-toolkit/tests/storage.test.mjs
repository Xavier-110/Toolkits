import test from 'node:test';
import assert from 'node:assert/strict';
test('storage contract commits and rolls back a whole account/workspace change',async()=>{
  const {openStore}=await import('../server/storage.js');const store=await openStore({type:'sqlite',filename:':memory:'});
  try{
    const user={id:'one',username:'Admin',passwordHash:'test-hash',role:'admin',enabled:1,mustChangePassword:0,createdAt:'2026-09-22T00:00:00Z'};
    await store.transaction(async tx=>{await tx.insertUser(user);const s=await tx.getWorkspace();s.settings.expiryWarningDays=42;await tx.setWorkspace(s);});
    assert.equal((await store.findUser('admin')).username,'Admin');assert.equal((await store.getWorkspace()).settings.expiryWarningDays,42);
    await assert.rejects(store.transaction(async tx=>{await tx.updateUser('one',{enabled:0});await tx.setWorkspace({bad:true});throw Error('rollback');}),/rollback/);
    assert.equal((await store.getUser('one')).enabled,1);assert.equal((await store.getWorkspace()).settings.expiryWarningDays,42);
    const snapshot=await store.snapshot();assert.equal(snapshot.users.length,1);assert.ok(!Object.hasOwn(snapshot,'sessions'));
  }finally{await store.close();}
});
test('async authentication and workspace use committed state and revoke sessions',async()=>{
  const {openStore}=await import('../server/storage.js');const {AsyncAuth,AsyncWorkspace}=await import('../server/async-services.js');
  const store=await openStore({type:'sqlite',filename:':memory:'});try{
    const auth=new AsyncAuth(store),ws=new AsyncWorkspace(store);await auth.bootstrap('admin','Initial-Password-123');const initial=await auth.login('admin','Initial-Password-123');
    await auth.changePassword(initial.token,'Initial-Password-123','Changed-Password-456');await assert.rejects(auth.session(initial.token));const session=await auth.login('admin','Changed-Password-456');
    await ws.execute(session.user,{type:'dictionary',data:{kind:'regions',code:'cn',label:'China'}});assert.equal((await ws.read()).dictionaries.regions.length,1);
    await assert.rejects(ws.execute(session.user,{type:'dictionary',data:{kind:'regions',code:'cn',label:'Duplicate'}}));assert.equal((await ws.read()).dictionaries.regions.length,1);
    await auth.createUser(session.user.id,{username:'reader',password:'Reader-Password-123',role:'readonly'});assert.equal((await auth.list(session.user.id)).length,2);
    await assert.rejects(auth.updateUser(session.user.id,session.user.id,{enabled:false}),/最后一个管理员/);
    const readerFirst=await auth.login('reader','Reader-Password-123');await assert.rejects(auth.requireUser(readerFirst.user.id),/修改密码/);await auth.changePassword(readerFirst.token,'Reader-Password-123','Reader-Changed-456');const reader=await auth.login('reader','Reader-Changed-456');
    await assert.rejects(ws.execute(reader.user,{type:'settings',data:{expiryWarningDays:1}}),/权限/);await auth.updateUser(session.user.id,reader.user.id,{enabled:false});await assert.rejects(auth.session(reader.token),/失效/);
    const creating=auth.createUser(session.user.id,{username:'revoked',password:'Reader-Password-123',role:'operate'},fresh=>fresh.session(session.token));await auth.logout(session.token);await assert.rejects(creating,/失效/);assert.equal(await store.findUser('revoked'),undefined);
  }finally{await store.close();}
});
