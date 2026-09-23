import {createVersionTag,deleteVersionTag,validateVersionTags,tagCopy} from './version-tags.js';
import { randomUUID, createHash } from 'node:crypto';
import { Auth } from './auth.js';
import { transaction, fail } from './database.js';
import { validateBackup } from './legacy-backup.js';
import { createWorkspaceState as fresh } from '../src/workspace-state.js';
import { normalizeJSON, validateDescriptions, snapshotHash, maskConfiguration } from '../src/config-model.js';
import { contentHash, serialize, parseInput } from '../src/core.js';
import { createBindings, environmentImpact, deleteEnvironment, removeConfigs, deletionKeys, validateDeletion } from './environments.js';

const kinds=['regions','environmentTypes','configNames'];
const own=(v,k)=>Object.hasOwn(v,k);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const validDate=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
function fields(v,allowed){if(!object(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail(400,'请求包含不支持的字段');}
function string(v,max=120,empty=false){if(typeof v!=='string'||v.length>max||!empty&&!v.trim())fail(400,'文本字段无效');return v;}
function id(v){return string(v,120);}
function digest(v){return createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function readSchema3(state){
  // Early schema3 workspaces predate recoveryDrafts. Hydrate the parsed copy;
  // reads stay read-only, and the next successful transaction persists it.
  if(!own(state,'recoveryDrafts'))state.recoveryDrafts=[];
  if(!Array.isArray(state.recoveryDrafts))fail(400,'工作空间 recoveryDrafts 格式无效，请检查备份或联系管理员');
  if(state.schemaVersion===3&&!own(state,'versionTags'))state.versionTags=[];
  if(!Array.isArray(state.versionTags))fail(400,'工作空间 versionTags 格式无效，请检查备份或联系管理员');
  state.schemaVersion=4;
  return state;
}
const oldVersionKeys=['id','configSetId','versionNumber','modelVersion','rawInput','inputFormat','options','normalizedContent','contentHash','itemMetadata','source','note','createdAt','restoredFromVersionId','editedByUsername','editedAt','submittedByUsername','submittedAt'];
const oldDraftKeys=['id','configSetId','rawInput','inputFormat','options','validationState','updatedAt','baseVersionId','revision','reason','createdAt'];
function safeOldVersion(v){const result=pick(v,oldVersionKeys);for(const key of ['editedByUsername','submittedByUsername'])if(own(result,key)&&(typeof result[key]!=='string'||result[key].length>64))result[key]=null;for(const key of ['editedAt','submittedAt'])if(own(result,key)&&!validDate(result[key]))result[key]=null;return result;}
function legacyRows(old,context){
  if(!Array.isArray(old.configs)||!Array.isArray(old.versions)||!Array.isArray(old.drafts)||!Array.isArray(old.recoveryDrafts))fail(400,'旧工作空间结构无效');
  return old.configs.map(c=>({id:randomUUID(),schemaVersion:old.schemaVersion,sourceConfigId:c.id,type:c.type,projectName:old.projects?.find(p=>p.id===c.projectId)?.name||'',environmentName:old.environments?.find(e=>e.id===c.environmentId)?.name||'',configName:c.name,description:c.description||'',tags:Array.isArray(c.tags)?structuredClone(c.tags):[],itemMetadata:object(c.itemMetadata)?structuredClone(c.itemMetadata):{},versions:old.versions.filter(v=>v.configSetId===c.id).map(safeOldVersion),drafts:old.drafts.filter(d=>d.configSetId===c.id).map(d=>pick(d,oldDraftKeys)),recoveryDrafts:old.recoveryDrafts.filter(d=>d.configSetId===c.id).map(d=>pick(d,oldDraftKeys)),originalCreatedAt:c.createdAt,originalUpdatedAt:c.updatedAt,archivedAt:c.archivedAt||null,latestVersionId:c.latestVersionId,nextVersionNumber:c.nextVersionNumber,createdAt:context.time,importedByUserId:context.user?.id||null,importedByUsername:context.user?.username||null,reason:'待人工映射'}));
}
function migrated(old){const state=fresh(old.revision||0);state.legacy=legacyRows(old,{time:new Date().toISOString(),user:null});state.settings.expiryWarningDays=old.settings?.expiryWarningDays??30;return state;}
const triple=x=>[x.regionId,x.environmentTypeId,x.configNameId].join('\u0000');
const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>own(row,k)).map(k=>[k,structuredClone(row[k])]));
const dictionaryKeys=['id','code','label','enabled','revision','createdAt','updatedAt','updatedByUserId','updatedByUsername',...deletionKeys];
const bindingKeys=['id','regionId','environmentTypeId','configNameId','enabled','revision','updatedAt','updatedByUsername',...deletionKeys];
const configKeys=['id','regionId','environmentTypeId','configNameId','jsonContent','fieldDescriptions','itemMetadata','description','tags','revision','latestVersionId','nextVersionNumber','archivedAt','createdAt','updatedAt','updatedByUserId','updatedByUsername','sourceConfigId'];
const versionKeys=['id','configSetId','versionNumber','jsonContent','fieldDescriptions','itemMetadata','description','tags','contentHash','snapshotHash','environmentSnapshot','source','note','restoredFromVersionId','editedByUsername','editedAt','submittedByUsername','submittedAt','createdAt'];
const recoveryKeys=['id','configSetId','legacyId','reason','rawInput','inputFormat','createdAt','provenance'];
const legacyKeys=['id','schemaVersion','sourceConfigId','type','projectName','environmentName','configName','description','tags','itemMetadata','originalCreatedAt','originalUpdatedAt','archivedAt','latestVersionId','nextVersionNumber','createdAt','importedByUserId','importedByUsername','reason'];
function cleanLegacy(row){return {...pick(row,legacyKeys),versions:row.versions.map(v=>pick(v,oldVersionKeys)),drafts:row.drafts.map(d=>pick(d,oldDraftKeys)),recoveryDrafts:row.recoveryDrafts.map(d=>pick(d,oldDraftKeys))};}
export function validateLegacyPackage(pkg){
  if(!object(pkg)||![3,4].includes(pkg.schemaVersion)||pkg.exportKind!=='legacy'||pkg.redacted!==false||!Array.isArray(pkg.legacy)||!object(pkg.counts)||pkg.counts.legacy!==pkg.legacy.length)fail(400,'待映射包无效');
  const ids=new Set(),sourceIds=new Set(),globalVersionIds=new Set();for(const row of pkg.legacy){if(!object(row)||typeof row.id!=='string'||!row.id||ids.has(row.id)||typeof row.sourceConfigId!=='string'||!row.sourceConfigId||sourceIds.has(row.sourceConfigId)||![1,2].includes(row.schemaVersion)||row.type!==undefined&&!['json','k8s-env'].includes(row.type)||!Array.isArray(row.versions)||!Array.isArray(row.drafts)||!Array.isArray(row.recoveryDrafts)||typeof row.description!=='string'||row.description.length>10000||!Array.isArray(row.tags)||row.tags.some(x=>typeof x!=='string'||x.length>120)||!object(row.itemMetadata)||Object.values(row.itemMetadata).some(x=>typeof x!=='boolean'))fail(400,'待映射记录无效');ids.add(row.id);sourceIds.add(row.sourceConfigId);
    for(const name of ['projectName','environmentName','configName'])if(typeof row[name]!=='string'||!row[name].trim()||row[name].length>120)fail(400,'旧环境或配置名称无效');
    const versions=new Map(),numbers=new Set();for(const v of row.versions){if(!object(v)||typeof v.id!=='string'||!v.id||globalVersionIds.has(v.id)||v.configSetId!==row.sourceConfigId||v.modelVersion!==1||!Number.isSafeInteger(v.versionNumber)||v.versionNumber<1||numbers.has(v.versionNumber)||typeof v.rawInput!=='string'||Buffer.byteLength(v.rawInput)>1024*1024||!['json','yaml','env-json'].includes(v.inputFormat)||!object(v.options)||!object(v.itemMetadata)||Object.values(v.itemMetadata).some(x=>typeof x!=='boolean')||!validDate(v.createdAt)||v.editedAt!=null&&!validDate(v.editedAt)||v.submittedAt!=null&&!validDate(v.submittedAt)||v.editedByUsername!=null&&(typeof v.editedByUsername!=='string'||v.editedByUsername.length>64)||v.submittedByUsername!=null&&(typeof v.submittedByUsername!=='string'||v.submittedByUsername.length>64))fail(400,'待映射版本无效');globalVersionIds.add(v.id);versions.set(v.id,v);numbers.add(v.versionNumber);
      try{const parsed=parseInput(v.rawInput,v.inputFormat,v.options.coerce===true),possible=row.type?[row.type]:['json','k8s-env'];if(!possible.some(kind=>parsed.kind===kind&&contentHash(kind,parsed.data)===v.contentHash&&contentHash(kind,v.normalizedContent)===v.contentHash))fail(400,'旧版本内容摘要不匹配');}catch{fail(400,'旧版本内容摘要不匹配');}
    }
    if(versions.size){const highest=Math.max(...numbers),latest=versions.get(row.latestVersionId);if(!latest||latest.versionNumber!==highest||!Number.isSafeInteger(row.nextVersionNumber)||row.nextVersionNumber<=highest)fail(400,'旧版本指针或编号无效');}
    for(const v of row.versions)if(v.restoredFromVersionId&&(!versions.has(v.restoredFromVersionId)||versions.get(v.restoredFromVersionId).versionNumber>=v.versionNumber))fail(400,'旧恢复来源无效');
    const draftIds=new Set();for(const d of [...row.drafts,...row.recoveryDrafts]){if(!object(d)||d.configSetId!==row.sourceConfigId||typeof d.rawInput!=='string'||Buffer.byteLength(d.rawInput)>1024*1024||!['json','yaml','env-json'].includes(d.inputFormat)||!object(d.options)||d.baseVersionId&&!versions.has(d.baseVersionId))fail(400,'待映射恢复资料无效');if(d.id){if(draftIds.has(d.id))fail(400,'恢复资料 ID 重复');draftIds.add(d.id);}}
  }
  const check={...pkg};delete check.digest;if(pkg.digest!==digest(check))fail(400,'待映射包摘要无效');
}
function revision(value,expected){if(expected!==value)fail(409,'数据已被其他用户修改，请重新载入');}
function snapshot(state,data){return Object.fromEntries(kinds.map((kind,i)=>[kind,state.dictionaries[kind].find(x=>x.id===data[['regionId','environmentTypeId','configNameId'][i]])?.label]));}
function validTriple(state,data){
  const ids=[data.regionId,data.environmentTypeId,data.configNameId];
  for(let i=0;i<3;i++)if(!state.dictionaries[kinds[i]].some(x=>x.id===ids[i]&&x.enabled&&!x.deletedAt))fail(409,'环境选项已停用、删除或不存在');
  if(!state.bindings.some(x=>triple(x)===triple(data)&&x.enabled&&!x.deletedAt))fail(409,'配置组合已删除或未启用');
}
function metadata(data){
  string(data.description,10000,true);string(data.note,2000,true);string(data.requestId,120);
  if(!Array.isArray(data.tags)||data.tags.length>100||data.tags.some(t=>typeof t!=='string'||t.length>120))fail(400,'标签无效');
  if(!object(data.itemMetadata)||Object.keys(data.itemMetadata).length>5000||Object.entries(data.itemMetadata).some(([k,v])=>k.length>1000||typeof v!=='boolean'))fail(400,'敏感标记无效');
}
export function backupValidate(pkg){
  if(!object(pkg)||![3,4].includes(pkg.schemaVersion)||pkg.redacted!==false||!['configs','versions'].includes(pkg.exportKind)||!object(pkg.dictionaries)||!Array.isArray(pkg.bindings)||!Array.isArray(pkg.configs)||!Array.isArray(pkg.versions))fail(400,'备份格式无效或脱敏包不可恢复');
  if(!object(pkg.settings)||Object.keys(pkg.settings).some(k=>k!=='expiryWarningDays')||!Number.isInteger(pkg.settings.expiryWarningDays)||pkg.settings.expiryWarningDays<0||pkg.settings.expiryWarningDays>3650)fail(400,'备份设置无效');
  if(!object(pkg.counts)||pkg.counts.configs!==pkg.configs.length||pkg.counts.versions!==pkg.versions.length)fail(400,'备份数量不匹配');
  validateVersionTags(pkg.versionTags??[],pkg.versions);
  if(pkg.schemaVersion===4&&!Array.isArray(pkg.versionTags))fail(400,'缺少版本 tag 集合');
  const recovery=pkg.recoveryDrafts??[];if(!Array.isArray(recovery)||pkg.counts.recoveryDrafts!==recovery.length&&!(pkg.counts.recoveryDrafts===undefined&&recovery.length===0))fail(400,'恢复资料数量不匹配');
  for(const kind of kinds){if(!Array.isArray(pkg.dictionaries[kind]))fail(400,'字典缺失');const ids=new Set(),codes=new Set();for(const d of pkg.dictionaries[kind]){if(!object(d)||typeof d.id!=='string'||!d.id||typeof d.code!=='string'||!d.code||typeof d.label!=='string'||!d.label||typeof d.enabled!=='boolean'||!Number.isSafeInteger(d.revision)||ids.has(d.id)||codes.has(d.code))fail(400,'字典无效');ids.add(d.id);codes.add(d.code);}}
  const ids=new Set(),triples=new Set(),versionIds=new Set(),bindings=new Set(),bindingIds=new Set();
  for(const kind of kinds)for(const row of pkg.dictionaries[kind])validateDeletion(row);
  for(const row of pkg.bindings)validateDeletion(row);
  for(const b of pkg.bindings){if(!object(b)||typeof b.id!=='string'||!b.id.trim()||b.id.length>120||bindingIds.has(b.id)||bindings.has(triple(b))||typeof b.enabled!=='boolean'||!Number.isSafeInteger(b.revision))fail(400,'组合无效');bindingIds.add(b.id);bindings.add(triple(b));for(let i=0;i<3;i++)if(!pkg.dictionaries[kinds[i]].some(d=>d.id===b[['regionId','environmentTypeId','configNameId'][i]]))fail(400,'组合字典引用无效');}
  for(const c of pkg.configs){if(!object(c)||typeof c.id!=='string'||!c.id||ids.has(c.id)||triples.has(triple(c))||!bindings.has(triple(c))||!Number.isSafeInteger(c.revision)||!Number.isSafeInteger(c.nextVersionNumber)||c.nextVersionNumber<2)fail(400,'配置重复或无效');ids.add(c.id);triples.add(triple(c));for(let i=0;i<3;i++)if(!pkg.dictionaries[kinds[i]].some(d=>d.id===c[['regionId','environmentTypeId','configNameId'][i]]))fail(400,'配置字典引用无效');if(typeof c.description!=='string'||c.description.length>10000||!Array.isArray(c.tags)||c.tags.length>100||c.tags.some(t=>typeof t!=='string'||t.length>120)||!object(c.itemMetadata)||Object.values(c.itemMetadata).some(v=>typeof v!=='boolean'))fail(400,'配置元数据无效');}
  for(const v of pkg.versions){if(!object(v)||typeof v.id!=='string'||!v.id||versionIds.has(v.id)||!ids.has(v.configSetId)||typeof v.jsonContent!=='string'||!Number.isSafeInteger(v.versionNumber)||v.versionNumber<1)fail(400,'版本引用无效');const normalized=normalizeJSON(v.jsonContent);const descriptions=validateDescriptions(normalized.data,v.fieldDescriptions);if(typeof v.description!=='string'||v.description.length>10000||!Array.isArray(v.tags)||v.tags.length>100||v.tags.some(t=>typeof t!=='string'||t.length>120)||!object(v.itemMetadata)||Object.values(v.itemMetadata).some(x=>typeof x!=='boolean')||!object(v.environmentSnapshot))fail(400,'版本元数据无效');if(v.jsonContent!==normalized.jsonContent||v.contentHash!==contentHash(normalized.kind,normalized.data)||v.snapshotHash!==snapshotHash({jsonContent:normalized.jsonContent,fieldDescriptions:descriptions,itemMetadata:v.itemMetadata,description:v.description,tags:v.tags}))fail(400,'版本内容或摘要无效');versionIds.add(v.id);}
  for(const c of pkg.configs){const versions=pkg.versions.filter(v=>v.configSetId===c.id),latest=versions.find(v=>v.id===c.latestVersionId);if(!latest||latest.versionNumber!==Math.max(...versions.map(v=>v.versionNumber))||c.nextVersionNumber<=latest.versionNumber||new Set(versions.map(v=>v.versionNumber)).size!==versions.length)fail(400,'最新版本或编号无效');if(c.jsonContent!==latest.jsonContent||JSON.stringify(c.fieldDescriptions)!==JSON.stringify(latest.fieldDescriptions)||JSON.stringify(c.itemMetadata)!==JSON.stringify(latest.itemMetadata)||c.description!==latest.description||JSON.stringify(c.tags)!==JSON.stringify(latest.tags))fail(400,'配置快照与最新版本不一致');}
  for(const v of pkg.versions)if(v.restoredFromVersionId&&!pkg.versions.some(x=>x.id===v.restoredFromVersionId&&x.configSetId===v.configSetId&&x.versionNumber<v.versionNumber))fail(400,'恢复来源引用无效');
  const recoveryIds=new Set();for(const row of recovery){if(!object(row)||typeof row.id!=='string'||!row.id||recoveryIds.has(row.id)||!ids.has(row.configSetId)||typeof row.rawInput!=='string'||Buffer.byteLength(row.rawInput)>1024*1024||typeof row.reason!=='string'||!['json','yaml','env-json'].includes(row.inputFormat))fail(400,'恢复资料引用无效');recoveryIds.add(row.id);}
  const check={...pkg};delete check.digest;if(pkg.digest!==digest(check))fail(400,'备份摘要无效');
}
export class Workspace {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;this.auth=new Auth(db,clock);}
  read(){const raw=JSON.parse(this.db.prepare('SELECT data FROM workspace WHERE id=1').get().data);if([3,4].includes(raw.schemaVersion))return readSchema3(raw);if(![1,2].includes(raw.schemaVersion))fail(400,'不支持的工作空间版本');return transaction(this.db,()=>{const current=JSON.parse(this.db.prepare('SELECT data FROM workspace WHERE id=1').get().data);if([3,4].includes(current.schemaVersion))return readSchema3(current);const state=migrated(current);this.db.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(state));return state;});}
  write(s){s.revision++;this.db.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(s));}
  environmentDeletePreview(actor,data){this.auth.requireUser(actor.id,'admin');return environmentImpact(this.read(),data);}
  execute(actor,command){
    this.read();return transaction(this.db,()=>{const user=this.auth.requireUser(actor.id,'write');const response=applyWorkspaceCommand(this.read(),user,command,new Date(this.clock()).toISOString());if(response.changed)this.write(response.state);return {result:response.result,state:response.state};});
  }
  tick(){return 0;}
  export(actor,options={}){return exportWorkspaceState(this.read(),this.auth.requireUser(actor.id,'write'),options,this.clock);}
  backup(actor,id='',redacted=false){return backupWorkspaceState(this.read(),this.auth.requireUser(actor.id,'admin'),id,redacted,this.clock);}
  legacyExport(actor){return legacyWorkspaceState(this.read(),this.auth.requireUser(actor.id,'write'),this.clock);}
}

