import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/database.js';
import { Auth } from '../server/auth.js';

const initial = 'Initial-Password-123', changed = 'Changed-Password-456';
async function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  let now = Date.now(); const auth = new Auth(db, () => now);
  await auth.bootstrap('admin', initial);
  const first = await auth.login('admin', initial);
  await auth.changePassword(first.token, initial, changed);
  const login = await auth.login('admin', changed);
  return {db, auth, token: login.token, admin: login.user, advance: ms => now += ms};
}
test('bootstrap is one-time, salted password hashing and session token digests', async t => {
  const {db, auth, token} = await fixture(t);
  await assert.rejects(auth.bootstrap('second', initial), /初始化/);
  const raw = db.prepare('SELECT * FROM users').get();
  assert.ok(!JSON.stringify(raw).includes(changed));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM sessions').all()).includes(token));
  assert.equal(auth.session(token).user.role, 'admin');
  assert.equal('passwordHash' in auth.session(token).user, false);
});
test('initial password must change and changing it revokes old sessions', async t => {
  const {auth, admin} = await fixture(t);
  await auth.createUser(admin.id, {username:'alice', password:initial, role:'operate'});
  const a = await auth.login('alice', initial);
  assert.equal(a.user.mustChangePassword, true);
  assert.throws(() => auth.requireUser(a.user.id), /修改密码/);
  await auth.changePassword(a.token, initial, changed);
  assert.throws(() => auth.session(a.token), /登录/);
  assert.equal((await auth.login('alice', changed)).user.mustChangePassword, false);
});
test('user management requires admin and protects last enabled admin', async t => {
  const {auth, admin} = await fixture(t);
  const other = await auth.createUser(admin.id, {username:'reader', password:initial, role:'readonly'});
  await assert.rejects(auth.createUser(other.id, {username:'illegal',password:initial,role:'admin'}));
  await assert.rejects(auth.updateUser(admin.id, admin.id, {enabled:false}), /最后/);
  await assert.rejects(auth.updateUser(admin.id, admin.id, {role:'operate'}), /最后/);
  await assert.rejects(auth.createUser(admin.id, {username:'READER',password:initial,role:'operate'}), /存在/);
  await assert.rejects(auth.createUser(admin.id, {username:'invalid',password:initial,role:'root'}), /角色/);
});
test('role changes, disable and password reset immediately revoke sessions', async t => {
  const {auth, admin} = await fixture(t);
  const u = await auth.createUser(admin.id, {username:'alice',password:initial,role:'operate'});
  let a = await auth.login('alice', initial);
  await auth.changePassword(a.token, initial, changed);
  a = await auth.login('alice', changed);
  await auth.updateUser(admin.id, u.id, {role:'readonly'});
  assert.throws(() => auth.session(a.token));
  a = await auth.login('alice', changed);
  await auth.updateUser(admin.id, u.id, {password:initial});
  assert.throws(() => auth.session(a.token));
  assert.equal((await auth.login('alice', initial)).user.mustChangePassword, true);
  await auth.updateUser(admin.id, u.id, {enabled:false});
  await assert.rejects(auth.login('alice', initial), /用户名或密码错误/);
});
test('sessions expire after exactly eight hours and logout revokes them', async t => {
  const {auth, token, advance} = await fixture(t);
  advance(8 * 60 * 60 * 1000);
  assert.throws(() => auth.session(token), /登录/);
  const next = await auth.login('admin', changed);
  auth.logout(next.token); assert.throws(() => auth.session(next.token));
});
test('login uses uniform errors and administrator privilege is rechecked after hashing', async t => {
  const {auth, admin} = await fixture(t);
  await assert.rejects(auth.login('missing', initial), /用户名或密码错误/);
  await assert.rejects(auth.login('admin', 'wrong-password'), /用户名或密码错误/);
  const second = await auth.createUser(admin.id, {username:'other-admin',password:initial,role:'admin'});
  let login = await auth.login('other-admin', initial);
  await auth.changePassword(login.token, initial, changed);
  const pending = auth.createUser(admin.id, {username:'racing',password:initial,role:'operate'});
  await auth.updateUser(second.id, admin.id, {enabled:false});
  await assert.rejects(pending);
  assert.ok(!auth.list(second.id).some(u => u.username === 'racing'));
});
