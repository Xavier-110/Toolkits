import { randomUUID } from 'node:crypto';
import { fail } from './database.js';

const kinds=['regions','environmentTypes','configNames'];
const keys=['regionId','environmentTypeId','configNameId'];
const same=(a,b)=>keys.every(key=>a[key]===b[key]);
const identifier=value=>typeof value==='string'&&!!value.trim()&&value.length<=120;
function fields(data,allowed){if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!allowed.includes(key)))fail(400,'请求包含不支持的字段');}
export const deletionKeys=['deletedAt','deletedByUserId','deletedByUsername'];
export function validateDeletion(row){
  if(!deletionKeys.some(key=>Object.hasOwn(row,key)))return;
  if(typeof row.deletedAt!=='string'||!Number.isFinite(Date.parse(row.deletedAt))||!identifier(row.deletedByUserId)||!identifier(row.deletedByUsername)||row.enabled!==false)fail(400,'删除标记无效，已删除环境项必须停用');
}
export function createBindings(state,data,user,time){
  fields(data,['regionId','environmentTypeId','configNameIds']);
  if(!identifier(data.regionId)||!identifier(data.environmentTypeId)||!Array.isArray(data.configNameIds)||!data.configNameIds.length||data.configNameIds.length>5000||data.configNameIds.some(x=>!identifier(x)))fail(400,'请选择 region、环境类型和配置名称');
  const names=[...new Set(data.configNameIds)];
  for(const [kind,ids] of [['regions',[data.regionId]],['environmentTypes',[data.environmentTypeId]],['configNames',names]]){
    if(ids.some(id=>!state.dictionaries[kind].some(x=>x.id===id&&x.enabled&&!x.deletedAt)))fail(409,'环境选项已停用、删除或不存在，请重新选择');
  }
  const result={created:0,restored:0,existing:0};
  for(const configNameId of names){
    const identity={regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId};
    const row=state.bindings.find(x=>same(x,identity));
    if(row?.deletedAt){for(const key of deletionKeys)delete row[key];Object.assign(row,{enabled:true,revision:row.revision+1,updatedAt:time,updatedByUsername:user.username});result.restored++;}
    else if(row)result.existing++;
    else{state.bindings.push({id:randomUUID(),...identity,enabled:true,revision:0,updatedAt:time,updatedByUsername:user.username});result.created++;}
  }
  return result;
}
export function environmentImpact(state,data){
  fields(data,['targetType','kind','id']);
  if(!identifier(data.id)||!['dictionary','binding'].includes(data.targetType)||data.targetType==='dictionary'&&!kinds.includes(data.kind)||data.targetType==='binding'&&data.kind!==undefined)fail(400,'删除目标无效');
  const dictionary=data.targetType==='dictionary';
  const target=(dictionary?state.dictionaries[data.kind]:state.bindings).find(x=>x.id===data.id);
  if(!target||target.deletedAt)fail(404,'环境项已删除或不存在');
  const key=keys[kinds.indexOf(data.kind)],matches=row=>dictionary?row[key]===target.id:same(row,target);
  const bindings=state.bindings.filter(matches),configs=state.configs.filter(matches),ids=new Set(configs.map(x=>x.id));
  const versions=state.versions.filter(x=>ids.has(x.configSetId)),recoveryDrafts=state.recoveryDrafts.filter(x=>ids.has(x.configSetId));
  // Only identifiers and descriptive metadata are needed for a deletion preview.
  return {target:{...data,label:dictionary?target.label:keys.map((key,i)=>state.dictionaries[kinds[i]].find(x=>x.id===target[key])?.label||target[key]).join(' / ')},targetRevision:target.revision,workspaceRevision:state.revision,
    bindings:bindings.map(x=>({id:x.id,...Object.fromEntries(keys.map(key=>[key,x[key]])),enabled:x.enabled,deletedAt:x.deletedAt})),
    configs:configs.map(x=>({id:x.id,...Object.fromEntries(keys.map(key=>[key,x[key]])),archivedAt:x.archivedAt})),
    versions:versions.map(x=>({id:x.id,configSetId:x.configSetId,versionNumber:x.versionNumber})),
    recoveryDrafts:recoveryDrafts.map(x=>({id:x.id,configSetId:x.configSetId})),
    counts:{bindings:bindings.length,configs:configs.length,versions:versions.length,recoveryDrafts:recoveryDrafts.length,archived:configs.filter(x=>x.archivedAt).length}};
}
export function removeConfigs(state,ids){
  if(state.versionTags)state.versionTags=state.versionTags.filter(x=>!ids.has(x.configSetId));
  state.configs=state.configs.filter(x=>!ids.has(x.id));
  state.versions=state.versions.filter(x=>!ids.has(x.configSetId));
  state.recoveryDrafts=state.recoveryDrafts.filter(x=>!ids.has(x.configSetId));
  state.receipts=state.receipts.filter(x=>!ids.has(x.result?.configId));
}
export function deleteEnvironment(state,data,user,time){
  fields(data,['targetType','kind','id','expectedRevision','expectedWorkspaceRevision','deleteConfigs']);
  if(typeof data.deleteConfigs!=='boolean')fail(400,'请明确是否同步删除配置');
  const identity={targetType:data.targetType,id:data.id,...(data.kind===undefined?{}:{kind:data.kind})};
  const impact=environmentImpact(state,identity);
  if(data.expectedRevision!==impact.targetRevision||data.expectedWorkspaceRevision!==impact.workspaceRevision)fail(409,'删除范围已变化，请重新预览并确认');
  if(data.deleteConfigs)removeConfigs(state,new Set(impact.configs.map(x=>x.id)));
  const mark=row=>Object.assign(row,{enabled:false,deletedAt:time,deletedByUserId:user.id,deletedByUsername:user.username,revision:row.revision+1,updatedAt:time,updatedByUsername:user.username});
  const bindingIds=new Set(impact.bindings.map(x=>x.id));
  state.bindings=state.bindings.filter(row=>{
    if(!bindingIds.has(row.id))return true;
    if(!state.configs.some(c=>same(c,row)))return false;
    if(!row.deletedAt)mark(row);return true;
  });
  if(data.targetType==='dictionary'){
    const key=keys[kinds.indexOf(data.kind)];
    state.dictionaries[data.kind]=state.dictionaries[data.kind].filter(row=>{
      if(row.id!==data.id)return true;
      if(!state.configs.some(c=>c[key]===row.id))return false;
      mark(row);row.updatedByUserId=user.id;return true;
    });
  }
  return {deleted:true,deleteConfigs:data.deleteConfigs,counts:impact.counts};
}
