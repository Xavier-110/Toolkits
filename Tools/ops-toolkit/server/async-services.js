import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {publicUser,validatePassword,hashPassword,verify} from './auth.js';
import {fail} from './database.js';
import {applyWorkspaceCommand,exportWorkspaceState,backupWorkspaceState,legacyWorkspaceState} from './workspace.js';
import {environmentImpact} from './environments.js';
const roles=['admin','operate','readonly'],digest=value=>createHash('sha256').update(value).digest('hex');
export class AsyncAuth {
  constructor(store,clock=Date.now){this.store=store;this.clock=clock;}
  user(id){return this.store.getUser(id);}
  async requireUser(id,role=''){
    const row=await this.user(id);if(!row?.enabled)fail(401,'请重新登录');if(row.mustChangePassword)fail(403,'请先修改密码');
    if(role==='admin'&&row.role!=='admin'||role==='write'&&row.role==='readonly')fail(403,'当前账号无此操作权限');return publicUser(row);
  }
  async prepareUser({username,password,role}){
    if(typeof username!=='string'||!/^[a-zA-Z0-9_.-]{3,64}$/.test(username))fail(400,'用户名须为3～64位字母、数字、点、下划线或短横线');if(!roles.includes(role))fail(400,'无效角色');validatePassword(password);
    return {id:randomUUID(),username,passwordHash:await hashPassword(password),role,enabled:1,mustChangePassword:1,createdAt:new Date(this.clock()).toISOString()};
  }
  async bootstrap(username,password){const record=await this.prepareUser({username,password,role:'admin'});return this.store.transaction(async tx=>{if((await tx.users()).length)fail(409,'管理员已初始化');await tx.insertUser(record);return publicUser(record);});}
  async createUser(actorId,data,authorize=()=>{}){
    await this.requireUser(actorId,'admin');const record=await this.prepareUser(data);
    return this.store.transaction(async tx=>{const auth=new AsyncAuth(tx,this.clock);await authorize(auth);await auth.requireUser(actorId,'admin');if(await tx.findUser(record.username))fail(409,'用户名已存在');await tx.insertUser(record);return publicUser(record);});
  }
  async list(actorId){await this.requireUser(actorId,'admin');return (await this.store.users()).map(publicUser);}
  async updateUser(actorId,id,patch,authorize=()=>{}){
    await this.requireUser(actorId,'admin');if(!patch||Object.keys(patch).some(k=>!['role','enabled','password'].includes(k)))fail(400,'不支持的用户字段');
    if('role'in patch&&!roles.includes(patch.role)||'enabled'in patch&&typeof patch.enabled!=='boolean')fail(400,'用户属性无效');
    let passwordHash;if('password'in patch){validatePassword(patch.password);passwordHash=await hashPassword(patch.password);}
    return this.store.transaction(async tx=>{const auth=new AsyncAuth(tx,this.clock);await authorize(auth);await auth.requireUser(actorId,'admin');const row=await tx.getUser(id);if(!row)fail(404,'用户不存在');const role=patch.role??row.role,enabled='enabled'in patch?Number(patch.enabled):row.enabled;
      if(row.role==='admin'&&row.enabled&&(role!=='admin'||!enabled)&&(await tx.users()).filter(u=>u.role==='admin'&&u.enabled).length<=1)fail(409,'不能禁用或降级最后一个管理员');
      await tx.updateUser(id,{role,enabled,passwordHash:passwordHash??row.passwordHash,mustChangePassword:passwordHash?1:row.mustChangePassword});await tx.deleteUserSessions(id);return publicUser(await tx.getUser(id));});
  }
  async login(username,password){
    const row=typeof username==='string'&&username.length<=64?await this.store.findUser(username):null,encoded=row?.passwordHash??`${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const valid=await verify(password,encoded);
    return this.store.transaction(async tx=>{const current=row&&await tx.getUser(row.id);if(!valid||!current?.enabled||current.passwordHash!==encoded)fail(401,'用户名或密码错误，或账号未启用');const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');await tx.expireSessions(this.clock());await tx.insertSession({digest:digest(token),userId:row.id,csrf,expiresAt:this.clock()+8*60*60*1000});return {token,csrf,user:publicUser(current)};});
  }
  async session(token){
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))fail(401,'请重新登录');const row=await this.store.getSession(digest(token)),user=row&&await this.user(row.userId);
    if(!row||Number(row.expiresAt)<=this.clock()||!user?.enabled)fail(401,'登录已失效，请重新登录');return {user:publicUser(user),csrf:row.csrf};
  }
  async changePassword(token,oldPassword,password){
    const {user}=await this.session(token),row=await this.user(user.id);validatePassword(password);if(password===oldPassword)fail(400,'新密码必须与旧密码不同');if(!await verify(oldPassword,row.passwordHash))fail(400,'原密码错误');const passwordHash=await hashPassword(password);
    return this.store.transaction(async tx=>{const auth=new AsyncAuth(tx,this.clock);await auth.session(token);if((await tx.getUser(user.id)).passwordHash!==row.passwordHash)fail(409,'密码已变化，请重新登录');await tx.updateUser(user.id,{passwordHash,mustChangePassword:0});await tx.deleteUserSessions(user.id);});
  }
  async logout(token){if(typeof token==='string')await this.store.deleteSession(digest(token));}
}
export class AsyncWorkspace {
  constructor(store,clock=Date.now){this.store=store;this.clock=clock;this.auth=new AsyncAuth(store,clock);}
  read(){return this.store.getWorkspace();}
  async environmentDeletePreview(actor,data){await this.auth.requireUser(actor.id,'admin');return environmentImpact(await this.read(),data);}
  async execute(actor,command){return this.store.transaction(async tx=>{const user=await new AsyncAuth(tx,this.clock).requireUser(actor.id,'write'),state=await tx.getWorkspace();const response=applyWorkspaceCommand(state,user,command,new Date(this.clock()).toISOString());if(response.changed){response.state.revision++;await tx.setWorkspace(response.state);}return {result:response.result,state:response.state};});}
  async export(actor,options){const user=await this.auth.requireUser(actor.id,'write');return exportWorkspaceState(await this.read(),user,options,this.clock);}
  async backup(actor,id='',redacted=false){const user=await this.auth.requireUser(actor.id,'admin');return backupWorkspaceState(await this.read(),user,id,redacted,this.clock);}
  async legacyExport(actor){const user=await this.auth.requireUser(actor.id,'write');return legacyWorkspaceState(await this.read(),user,this.clock);}
}
