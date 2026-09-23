import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readdir,readFile,rename,lstat,realpath,unlink,open} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fail} from './database.js';
import {exportWorkspaceState,legacyWorkspaceState,backupValidate,validateLegacyPackage,normalizeWorkspaceState} from './workspace.js';
import {emptySnapshot} from './storage-manager.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dateKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const name=id=>`ops-system-${id}.json`;
const idPattern=/^[a-f0-9-]{36}$/;
function settings(state){return state.management?.backup||{enabled:false,time:'02:00',retain:10};}
export function validateSystemBackup(pkg){
  if(!pkg||pkg.format!=='ops-toolkit-system'||pkg.formatVersion!==1||!idPattern.test(pkg.id)||!idPattern.test(pkg.ownerId)||!pkg.snapshot||!Array.isArray(pkg.snapshot.users))fail(400,'系统备份格式无效');
  const {digest,...body}=pkg;if(digest!==hash(body))fail(400,'系统备份摘要不匹配');
  const users=pkg.snapshot.users,ids=new Set(),names=new Set();
  for(const u of users){if(!u||typeof u.id!=='string'||!u.id||ids.has(u.id)||typeof u.username!=='string'||!/^[a-zA-Z0-9_.-]{3,64}$/.test(u.username)||names.has(u.username.toLowerCase())||!['admin','operate','readonly'].includes(u.role)||![0,1].includes(u.enabled)||![0,1].includes(u.mustChangePassword)||!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(u.passwordHash)||!Number.isFinite(Date.parse(u.createdAt)))fail(400,'系统备份用户无效');ids.add(u.id);names.add(u.username.toLowerCase());}
  if(!users.some(u=>u.role==='admin'&&u.enabled))fail(400,'系统备份缺少可用管理员');
  const state=normalizeWorkspaceState(structuredClone(pkg.snapshot.workspace)),actor={id:'backup-validation',username:'backup-validation',role:'admin',enabled:true};
  for(const [key,rows] of Object.entries({users,configs:state.configs,versions:state.versions,tags:state.versionTags}))if(pkg.counts?.[key]!==rows.length)fail(400,'系统备份数量不匹配');
  const business=exportWorkspaceState(state,actor);business.dictionaries=state.dictionaries;business.bindings=state.bindings;delete business.digest;business.digest=hash(business);backupValidate(business);validateLegacyPackage(legacyWorkspaceState(state,actor));
  if(business.versions.length!==state.versions.length||business.versionTags.length!==state.versionTags.length||business.recoveryDrafts.length!==state.recoveryDrafts.length)fail(400,'系统备份包含无所属配置的记录');
  if(pkg.snapshot.sessions)fail(400,'系统备份不能包含会话');return pkg;
}
export class BackupManager {
  constructor(manager,{clock=Date.now}={}){this.manager=manager;this.clock=clock;this.directory=manager.directory&&join(manager.directory,'backups');this.running=null;this.timer=null;}
  async ensureDirectory(){if(!this.directory)fail(503,'临时内存服务未配置持久备份目录');await mkdir(this.directory,{recursive:true});if((await lstat(this.directory)).isSymbolicLink())fail(400,'备份目录不能是符号链接');return realpath(this.directory);}
  async safeFile(id){if(!idPattern.test(id))fail(400,'备份编号无效');const root=await this.ensureDirectory(),file=join(root,name(id)),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||dirname(await realpath(file))!==root)fail(400,'备份文件路径无效');return file;}
  async configure(data){
    if(!data||Object.keys(data).some(k=>!['enabled','time','retain'].includes(k))||typeof data.enabled!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time)||!Number.isInteger(data.retain)||data.retain<1||data.retain>365)fail(400,'备份任务参数无效');
    await this.ensureDirectory();await this.manager.store.mutateWorkspace(state=>{state.management??={};const old=settings(state);state.management.backup={...old,...data,ownerId:old.ownerId||randomUUID(),enabledSince:data.enabled&&!old.enabled?new Date(this.clock()).toISOString():old.enabledSince};});return this.list();
  }
  async files(ownerId){
    if(!this.directory)return [];const root=await this.ensureDirectory(),files=[];
    for(const file of await readdir(root)){const match=/^ops-system-([a-f0-9-]{36})\.json$/.exec(file);if(!match)continue;try{const path=await this.safeFile(match[1]),bytes=await readFile(path),pkg=JSON.parse(bytes);if(pkg.ownerId!==ownerId)continue;validateSystemBackup(pkg);files.push({id:pkg.id,createdAt:pkg.createdAt,createdBy:pkg.createdBy,source:pkg.source,size:bytes.length,digest:pkg.digest,counts:pkg.counts});}catch{ /* Unrecognized or damaged files never become retention deletion targets. */ }}
    return files.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
  }
  async list(){const current=settings(await this.manager.store.getWorkspace()),now=new Date(this.clock()),[h,m]=current.time.split(':').map(Number);const next=new Date(now);next.setHours(h,m,0,0);if(next<=now)next.setDate(next.getDate()+1);return {schedule:current,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,nextRun:current.enabled?next.toISOString():null,running:!!this.running,files:current.ownerId?await this.files(current.ownerId):[]};}
  async create({username='定时任务',source='manual',scheduledDay=null}={}){
    if(this.running)return this.running;
    this.running=this.perform({username,source,scheduledDay});try{return await this.running;}finally{this.running=null;}
  }
  async perform({username,source,scheduledDay}){
    const release=this.manager.enter();let successful=false;
    try{
      const root=await this.ensureDirectory();let current=settings(await this.manager.store.getWorkspace());
      if(!current.ownerId){await this.manager.store.mutateWorkspace(state=>{state.management??={};state.management.backup={...settings(state),ownerId:randomUUID()};});current=settings(await this.manager.store.getWorkspace());}
      if(scheduledDay&&current.lastAttemptDay===scheduledDay)return {unchanged:true};
      const snapshot=await this.manager.store.snapshot(),id=randomUUID(),createdAt=new Date(this.clock()).toISOString();
      const pkg={format:'ops-toolkit-system',formatVersion:1,id,ownerId:current.ownerId,createdAt,createdBy:username,source,counts:{users:snapshot.users.length,configs:snapshot.workspace.configs.length,versions:snapshot.workspace.versions.length,tags:snapshot.workspace.versionTags.length},snapshot};pkg.digest=hash(pkg);validateSystemBackup(pkg);
      const temp=join(root,`${id}.tmp`),target=join(root,name(id)),handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(pkg));await handle.sync();}finally{await handle.close();}
      validateSystemBackup(JSON.parse(await readFile(temp,'utf8')));await rename(temp,target);successful=true;
      let cleanupError=null;const files=await this.files(current.ownerId);for(const file of files.slice(current.retain)){try{await unlink(await this.safeFile(file.id));}catch{cleanupError='部分旧备份清理失败，已保留文件，请检查目录权限';}}
      await this.manager.store.mutateWorkspace(state=>{const value=state.management.backup;Object.assign(value,{lastSuccessAt:createdAt,lastResult:cleanupError||'备份成功',...(scheduledDay?{lastAttemptDay:scheduledDay}:{})});});
      return {id,createdAt,counts:pkg.counts,cleanupError};
    }catch(error){try{await this.manager.store.mutateWorkspace(state=>{state.management??={};state.management.backup={...settings(state),lastResult:successful?'备份文件已生成，但状态记录失败':'备份失败，请检查存储和备份目录',lastFailureAt:new Date(this.clock()).toISOString(),...(scheduledDay?{lastAttemptDay:scheduledDay}:{})};});}catch{}throw error;}finally{release();}
  }
  async tick(){
    const current=settings(await this.manager.store.getWorkspace());if(!current.enabled||this.manager.maintenance||this.running)return;
    const now=new Date(this.clock()),due=new Date(now),[h,m]=current.time.split(':').map(Number);due.setHours(h,m,0,0);
    if(now<due){if(current.enabledSince&&dateKey(new Date(current.enabledSince))===dateKey(now))return;due.setDate(due.getDate()-1);}
    const day=dateKey(due);if(current.lastAttemptDay===day)return;return this.create({source:'scheduled',scheduledDay:day});
  }
  start(){this.timer=setInterval(()=>this.tick().catch(()=>{}),30000);this.timer.unref();this.tick().catch(()=>{});}
  async stop(){clearInterval(this.timer);if(this.running)await this.running.catch(()=>{});}
  async download(id){const current=settings(await this.manager.store.getWorkspace()),bytes=await readFile(await this.safeFile(id)),pkg=validateSystemBackup(JSON.parse(bytes));if(pkg.ownerId!==current.ownerId)fail(404,'备份不属于当前工具箱');return bytes;}
}
export async function restoreSystemBackup(pkg,store){
  validateSystemBackup(pkg);
  await store.transaction(async tx=>{if(!emptySnapshot({users:await tx.users(),workspace:await tx.getWorkspace()}))fail(409,'恢复目标非空，拒绝覆盖');
    for(const user of pkg.snapshot.users)await tx.insertUser(user);const state=normalizeWorkspaceState(structuredClone(pkg.snapshot.workspace));state.management??={};state.management.backup={...settings(state),enabled:false,ownerId:randomUUID(),lastAttemptDay:null,lastResult:'系统恢复后任务已暂停，请核对后启用'};await tx.setWorkspace(state);await tx.clearSessions();});
  return pkg.counts;
}
