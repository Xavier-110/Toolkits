import { randomUUID } from 'node:crypto';
import { Auth } from './auth.js';
import { transaction, fail } from './database.js';
import { addConfig, saveDraft, makeDraft, archiveVersion, restoreVersion, shouldAutoArchive, exportBackup, exportShare, validateBackup, importBackup } from '../src/store.js';
import { object } from '../src/core.js';

function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) fail(400, '请求包含不支持的字段');
}
function text(value, max, empty = true) { if (typeof value !== 'string' || value.length > max || !empty && !value.trim()) fail(400,'文本字段无效'); return value; }
function metadata(data) {
  if ('description' in data) text(data.description, 10000);
  if ('tags' in data && (!Array.isArray(data.tags) || data.tags.length>100 || data.tags.some(t=>typeof t!=='string'||t.length>120))) fail(400,'标签无效');
  if ('itemMetadata' in data && (!object(data.itemMetadata) || Object.keys(data.itemMetadata).length>5000 || Object.entries(data.itemMetadata).some(([k,v])=>k.length>1000||typeof v!=='boolean'))) fail(400,'敏感标记无效');
}
function draft(data) {
  fields(data,['rawInput','inputFormat','options','validationState','updatedAt']);
  text(data.rawInput,1024*1024); if (!['json','yaml','env-json'].includes(data.inputFormat)) fail(400,'输入格式无效');
  const options = data.options || {}; fields(options,['coerce','sort']);
  if ('coerce' in options && typeof options.coerce!=='boolean' || 'sort' in options && !['asc','desc','none'].includes(options.sort)) fail(400,'转换选项无效');
  return makeDraft(data.rawInput,data.inputFormat,options);
}
function settings(data) {
  fields(data,['theme','sort','autoArchiveEnabled','expiryWarningDays']);
  if ('theme' in data && !['dark','light'].includes(data.theme) || 'sort' in data && !['asc','desc','none'].includes(data.sort) || 'autoArchiveEnabled' in data && typeof data.autoArchiveEnabled!=='boolean' || 'expiryWarningDays' in data && (!Number.isFinite(data.expiryWarningDays)||data.expiryWarningDays<0||data.expiryWarningDays>3650)) fail(400,'设置无效');
}
const pick = (value, keys) => Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
const recordFields = {
  projects:['id','name','createdAt'], environments:['id','name','projectId'],
  configs:['id','projectId','environmentId','name','type','description','tags','sourceConfigId','createdAt','updatedAt','archivedAt','latestVersionId','nextVersionNumber','revision','itemMetadata'],
  versions:['id','configSetId','versionNumber','modelVersion','rawInput','inputFormat','options','normalizedContent','contentHash','itemMetadata','source','note','createdAt','restoredFromVersionId'],
  drafts:['configSetId','rawInput','inputFormat','options','validationState','updatedAt','baseVersionId','revision'],
  recoveryDrafts:['id','reason','createdAt','configSetId','rawInput','inputFormat','options','validationState','updatedAt','baseVersionId','revision']
};
function importedBackup(backup, context) {
  if (!object(backup) || ![1,2].includes(backup.schemaVersion)) fail(400,'不支持的备份版本');
  const validated=validateBackup(JSON.stringify({...backup,schemaVersion:1}));
  const s=validated.workspace, clean={schemaVersion:1,revision:0};
  for (const [kind,keys] of Object.entries(recordFields)) clean[kind]=s[kind].map(row=>{
    const result=pick(row,keys);
    if (result.options) result.options=pick(result.options,['sort','coerce']);
    if (['versions','drafts','recoveryDrafts'].includes(kind)) {
      Object.assign(result,{provenance:'imported',editedByUserId:null,submittedByUserId:null,importedByUserId:context.user.id,importedByUsername:context.user.username,importedAt:context.time});
      for (const key of ['editedByUsername','submittedByUsername']) result[key]=typeof row[key]==='string' && row[key].length<=64 ? row[key] : null;
      for (const key of ['editedAt','submittedAt']) result[key]=typeof row[key]==='string' && Number.isFinite(Date.parse(row[key])) ? new Date(row[key]).toISOString() : null;
    }
    return result;
  });
  clean.settings=pick(s.settings,['theme','sort','autoArchiveEnabled','expiryWarningDays']);
  settings(clean.settings);
  return {...validated,workspace:clean};
}
export class Workspace {
  constructor(db, clock=Date.now) {this.db=db;this.clock=clock;this.auth=new Auth(db,clock);}
  read() {return JSON.parse(this.db.prepare('SELECT data FROM workspace WHERE id=1').get().data);}
  write(state) {state.revision++;this.db.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(state));}
  execute(actor, command) {
    fields(command,['type','id','expectedRevision','data']);
    return transaction(this.db,()=>{
      const user=this.auth.requireUser(actor.id,'write'), context={user,time:new Date(this.clock()).toISOString()};
      const state=this.read(), {type,id}=command, data=command.data || {};
      if (!['create','draft','submit','restore','metadata','archive','delete','clean','replace','import','settings'].includes(type)) fail(400,'不支持的业务命令');
      const config=state.configs.find(c=>c.id===id);
      if (!['create','import','settings'].includes(type)) {
        if (!config) fail(404,'配置不存在');
        if (command.expectedRevision!==config.revision) fail(409,'配置已被其他用户修改，请保留当前输入并重新载入');
        if (config.archivedAt && !['archive','delete','clean'].includes(type)) fail(409,'请先恢复已归档的配置集');
      }
      let result=null;
      switch(type) {
        case 'create': {
          fields(data,['project','environment','name','type','description','tags','sourceConfigId','itemMetadata','draft']); metadata(data);
          if (!['json','k8s-env'].includes(data.type)) fail(400,'配置类型无效');
          if (data.sourceConfigId && !state.configs.some(c=>c.id===data.sourceConfigId)) fail(400,'复制来源不存在');
          result=addConfig(state,data,draft(data.draft),context); break;
        }
        case 'draft': fields(data,['draft']); result=saveDraft(state,id,draft(data.draft),context); break;
        case 'submit': fields(data,['note']); result=archiveVersion(state,id,'manual',text(data.note ?? '',2000),null,context); break;
        case 'restore': fields(data,['versionId']); result=restoreVersion(state,id,text(data.versionId,100,false),context); break;
        case 'replace': {
          fields(data,['draft']); const old=state.drafts.find(d=>d.configSetId===id);
          if (old) state.recoveryDrafts.push({...structuredClone(old),id:randomUUID(),reason:'从转换页更新前的草稿',createdAt:context.time});
          saveDraft(state,id,draft(data.draft),context); result=archiveVersion(state,id,'manual','从转换页更新',null,context); break;
        }
        case 'metadata': {
          fields(data,['name','description','tags','itemMetadata']);metadata(data);text(data.name,120,false);
          const name=data.name.trim(); if(state.configs.some(c=>c.id!==id&&c.projectId===config.projectId&&c.environmentId===config.environmentId&&c.name===name)) fail(409,'配置名称已存在');
          Object.assign(config,data,{name,updatedByUserId:user.id,updatedByUsername:user.username,updatedAt:context.time});config.revision++;break;
        }
        case 'archive': fields(data,[]);config.archivedAt=config.archivedAt ? null : context.time;config.revision++;break;
        case 'delete': fields(data,[]);for(const key of ['configs','versions','drafts','recoveryDrafts']) state[key]=state[key].filter(x=>key==='configs'?x.id!==id:x.configSetId!==id);break;
        case 'clean': {
          fields(data,['versionIds']);if(!Array.isArray(data.versionIds)||data.versionIds.some(v=>typeof v!=='string'||!state.versions.some(x=>x.id===v&&x.configSetId===id)||v===config.latestVersionId)) fail(400,'清理版本无效，最新版本不可删除');
          const ids=new Set(data.versionIds);state.versions=state.versions.filter(v=>!ids.has(v.id));
          for(const v of state.versions) if(ids.has(v.restoredFromVersionId)) v.restoredFromVersionId=null;
          for(const d of [...state.drafts,...state.recoveryDrafts]) if(ids.has(d.baseVersionId)) d.baseVersionId=null;
          config.revision++;break;
        }
        case 'settings': settings(data);Object.assign(state.settings,data);break;
        case 'import': fields(data,['backup','skipConflicts','importSettings']);result=importBackup(state,importedBackup(data.backup,context),data.skipConflicts===true,data.importSettings===true);break;
      }
      this.write(state);return {result,state};
    });
  }
  tick() {
    return transaction(this.db,()=>{
      const state=this.read();let count=0;
      for (const draft of state.drafts) {
        const user=this.auth.user(draft.editedByUserId || '');
        if(draft.provenance!=='local'||!user?.enabled||user.mustChangePassword||!['admin','operate'].includes(user.role)) continue;
        if(!shouldAutoArchive(state,draft.configSetId,Date.parse(draft.editedAt),this.clock())) continue;
        if(archiveVersion(state,draft.configSetId,'auto','自动归档',null,{user,time:new Date(this.clock()).toISOString()})) count++;
      }
      if(count)this.write(state);return count;
    });
  }
  backup(actor,id='',redacted=false) {
    this.auth.requireUser(actor.id,'write');const state=this.read();
    if(id&&!state.configs.some(c=>c.id===id))fail(404,'配置不存在');
    const result=redacted?exportShare(state,id):exportBackup(state,id);
    result.schemaVersion=2;result.exportedAt=new Date(this.clock()).toISOString();return result;
  }
}