export function requireRole(user,role='write'){if(!user?.enabled||user.mustChangePassword)fail(401,'请重新登录');if(role==='admin'&&user.role!=='admin'||role==='write'&&user.role==='readonly')fail(403,'当前账号无此操作权限');return user;}
export function normalizeWorkspaceState(raw){if([3,4].includes(raw.schemaVersion))return readSchema3(raw);if([1,2].includes(raw.schemaVersion))return migrated(raw);fail(400,'不支持的工作空间版本');}
export function applyWorkspaceCommand(state,user,command,time){
  fields(command,['type','id','expectedRevision','data']);requireRole(user);
  let data=command.data??{},result=null,changed=true;
      switch(command.type){
        case 'versionTag':{result=createVersionTag(state,data,user,time);break;}
        case 'deleteVersionTag':{result=deleteVersionTag(state,data);break;}
        case 'dictionary':{
          requireRole(user,'admin');fields(data,['kind','id','code','label','enabled','remove','expectedRevision']);
          if(!kinds.includes(data.kind))fail(400,'字典类型无效');const rows=state.dictionaries[data.kind],entry=rows.find(x=>x.id===data.id);
          if(own(data,'remove'))fail(400,'请使用环境删除预览和确认流程');
          if(data.id){if(!entry||entry.deletedAt)fail(404,'字典项已删除或不存在');revision(entry.revision,data.expectedRevision);
            if(own(data,'code')&&data.code!==entry.code)fail(400,'编码不可修改');
            if(own(data,'label'))entry.label=string(data.label);if(own(data,'enabled')){if(typeof data.enabled!=='boolean')fail(400,'启用状态无效');entry.enabled=data.enabled;}
            entry.revision++;entry.updatedAt=time;entry.updatedByUserId=user.id;entry.updatedByUsername=user.username;result=entry;
          } else {string(data.code,120);string(data.label);if(rows.some(x=>x.code===data.code))fail(409,rows.some(x=>x.code===data.code&&x.deletedAt)?'编码被已删除的历史环境项占用，请使用新编码':'字典编码已存在');if(own(data,'enabled')&&typeof data.enabled!=='boolean')fail(400,'启用状态无效');result={id:randomUUID(),code:data.code,label:data.label,enabled:data.enabled!==false,revision:0,createdAt:time,updatedAt:time,updatedByUserId:user.id,updatedByUsername:user.username};rows.push(result);}
          break;
        }
        case 'binding':{
          requireRole(user,'admin');fields(data,['regionId','environmentTypeId','configNameId','enabled','expectedRevision']);for(const key of ['regionId','environmentTypeId','configNameId'])id(data[key]);if(typeof data.enabled!=='boolean')fail(400,'启用状态无效');
          for(let i=0;i<3;i++)if(!state.dictionaries[kinds[i]].some(x=>x.id===data[['regionId','environmentTypeId','configNameId'][i]]&&!x.deletedAt))fail(400,'字典项已删除或不存在');
          if(state.bindings.some(x=>triple(x)===triple(data)&&x.deletedAt))fail(409,'组合已删除，请通过批量分配重新创建');
          let binding=state.bindings.find(x=>triple(x)===triple(data));if(binding){revision(binding.revision,data.expectedRevision);binding.enabled=data.enabled;binding.revision++;binding.updatedAt=time;binding.updatedByUsername=user.username;}else{if(own(data,'expectedRevision'))fail(409,'组合已变化');binding={id:randomUUID(),regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:data.configNameId,enabled:data.enabled,revision:0,updatedAt:time,updatedByUsername:user.username};state.bindings.push(binding);}result=binding;break;
        }
        case 'bindings':{requireRole(user,'admin');result=createBindings(state,data,user,time);break;}
        case 'deleteEnvironment':{requireRole(user,'admin');result=deleteEnvironment(state,data,user,time);break;}
        case 'save':{
          fields(data,['regionId','environmentTypeId','configNameId','jsonContent','fieldDescriptions','itemMetadata','description','tags','note','requestId','restoredFromVersionId','sourceConfigId']);
          metadata(data);for(const key of ['regionId','environmentTypeId','configNameId'])id(data[key]);
          const payloadHash=digest({id:command.id??null,expectedRevision:command.expectedRevision??null,data});const receipt=state.receipts.find(x=>x.userId===user.id&&x.requestId===data.requestId);
          if(receipt){if(receipt.payloadHash!==payloadHash)fail(409,'请求编号已被其他内容使用');return {result:receipt.result,state};}
          validTriple(state,data);const existing=state.configs.find(c=>triple(c)===triple(data));
          if(existing){if(command.id!==existing.id)fail(409,'同名配置已存在，请明确确认覆盖');revision(existing.revision,command.expectedRevision);if(existing.archivedAt)fail(409,'请先恢复已归档配置');}
          else if(command.id||own(command,'expectedRevision'))fail(409,'配置已变化，请重新载入');
          if(own(data,'sourceConfigId')&&(!data.sourceConfigId||!state.configs.some(c=>c.id===data.sourceConfigId)||existing))fail(400,'复制来源无效');
          const normalized=normalizeJSON(data.jsonContent),descriptions=validateDescriptions(normalized.data,data.fieldDescriptions||{});
          const snapshotPayload={jsonContent:normalized.jsonContent,fieldDescriptions:descriptions,itemMetadata:data.itemMetadata,description:data.description,tags:data.tags};const hash=snapshotHash(snapshotPayload);
          const previous=existing&&state.versions.find(v=>v.id===existing.latestVersionId);
          if(previous?.snapshotHash===hash){result={configId:existing.id,version:previous,unchanged:true};changed=false;}
          else {const config=existing||{id:randomUUID(),regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:data.configNameId,revision:0,latestVersionId:null,nextVersionNumber:1,archivedAt:null,createdAt:time,...(data.sourceConfigId?{sourceConfigId:data.sourceConfigId}:{})};
            const version={id:randomUUID(),configSetId:config.id,versionNumber:config.nextVersionNumber++,jsonContent:normalized.jsonContent,fieldDescriptions:descriptions,itemMetadata:structuredClone(data.itemMetadata),description:data.description,tags:structuredClone(data.tags),contentHash:contentHash(normalized.kind,normalized.data),snapshotHash:hash,environmentSnapshot:snapshot(state,data),source:data.restoredFromVersionId?'restore':data.sourceConfigId?'copy':existing?'manual':'create',note:data.note,restoredFromVersionId:data.restoredFromVersionId||null,editedByUserId:user.id,editedByUsername:user.username,editedAt:time,submittedByUserId:user.id,submittedByUsername:user.username,submittedAt:time,createdAt:time,provenance:'local'};
            if(data.restoredFromVersionId&&!state.versions.some(v=>v.id===data.restoredFromVersionId&&v.configSetId===config.id))fail(400,'恢复来源版本无效');
            if(!existing)state.configs.push(config);Object.assign(config,snapshotPayload,{updatedAt:time,updatedByUserId:user.id,updatedByUsername:user.username,latestVersionId:version.id});config.revision++;state.versions.push(version);result={configId:config.id,version,unchanged:false};}
          state.receipts.push({userId:user.id,requestId:data.requestId,payloadHash,result,createdAt:time});changed=true;break;
        }
        case 'archive':case 'delete':case 'clean':{
          fields(data,command.type==='clean'?['versionIds']:[]);const config=state.configs.find(c=>c.id===command.id);if(!config)fail(404,'配置不存在');revision(config.revision,command.expectedRevision);
          if(command.type==='archive'){config.archivedAt=config.archivedAt?null:time;config.revision++;result=config;}
          if(command.type==='delete'){removeConfigs(state,new Set([config.id]));result={deleted:true};}
          if(command.type==='clean'){if(!Array.isArray(data.versionIds)||data.versionIds.some(v=>typeof v!=='string'||v===config.latestVersionId||!state.versions.some(x=>x.id===v&&x.configSetId===config.id)))fail(400,'清理版本无效，最新版本不可删除');if(state.versionTags.some(t=>data.versionIds.includes(t.versionId)))fail(409,'请先移除版本绑定的 tag');const gone=new Set(data.versionIds);state.versions=state.versions.filter(v=>!gone.has(v.id));for(const v of state.versions)if(gone.has(v.restoredFromVersionId))v.restoredFromVersionId=null;config.revision++;result={removed:data.versionIds.length};}break;
        }
        case 'discardRecovery':{fields(data,[]);const row=state.recoveryDrafts.find(x=>x.id===command.id);if(!row)fail(404,'恢复资料不存在');state.recoveryDrafts=state.recoveryDrafts.filter(x=>x.id!==row.id);result={discarded:row.id};break;}
        case 'settings':{requireRole(user,'admin');fields(data,['expiryWarningDays']);if(own(data,'expiryWarningDays')&&(!Number.isInteger(data.expiryWarningDays)||data.expiryWarningDays<0||data.expiryWarningDays>3650))fail(400,'设置无效');Object.assign(state.settings,data);result=state.settings;break;}
        case 'mapLegacy':{
          requireRole(user,'admin');fields(data,['legacyId','regionId','environmentTypeId','configNameId']);validTriple(state,data);
          const legacy=state.legacy.find(x=>x.id===data.legacyId);if(!legacy)fail(404,'待映射记录不存在');
          const pending={schemaVersion:3,exportKind:'legacy',redacted:false,legacy:[legacy],counts:{legacy:1}};pending.digest=digest(pending);validateLegacyPackage(pending);
          if(state.configs.some(c=>triple(c)===triple(data)))fail(409,'目标配置组合已存在');
          const valid=[];const invalid=[];for(const old of legacy.versions){try{
            const input=old.normalizedContent!==undefined?JSON.stringify(old.normalizedContent):typeof old.jsonContent==='string'?old.jsonContent:old.rawInput;
            const parsed=normalizeJSON(input);const desc=object(old.fieldDescriptions)?validateDescriptions(parsed.data,old.fieldDescriptions):{};
            valid.push({old,parsed,desc});
          }catch(error){invalid.push({id:old.id,reason:String(error.message),rawInput:old.rawInput??null,versionNumber:old.versionNumber});}}
          valid.sort((a,b)=>a.old.versionNumber-b.old.versionNumber);
          if(valid.some((v,i)=>!Number.isSafeInteger(v.old.versionNumber)||v.old.versionNumber<1||i&&v.old.versionNumber===valid[i-1].old.versionNumber))fail(400,'旧版本编号无效');
          if(!valid.length)fail(400,'旧配置没有可映射的有效已提交版本，可导出恢复资料');
          const config={id:legacy.sourceConfigId,regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:data.configNameId,revision:1,latestVersionId:valid.some(v=>v.old.id===legacy.latestVersionId)?legacy.latestVersionId:valid.at(-1).old.id,nextVersionNumber:Math.max(legacy.nextVersionNumber||1,...valid.map(v=>v.old.versionNumber+1)),archivedAt:legacy.archivedAt,createdAt:legacy.originalCreatedAt||legacy.createdAt,updatedAt:legacy.originalUpdatedAt||time,description:legacy.description,tags:structuredClone(legacy.tags),itemMetadata:structuredClone(legacy.itemMetadata)};
          if(state.configs.some(c=>c.id===config.id))fail(409,'旧配置 ID 冲突');
          const previousIds=new Set(valid.map(x=>x.old.id));
          for(const {old,parsed,desc} of valid){if(state.versions.some(v=>v.id===old.id))fail(409,'旧版本 ID 冲突');const itemMetadata=object(old.itemMetadata)?old.itemMetadata:legacy.itemMetadata;
            const snapshotPayload={jsonContent:parsed.jsonContent,fieldDescriptions:desc,itemMetadata,description:legacy.description,tags:legacy.tags};
            state.versions.push({id:old.id,configSetId:config.id,versionNumber:old.versionNumber,...snapshotPayload,contentHash:contentHash(parsed.kind,parsed.data),snapshotHash:snapshotHash(snapshotPayload),environmentSnapshot:snapshot(state,data),source:typeof old.source==='string'?old.source:'imported',note:typeof old.note==='string'?old.note:'',restoredFromVersionId:previousIds.has(old.restoredFromVersionId)?old.restoredFromVersionId:null,editedByUserId:null,editedByUsername:typeof old.editedByUsername==='string'?old.editedByUsername:null,editedAt:old.editedAt||old.createdAt||null,submittedByUserId:null,submittedByUsername:typeof old.submittedByUsername==='string'?old.submittedByUsername:null,submittedAt:old.submittedAt||old.createdAt||null,createdAt:old.createdAt||time,provenance:'imported',editorProvenance:'unverified',importedByUserId:user.id,importedByUsername:user.username,importedAt:time});}
          const latest=state.versions.find(v=>v.id===config.latestVersionId);Object.assign(config,{jsonContent:latest.jsonContent,fieldDescriptions:latest.fieldDescriptions,itemMetadata:latest.itemMetadata});state.configs.push(config);
          for(const row of [...legacy.drafts,...legacy.recoveryDrafts,...invalid])state.recoveryDrafts.push({id:randomUUID(),configSetId:config.id,legacyId:legacy.id,reason:row.reason||'旧未提交草稿',rawInput:typeof row.rawInput==='string'?row.rawInput:'',inputFormat:row.inputFormat||'json',createdAt:time,provenance:'imported'});
          state.legacy=state.legacy.filter(x=>x.id!==legacy.id);result={configId:config.id,versionCount:valid.length,recoveryCount:legacy.drafts.length+legacy.recoveryDrafts.length+invalid.length};break;
        }
        case 'import':{requireRole(user,'admin');fields(data,['backup','skipConflicts','importSettings','copyMappings']);if(own(data,'skipConflicts')&&typeof data.skipConflicts!=='boolean'||own(data,'importSettings')&&typeof data.importSettings!=='boolean')fail(400,'冲突选项无效');const backup=data.backup;if(!object(backup)||![1,2,3,4].includes(backup.schemaVersion))fail(400,'不支持的备份版本');if(backup.schemaVersion<3){if(data.copyMappings?.length)fail(400,'旧包需先进入待映射区');const old=validateBackup(JSON.stringify({...backup,schemaVersion:1}));const rows=legacyRows(old.workspace,{user,time});state.legacy.push(...rows);result={imported:0,legacy:rows.length};break;}
          if(backup.exportKind==='legacy'){if(data.copyMappings?.length)fail(400,'待映射包不能指定副本映射');validateLegacyPackage(backup);let legacy=0,skipped=0;for(const row of backup.legacy){if(state.legacy.some(x=>x.id===row.id||x.sourceConfigId===row.sourceConfigId)||state.configs.some(c=>c.id===row.sourceConfigId)){if(data.skipConflicts){skipped++;continue;}fail(409,'待映射记录冲突');}state.legacy.push(cleanLegacy(row));legacy++;}result={imported:0,legacy,skipped};break;}
          backupValidate(backup);let imported=0,skipped=0;for(const kind of kinds)for(const d of backup.dictionaries[kind]){const local=state.dictionaries[kind].find(x=>x.id===d.id||x.code===d.code);if(local&&(local.id!==d.id||local.code!==d.code))fail(409,'字典冲突');if(!local){requireRole(user,'admin');state.dictionaries[kind].push(pick(d,dictionaryKeys));}}
          for(const b of backup.bindings){if(state.bindings.some(x=>x.id===b.id&&triple(x)!==triple(b)))fail(409,'组合 ID 与现有组合冲突');if(!state.bindings.some(x=>triple(x)===triple(b))){requireRole(user,'admin');state.bindings.push(pick(b,bindingKeys));}}
          if(data.copyMappings!==undefined&&(!Array.isArray(data.copyMappings)||data.copyMappings.length>backup.configs.length))fail(400,'副本映射无效');const mappings=new Map();for(const row of data.copyMappings||[]){fields(row,['configId','regionId','environmentTypeId','configNameId']);if(mappings.has(row.configId)||!backup.configs.some(c=>c.id===row.configId))fail(400,'副本映射配置无效');validTriple(state,row);mappings.set(row.configId,row);}
          const assigned=new Set();for(const c of backup.configs){const mapping=mappings.get(c.id),target=mapping||c,recovery=(backup.recoveryDrafts||[]).filter(r=>r.configSetId===c.id);if(assigned.has(triple(target)))fail(409,'导入目标组合重复');assigned.add(triple(target));if(mapping){if(state.configs.some(x=>triple(x)===triple(mapping))){if(data.skipConflicts){skipped++;continue;}fail(409,'副本目标组合已存在');}const copied=pick(c,configKeys),oldId=c.id,newId=randomUUID(),ids=new Map(backup.versions.filter(v=>v.configSetId===oldId).map(v=>[v.id,randomUUID()]));Object.assign(copied,{id:newId,regionId:mapping.regionId,environmentTypeId:mapping.environmentTypeId,configNameId:mapping.configNameId,latestVersionId:ids.get(c.latestVersionId),sourceConfigId:oldId,revision:1,createdAt:time,updatedAt:time});state.configs.push(copied);for(const v of backup.versions.filter(x=>x.configSetId===oldId))state.versions.push({...pick(v,versionKeys),id:ids.get(v.id),configSetId:newId,restoredFromVersionId:v.restoredFromVersionId?ids.get(v.restoredFromVersionId)||null:null,environmentSnapshot:snapshot(state,mapping),source:'import-copy',provenance:'imported',editorProvenance:'unverified',submittedByUserId:null,editedByUserId:null,importedByUserId:user.id,importedByUsername:user.username,importedAt:time});for(const r of recovery)state.recoveryDrafts.push({...pick(r,recoveryKeys),id:randomUUID(),configSetId:newId,provenance:'imported'});for(const tag of backup.versionTags||[])if(tag.configSetId===oldId)state.versionTags.push(tagCopy(tag,{id:randomUUID(),configSetId:newId,versionId:ids.get(tag.versionId),provenance:'imported'}));imported++;continue;}
            if(state.configs.some(x=>x.id===c.id||triple(x)===triple(c))||backup.versions.some(v=>v.configSetId===c.id&&state.versions.some(x=>x.id===v.id))||recovery.some(r=>state.recoveryDrafts.some(x=>x.id===r.id))){if(data.skipConflicts){skipped++;continue;}fail(409,'导入配置冲突');}for(const tag of backup.versionTags||[])if(tag.configSetId===c.id){if(state.versionTags.some(t=>t.id===tag.id))fail(409,'tag ID 冲突');state.versionTags.push(tagCopy(tag,{provenance:'imported'}));}state.configs.push(pick(c,configKeys));for(const v of backup.versions.filter(x=>x.configSetId===c.id))state.versions.push({...pick(v,versionKeys),provenance:'imported',editorProvenance:'unverified',submittedByUserId:null,editedByUserId:null,importedByUserId:user.id,importedByUsername:user.username,importedAt:time});for(const r of recovery)state.recoveryDrafts.push({...pick(r,recoveryKeys),provenance:'imported'});imported++;}
          if(data.importSettings===true&&backup.settings){if(!object(backup.settings)||Object.keys(backup.settings).some(k=>k!=='expiryWarningDays')||!Number.isInteger(backup.settings.expiryWarningDays)||backup.settings.expiryWarningDays<0||backup.settings.expiryWarningDays>3650)fail(400,'备份设置无效');state.settings.expiryWarningDays=backup.settings.expiryWarningDays;}
          result={imported,skipped};break;}
        default:fail(400,'旧业务命令已停用，请升级页面后重试');
      }

  return {result:structuredClone(JSON.parse(JSON.stringify(result))),state,changed};
}
export function exportWorkspaceState(state,actor,{kind='versions',regionId='',environmentTypeId='',redacted=false}={},clock=Date.now){
    requireRole(actor);if(!['configs','versions'].includes(kind))fail(400,'导出类型无效');const configs=state.configs.filter(c=>(!regionId||c.regionId===regionId)&&(!environmentTypeId||c.environmentTypeId===environmentTypeId));
    const versions=kind==='versions'?state.versions.filter(v=>configs.some(c=>c.id===v.configSetId)):configs.map(c=>state.versions.find(v=>v.id===c.latestVersionId)).filter(Boolean).map(v=>({...v,restoredFromVersionId:null}));
    const ids={regions:new Set(configs.map(c=>c.regionId)),environmentTypes:new Set(configs.map(c=>c.environmentTypeId)),configNames:new Set(configs.map(c=>c.configNameId))};
    const recoveryDrafts=state.recoveryDrafts.filter(r=>configs.some(c=>c.id===r.configSetId)).map(r=>pick(r,recoveryKeys));
    const pkg={schemaVersion:4,versionTags:state.versionTags.filter(t=>versions.some(v=>v.id===t.versionId)).map(t=>tagCopy(t)),exportKind:kind,redacted,scope:{regionId,environmentTypeId},exportedAt:new Date(clock()).toISOString(),exportedBy:{id:actor.id,username:actor.username},dictionaries:Object.fromEntries(kinds.map(k=>[k,state.dictionaries[k].filter(d=>ids[k].has(d.id))])),bindings:state.bindings.filter(b=>configs.some(c=>triple(c)===triple(b))),configs:structuredClone(configs),versions:structuredClone(versions),recoveryDrafts:structuredClone(recoveryDrafts),settings:{expiryWarningDays:state.settings.expiryWarningDays},counts:{configs:configs.length,versions:versions.length,recoveryDrafts:recoveryDrafts.length,archived:configs.filter(c=>c.archivedAt).length,unmapped:state.legacy.length}};
    if(redacted){pkg.recoveryDrafts=[];pkg.counts.recoveryDrafts=0;for(const v of pkg.versions){const normalized=normalizeJSON(v.jsonContent);v.jsonContent=serialize(maskConfiguration(normalized.data,v.itemMetadata),'asc');v.redacted=true;}for(const c of pkg.configs){const normalized=normalizeJSON(c.jsonContent);c.jsonContent=serialize(maskConfiguration(normalized.data,c.itemMetadata),'asc');c.redacted=true;}}pkg.digest=digest(pkg);return pkg;
  }
