import {randomUUID} from 'node:crypto';
import {fail} from './database.js';
const validName=name=>typeof name==='string'&&name.trim().length>0&&name.trim().length<=64&&!/[\x00-\x1f\x7f]/.test(name);
export function validateVersionTags(tags,versions){
  if(!Array.isArray(tags))fail(400,'版本 tag 格式无效');
  const ids=new Set(),names=new Set();
  for(const tag of tags){
    if(!tag||typeof tag.id!=='string'||!tag.id||ids.has(tag.id)||!validName(tag.name)||tag.name!==tag.name.trim()||!Number.isSafeInteger(tag.revision)||tag.revision<0||typeof tag.createdByUsername!=='string'||!Number.isFinite(Date.parse(tag.createdAt))||!versions.some(v=>v.id===tag.versionId&&v.configSetId===tag.configSetId))fail(400,'版本 tag 或引用无效');
    const key=tag.configSetId+'\0'+tag.name.toLowerCase();if(names.has(key))fail(400,'版本 tag 名称重复');ids.add(tag.id);names.add(key);
  }
}
export function createVersionTag(state,data,user,time){
  if(!data||Object.keys(data).some(k=>!['configSetId','versionId','name'].includes(k))||!validName(data.name))fail(400,'tag 名称须为1～64字符且不能包含控制字符');
  if(!state.versions.some(v=>v.id===data.versionId&&v.configSetId===data.configSetId))fail(404,'已保存版本不存在');
  const name=data.name.trim();if(state.versionTags.some(t=>t.configSetId===data.configSetId&&t.name.toLowerCase()===name.toLowerCase()))fail(409,'同配置的 tag 已存在');
  const tag={id:randomUUID(),configSetId:data.configSetId,versionId:data.versionId,name,revision:0,createdByUserId:user.id,createdByUsername:user.username,createdAt:time};state.versionTags.push(tag);return tag;
}
export function deleteVersionTag(state,data){
  if(!data||Object.keys(data).some(k=>!['id','expectedRevision'].includes(k)))fail(400,'tag 删除参数无效');
  const row=state.versionTags.find(t=>t.id===data.id);if(!row)fail(404,'tag 不存在');
  if(row.revision!==data.expectedRevision)fail(409,'tag 已变化，请重新载入');
  state.versionTags=state.versionTags.filter(t=>t.id!==row.id);return {deleted:true};
}
export const tagCopy=(row,overrides={})=>Object.assign(Object.fromEntries(['id','configSetId','versionId','name','revision','createdByUserId','createdByUsername','createdAt','provenance'].filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]])),overrides);
