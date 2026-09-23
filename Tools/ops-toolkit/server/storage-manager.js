import {dirname,join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {openDatabase,fail} from './database.js';
import {Auth} from './auth.js';
import {Workspace} from './workspace.js';
import {SqlStore,openStore,validateConnection} from './storage.js';
import {AsyncAuth,AsyncWorkspace} from './async-services.js';
import {SecureConfig} from './secure-config.js';
import {serialize} from '../src/core.js';
export const snapshotDigest=snapshot=>createHash('sha256').update(serialize({...snapshot,users:[...snapshot.users].sort((a,b)=>a.id.localeCompare(b.id))})).digest('hex');
export function emptySnapshot(snapshot){const s=snapshot.workspace;return !snapshot.users.length&&!s.revision&&['configs','versions','versionTags','bindings','legacy','recoveryDrafts','receipts'].every(k=>!s[k]?.length)&&Object.values(s.dictionaries).every(rows=>!rows.length);}
const empty=emptySnapshot;
export class StorageManager {
  constructor(store,config,{directory,clock=Date.now,document,opener=openStore}={}){this.store=store;this.directory=directory;this.clock=clock;this.secure=new SecureConfig(directory);this.document=document||{version:1,revision:0,active:config};this.opener=opener;this.maintenance=false;this.requests=0;this.waiters=[];this.setServices();}
  static local(filename,{clock=Date.now,directory}={}){const path=filename===':memory:'?filename:resolve(filename);return new StorageManager(new SqlStore('sqlite',null,{db:openDatabase(path)}),{type:'sqlite',filename:path},{directory:directory??(path===':memory:'?null:dirname(path)),clock});}
  setServices(){this.services=this.store.type==='sqlite'?{auth:new Auth(this.store.db,this.clock),workspace:new Workspace(this.store.db,this.clock)}:{auth:new AsyncAuth(this.store,this.clock),workspace:new AsyncWorkspace(this.store,this.clock)};}
  enter(){if(this.maintenance)fail(503,'存储迁移维护中，请保留编辑并稍后重试');this.requests++;let done=false;return ()=>{if(done)return;done=true;this.requests--;for(const notify of this.waiters.splice(0))notify();};}
  async idle(remaining){while(this.requests>remaining)await new Promise(r=>this.waiters.push(r));}
  summary(admin=false){const c=this.document.active;return {type:c.type,status:this.maintenance?'migrating':'ready',revision:this.document.revision,...(admin?{connection:{...Object.fromEntries(Object.entries(c).filter(([k])=>!['password','filename'].includes(k))),passwordSet:!!c.password},localFile:c.type==='sqlite'?c.filename:undefined,pendingMigration:this.document.pending?{requestId:this.document.pending.id,type:this.document.pending.target.type}:null}:{} )};}
  connection(input){let config={...input};if(config.type!=='sqlite'&&config.password===''&&this.document.active.type===config.type&&this.document.active.host===config.host&&this.document.active.username===config.username)config.password=this.document.active.password;return validateConnection(config);}
  async testConnection(input){const config=this.connection(input);if(config.type==='sqlite')return {ok:true,type:'sqlite'};const store=await this.opener(config,{initializeTables:false});await store.close();return {ok:true,type:config.type,message:'连接成功，表结构和写入权限将在迁移时验证'};}
  async cancelMigration(actorId,{requestId,expectedRevision},{requestActive=false}={}){
    if(this.maintenance)fail(409,'已有存储迁移正在进行');this.maintenance=true;
    try{await this.idle(requestActive?1:0);await this.services.auth.requireUser(actorId,'admin');if(expectedRevision!==this.document.revision||this.document.pending?.id!==requestId)fail(409,'迁移记录已变化，请刷新');const {pending,...rest}=this.document,next={...rest,revision:rest.revision+1};await this.secure.write(next);this.document=next;return {cancelled:true,targetPreserved:true};}finally{this.maintenance=false;}
  }
  async migrate(actorId,{connection,requestId,expectedRevision},{requestActive=false}={}){
    if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(requestId))fail(400,'迁移请求编号无效');
    if(this.document.lastMigration?.id===requestId)return this.document.lastMigration.result;
    if(expectedRevision!==this.document.revision)fail(409,'存储设置已变化，请刷新后重试');
    if(this.maintenance)fail(409,'已有存储迁移正在进行');
    let targetConfig=this.document.pending?.target||this.connection(connection),target=null,activated=false;
    if(targetConfig.type==='sqlite'){if(!this.directory)fail(400,'临时内存服务没有可持久化目录');targetConfig={type:'sqlite',filename:join(this.directory,`storage-${randomUUID()}.sqlite`)};}
    this.maintenance=true;
    try{
      await this.idle(requestActive?1:0);await this.services.auth.requireUser(actorId,'admin');
      const source=await this.store.snapshot(),sourceDigest=snapshotDigest(source);
      const previous=this.document.pending;
      if(previous){if(previous.id!==requestId)fail(409,'存在未完成迁移，请使用原迁移请求重试或联系管理员检查');if(previous.sourceDigest!==sourceDigest)fail(409,'迁移后源数据已变化，不能激活旧目标，请保留两侧数据并检查');targetConfig=previous.target;}
      target=await this.opener(targetConfig);
      const targetSnapshot=await target.snapshot();
      if(!empty(targetSnapshot)&&(!previous||snapshotDigest(targetSnapshot)!==sourceDigest))fail(409,'目标已有工具箱数据，拒绝覆盖');
      if(!previous){this.document={...this.document,pending:{id:requestId,sourceDigest,target:targetConfig}};await this.secure.write(this.document);}
      if(empty(targetSnapshot))await target.transaction(async tx=>{if(!empty({users:await tx.users(),workspace:await tx.getWorkspace()}))fail(409,'目标已有工具箱数据，拒绝覆盖');for(const user of source.users)await tx.insertUser(user);await tx.setWorkspace(source.workspace);await tx.clearSessions();});
      if(snapshotDigest(await target.snapshot())!==sourceDigest)fail(503,'迁移数据校验失败，继续使用原存储');
      const result={migrated:true,type:targetConfig.type,counts:{users:source.users.length,configs:source.workspace.configs.length,versions:source.workspace.versions.length},relogin:true};
      const next={version:1,revision:this.document.revision+1,active:targetConfig,lastMigration:{id:requestId,result}};
      // The durable pointer is the commit point. Failure before this write leaves
      // the source active; retries verify both snapshots before activation.
      await this.secure.write(next);const old=this.store;this.document=next;this.store=target;this.setServices();activated=true;await old.close().catch(()=>{});return result;
    }catch(error){if(!activated&&target)await target.close().catch(()=>{});throw error;}finally{this.maintenance=false;}
  }
  async close(){await this.store.close();}
}
export async function openManagedStorage(dbPath,{clock=Date.now}={}){
  const path=resolve(dbPath),directory=dirname(path),secure=new SecureConfig(directory),document=await secure.read();
  if(!document)return StorageManager.local(path,{clock,directory});
  if(document.version!==1||!document.active||!Number.isSafeInteger(document.revision))fail(503,'存储引导配置无效');
  const store=await openStore(document.active);return new StorageManager(store,document.active,{directory,clock,document});
}