export function backupWorkspaceState(state,actor,id='',redacted=false,clock=Date.now){requireRole(actor,'admin');const pkg=exportWorkspaceState(state,actor,{kind:'versions',redacted},clock);if(id){if(!pkg.configs.some(c=>c.id===id))fail(404,'配置不存在');pkg.configs=pkg.configs.filter(c=>c.id===id);pkg.versions=pkg.versions.filter(v=>v.configSetId===id);pkg.versionTags=pkg.versionTags.filter(t=>t.configSetId===id);pkg.recoveryDrafts=pkg.recoveryDrafts.filter(r=>r.configSetId===id);const c=pkg.configs[0];pkg.bindings=pkg.bindings.filter(b=>triple(b)===triple(c));pkg.dictionaries.regions=pkg.dictionaries.regions.filter(x=>x.id===c.regionId);pkg.dictionaries.environmentTypes=pkg.dictionaries.environmentTypes.filter(x=>x.id===c.environmentTypeId);pkg.dictionaries.configNames=pkg.dictionaries.configNames.filter(x=>x.id===c.configNameId);pkg.counts={configs:1,versions:pkg.versions.length,recoveryDrafts:pkg.recoveryDrafts.length,archived:c.archivedAt?1:0,unmapped:pkg.counts.unmapped};delete pkg.digest;pkg.digest=digest(pkg);}return pkg;}
export function legacyWorkspaceState(state,actor,clock=Date.now){requireRole(actor);const legacy=state.legacy.map(cleanLegacy),pkg={schemaVersion:3,exportKind:'legacy',redacted:false,exportedAt:new Date(clock()).toISOString(),exportedBy:{id:actor.id,username:actor.username},legacy,counts:{legacy:legacy.length}};pkg.digest=digest(pkg);return pkg;}
