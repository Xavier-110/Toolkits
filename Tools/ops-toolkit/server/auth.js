import { scrypt, randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { transaction, fail } from './database.js';

const derive = promisify(scrypt);
const roles = ['admin', 'operate', 'readonly'];
const digest = token => createHash('sha256').update(token).digest('hex');
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail(400, '密码长度须为 12～128 个字符');
}
export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = await derive(password, salt, 64, {N:32768, r:8, p:1, maxmem:64*1024*1024});
  return `${salt}:${hash.toString('hex')}`;
}
export async function verify(password, encoded) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const computed = await hashPassword(password, encoded.split(':')[0]);
  return timingSafeEqual(Buffer.from(computed), Buffer.from(encoded));
}
export function publicUser(row) {
  return {id:row.id, username:row.username, role:row.role, enabled:!!row.enabled, mustChangePassword:!!row.mustChangePassword, createdAt:row.createdAt};
}
export class Auth {
  constructor(db, clock = Date.now) { this.db = db; this.clock = clock; }
  user(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id); }
  requireUser(id, role = '') {
    const row = this.user(id);
    if (!row?.enabled) fail(401, '请重新登录');
    if (row.mustChangePassword) fail(403, '请先修改密码');
    if (role === 'admin' && row.role !== 'admin' || role === 'write' && row.role === 'readonly') fail(403, '当前账号无此操作权限');
    return publicUser(row);
  }
  async bootstrap(username, password) {
    if (this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n) fail(409, '管理员已初始化');
    const record = await this.prepareUser({username, password, role:'admin'});
    return transaction(this.db, () => {
      if (this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n) fail(409, '管理员已初始化');
      return this.insertUser(record);
    });
  }
  async prepareUser({username, password, role}) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) fail(400, '用户名须为 3～64 位字母、数字、点、下划线或短横线');
    if (!roles.includes(role)) fail(400, '无效角色');
    validatePassword(password);
    return {id:randomUUID(), username, passwordHash:await hashPassword(password), role, createdAt:new Date(this.clock()).toISOString()};
  }
  insertUser(r) {
    if (this.db.prepare('SELECT id FROM users WHERE username=?').get(r.username)) fail(409, '用户名已存在');
    this.db.prepare('INSERT INTO users (id,username,passwordHash,role,createdAt) VALUES (?,?,?,?,?)').run(r.id,r.username,r.passwordHash,r.role,r.createdAt);
    return publicUser(this.user(r.id));
  }
  async createUser(actorId, data, authorize = () => {}) {
    this.requireUser(actorId, 'admin');
    const record = await this.prepareUser(data);
    return transaction(this.db, () => { authorize(); this.requireUser(actorId, 'admin'); return this.insertUser(record); });
  }
  list(actorId) { this.requireUser(actorId, 'admin'); return this.db.prepare('SELECT * FROM users ORDER BY createdAt,username').all().map(publicUser); }
  async updateUser(actorId, id, patch, authorize = () => {}) {
    this.requireUser(actorId, 'admin');
    if (!patch || Object.keys(patch).some(k => !['role','enabled','password'].includes(k))) fail(400, '不支持的用户字段');
    if ('role' in patch && !roles.includes(patch.role)) fail(400, '无效角色');
    if ('enabled' in patch && typeof patch.enabled !== 'boolean') fail(400, '启用状态无效');
    let passwordHash;
    if ('password' in patch) { validatePassword(patch.password); passwordHash = await hashPassword(patch.password); }
    return transaction(this.db, () => {
      authorize();
      this.requireUser(actorId, 'admin');
      const row = this.user(id); if (!row) fail(404, '用户不存在');
      const role = patch.role ?? row.role, enabled = 'enabled' in patch ? Number(patch.enabled) : row.enabled;
      if (row.role === 'admin' && row.enabled && (role !== 'admin' || !enabled) && this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND enabled=1").get().n <= 1) fail(409, '不能禁用或降级最后一个管理员');
      this.db.prepare('UPDATE users SET role=?,enabled=?,passwordHash=?,mustChangePassword=? WHERE id=?').run(role,enabled,passwordHash ?? row.passwordHash,passwordHash ? 1 : row.mustChangePassword,id);
      this.db.prepare('DELETE FROM sessions WHERE userId=?').run(id);
      return publicUser(this.user(id));
    });
  }
  async login(username, password) {
    const row = typeof username === 'string' && username.length <= 64 ? this.db.prepare('SELECT * FROM users WHERE username=?').get(username) : null;
    // An unknown account still pays the password derivation cost.
    const encoded = row?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const valid = await verify(password, encoded);
    const current = row && this.user(row.id);
    if (!valid || !current?.enabled || current.passwordHash !== encoded) fail(401, '用户名或密码错误，或账号未启用');
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(this.clock());
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token),row.id,csrf,this.clock()+8*60*60*1000);
    return {token, csrf, user:publicUser(current)};
  }
  session(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail(401, '请重新登录');
    const session = this.db.prepare('SELECT * FROM sessions WHERE digest=?').get(digest(token));
    const user = session && this.user(session.userId);
    if (!session || session.expiresAt <= this.clock() || !user?.enabled) fail(401, '登录已失效，请重新登录');
    return {user:publicUser(user), csrf:session.csrf};
  }
  async changePassword(token, oldPassword, password) {
    const {user} = this.session(token), row = this.user(user.id);
    validatePassword(password);
    if (password === oldPassword) fail(400, '新密码必须与旧密码不同');
    if (!await verify(oldPassword, row.passwordHash)) fail(400, '原密码错误');
    const passwordHash = await hashPassword(password);
    return transaction(this.db, () => {
      this.session(token);
      if (this.user(user.id).passwordHash !== row.passwordHash) fail(409, '密码已变化，请重新登录');
      this.db.prepare('UPDATE users SET passwordHash=?,mustChangePassword=0 WHERE id=?').run(passwordHash,user.id);
      this.db.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
    });
  }
  logout(token) { if (typeof token === 'string') this.db.prepare('DELETE FROM sessions WHERE digest=?').run(digest(token)); }
}
