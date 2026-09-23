import {normalizeJSON,maskConfiguration,fieldRows,sensitiveField} from './config-model.js';
import {serialize,diff} from './core.js';
const escape=text=>String(text??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function metadataUnion(left,right,a={},b={}){
  const result={};
  // Resolve aliases and automatic sensitivity independently on each side.
  // Either side's effective mask protects both values in a shared report.
  for(const row of [...fieldRows(left),...fieldRows(right)]){const key=row.key||'/';result[key]=!!result[key]||sensitiveField(row.name,key,a)||sensitiveField(row.name,key,b);}
  return result;
}
function at(data,path){
  if(path==='/')return data;
  for(const part of path.slice(1).split('/').map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'))){if(data==='••••')return data;data=data?.[part];}
  return data;
}
function source(version,identity){return {configSetId:version.configSetId||version.id||'',versionId:version.current?null:version.id||'',versionNumber:version.versionNumber??null,identity:identity||version.environmentSnapshot||{},tag:version.tag||null,submittedByUsername:version.submittedByUsername||null,submittedAt:version.submittedAt||version.createdAt||null,current:!!version.current};}
export function compareSnapshots(left,right,{reveal=false,generatedBy='',generatedAt=new Date().toISOString(),leftIdentity,rightIdentity}={}){
  const a=normalizeJSON(left.jsonContent),b=normalizeJSON(right.jsonContent),metadata=metadataUnion(a.data,b.data,left.itemMetadata,right.itemMetadata);
  const rootMasked=!reveal&&(sensitiveField('$','/',left.itemMetadata)||sensitiveField('$','/',right.itemMetadata));
  const maskedA=rootMasked?'••••':maskConfiguration(a.data,metadata,reveal),maskedB=rootMasked?'••••':maskConfiguration(b.data,metadata,reveal);
  const env=a.kind==='k8s-env'&&b.kind==='k8s-env',rows=x=>Array.isArray(x)?x:x.env;
  let changes;
  if(env){
    const aa=rows(maskedA),bb=rows(maskedB);
    changes=diff(rows(a.data),rows(b.data),'k8s-env',{},true).map(row=>rootMasked?{...row,before:maskedA,after:maskedB}:row.type==='顺序调整'?row:{...row,before:aa.find(x=>x.name===row.path),after:bb.find(x=>x.name===row.path)});
  }else changes=diff(a.data,b.data,'json',{},true).map(row=>({...row,before:at(maskedA,row.path),after:at(maskedB,row.path)}));
  const descriptions=diff(left.fieldDescriptions||{},right.fieldDescriptions||{},'json',{},true);
  return {reportVersion:1,generatedAt,generatedBy,redacted:!reveal,left:source(left,leftIdentity),right:source(right,rightIdentity),counts:{content:changes.length,descriptions:descriptions.length,total:changes.length+descriptions.length},changes,descriptions,leftContent:maskedA,rightContent:maskedB};
}
export function comparisonHTML(report){
  const section=(name,value)=>`<section><h2>${escape(name)}</h2><pre>${escape(serialize(value))}</pre></section>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';base-uri 'none';form-action 'none'"><title>配置比较报告</title><style>body{font:15px system-ui;margin:32px;color:#172536;background:white}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#f2f5f7}section{break-inside:avoid}h2{font-size:18px}</style><h1>配置比较报告</h1><p>${escape(report.generatedBy)} · ${escape(report.generatedAt)} · ${report.redacted?'已脱敏':'包含原值'}</p>${section('来源',{left:report.left,right:report.right})}${section('变化计数',report.counts)}${section('内容变化',report.changes)}${section('说明变化',report.descriptions)}${section('左侧内容',report.leftContent)}${section('右侧内容',report.rightContent)}</html>`;
}
