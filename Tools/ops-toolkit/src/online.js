import {ApiRepository} from './api.js';
import {mountIdentity} from './identity.js';
import {serialize,parseJSON,byteSize,diff} from './core.js';
import {normalizeJSON,detectFormat,toggleFormat,fieldRows,descriptionIssues,validateDescriptions,snapshotHash,maskConfiguration,jsonFieldLocations} from './config-model.js';
import {encodeArchive,decodeArchive} from './archive.js';
import {$,el,button,label,select,option,panel,heading,pre,time,authors,notify,dialog,download,copy} from './online-ui.js';
import {renderCertificatesPage,clearCertificates} from './online-certificates.js';
import {renderEnvironmentPage,identitySelects} from './online-environments.js';

const repo=new ApiRepository(),canWrite=()=>!!repo.user&&repo.user.role!=='readonly';
const write=()=>{if(!canWrite())throw Error('只读账号不能修改或导出');};
let pageName='convert',editor=null,held=null,busy=false,historyId='',conversion='',conversionOutput=null,importData=null,fileRun=0;
let filters={regionId:'',environmentTypeId:'',query:'',archived:false},exportFilters={regionId:'',environmentTypeId:''};
const uuid=()=>crypto.randomUUID();
const config=id=>repo.state.configs.find(c=>c.id===id);
const latest=c=>repo.state.versions.find(v=>v.id===c.latestVersionId);
const dictionaries=()=>repo.state.dictionaries||{regions:[],environmentTypes:[],configNames:[]};
const configName=c=>dictionaries().configNames.find(x=>x.id===c.configNameId)?.label||c.configName||'未命名';
const environmentDeleted=c=>!!c&&(['regions','environmentTypes','configNames'].some((kind,i)=>dictionaries()[kind].find(x=>x.id===c[['regionId','environmentTypeId','configNameId'][i]])?.deletedAt)||repo.state.bindings.some(b=>b.regionId===c.regionId&&b.environmentTypeId===c.environmentTypeId&&b.configNameId===c.configNameId&&b.deletedAt));
const configLabel=c=>`${dictionaries().regions.find(x=>x.id===c.regionId)?.label||'—'} / ${dictionaries().environmentTypes.find(x=>x.id===c.environmentTypeId)?.label||'—'} / ${configName(c)}${environmentDeleted(c)?'（关联环境已删除）':''}`;
const payload=e=>({regionId:e.regionId,environmentTypeId:e.environmentTypeId,configNameId:e.configNameId,jsonContent:e.jsonContent,fieldDescriptions:e.fieldDescriptions,itemMetadata:e.itemMetadata,description:e.description,tags:e.tags,note:e.note||'',requestId:e.requestId,...(e.restoredFromVersionId?{restoredFromVersionId:e.restoredFromVersionId}:{}),...(e.sourceConfigId?{sourceConfigId:e.sourceConfigId}:{})});
function dirty(){if(!editor)return false;if(editor.pending)return true;if(!editor.id)return true;try{return snapshotHash(payload(editor))!==editor.baseline;}catch{return true;}}
function markDirty(){if(editor){editor.requestId=uuid();editor.lastError='';}updateBadge();}
function updateBadge(){if($('draft-status')){$('draft-status').textContent=editor?.pending?'提交结果待确认':dirty()?'有未保存修改':'已保存';$('draft-status').className='pill'+(dirty()?' warning':' good');}}
function newEditor(c=null){
  const value=c?.jsonContent||'{\n  "APP_NAME": "my-service"\n}';
  return {id:c?.id||'',baseRevision:c?.revision,regionId:c?.regionId||'',environmentTypeId:c?.environmentTypeId||'',configNameId:c?.configNameId||'',jsonContent:value,fieldDescriptions:structuredClone(c?.fieldDescriptions||{}),itemMetadata:structuredClone(c?.itemMetadata||{}),description:c?.description||'',tags:[...(c?.tags||[])],note:'',requestId:uuid(),baseline:c?snapshotHash(c):null,originalData:normalizeJSON(value).data,lastValid:normalizeJSON(value).data,mode:c?'table':'edit',reveal:false,search:'',collapsed:new Set(),pending:null,restoredFromVersionId:null};
}
async function leave(){
  if(!dirty())return true;
  const result=await dialog('有未保存修改，是否放弃？',[el('p',{text:'修改尚未成为配置或版本。保存失败时会继续保留当前编辑。'})],[{id:'leave-continue',text:'继续编辑',value:'continue'},{id:'leave-discard',text:'放弃并离开',value:'discard'},{id:'leave-save',text:'保存版本后离开',value:'save'}]);
  if(result==='discard'){editor=null;return true;}
  if(result==='save')return saveEditor();
  return false;
}
async function navigate(name,{guard=true,push=true}={}){
  if(!repo.user)return false;
  if(name==='backup'&&!canWrite())throw Error('只读账号不能导入或导出');
  if(name!==pageName&&guard&&!await leave())return false;
  if(name!==pageName){editor=null;await repo.reload();}
  pageName=name;
  document.querySelectorAll('.page').forEach(node=>node.hidden=node.id!==`page-${name}`);
  document.querySelectorAll('.nav-item').forEach(node=>node.classList.toggle('active',node.dataset.page===name));
  $('crumb').textContent={convert:'JSON / YAML',cert:'证书解析',configs:'配置管理',versions:'版本归档',environments:'环境信息管理',backup:'数据备份',users:'用户管理'}[name];
  if(push)history.pushState({page:name},'',`#${name}`);
  render();return true;
}
window.opsNavigate=navigate;
window.addEventListener('popstate',async()=>{const target=location.hash.slice(1)||'convert';try{if(!await navigate(target,{push:false}))history.pushState({page:pageName},'',`#${pageName}`);}catch(e){notify(e.message,true);}});
window.addEventListener('beforeunload',event=>{if(dirty()){event.preventDefault();event.returnValue='';}});
document.querySelectorAll('[data-page]').forEach(node=>node.addEventListener('click',()=>navigate(node.dataset.page).catch(e=>notify(e.message,true))));
function render(){
  if(pageName==='convert')renderConvert();
  if(pageName==='configs')renderConfigs();
  if(pageName==='versions')renderVersions();
  if(pageName==='environments')renderEnvironmentPage({repo,notify,after:render});
  if(pageName==='backup')renderBackup();
  if(pageName==='cert')renderCertificatesPage({repo,canWrite});
}
function renderConvert(){
  const input=el('textarea',{id:'convert-input',class:'code-editor',value:conversion,ariaLabel:'输入配置',spellcheck:false});
  const status=el('div',{id:'convert-status',class:'notice',role:'status'}),format=el('span',{id:'detected-format',class:'pill'});
  const update=()=>{conversion=input.value;conversionOutput=null;try{format.textContent=detectFormat(conversion).format.toUpperCase();status.textContent='自动识别；点击切换格式才转换文本。';}catch(e){format.textContent=conversion.trim()?'输入无效':'暂无内容';status.textContent=conversion.trim()?e.message:'粘贴 JSON 或 YAML 配置。';}};
  input.addEventListener('input',update);update();
  const sort=select('convert-sort',[{id:'none',label:'保持原序'},{id:'asc',label:'对象键升序'},{id:'desc',label:'对象键降序'}],'none',null);
  const formatJSON=async()=>{const detected=detectFormat(input.value);if(detected.hasComments&&!await dialog('YAML 注释不会写入 JSON',[el('p',{text:'格式化将转换为 JSON 并移除原生注释；可取消并先保存说明。'})]))return;input.value=serialize(detected.data,sort.value);update();};
  const toggle=async()=>{const result=toggleFormat(input.value);if(result.hasComments&&!await dialog('YAML 注释不会写入 JSON',[el('p',{text:'可取消并将注释复制到字段说明；继续会只保留配置值。'})]))return;conversionOutput=result;input.value=result.text;conversion=result.text;format.textContent=result.format.toUpperCase();status.textContent=result.warnings?.join('\n')||'切换成功，类型、结构和数组顺序已保留。';};
  const save=async()=>{write();const detected=detectFormat(input.value);if(detected.hasComments&&!await dialog('保存时仅保留 JSON',[el('p',{text:'请将需要保留的 YAML 注释移入字段说明。是否继续？'})]))return;if(!await leave())return;await navigate('configs',{guard:false});editor=newEditor();editor.jsonContent=serialize(detected.data,'none');editor.lastValid=detected.data;editor.originalData=detected.data;renderConfigs();};
  $('page-convert').replaceChildren(heading('JSON / YAML 自动切换','按当前格式自动选择转换方向，保存配置时统一为 JSON。'),panel(el('div',{class:'row'},format,label('对象排序',sort),button('加载示例',()=>{input.value='env:\n  - name: APP_NAME\n    value: demo\n  - name: DB_PASSWORD\n    valueFrom:\n      secretKeyRef:\n        name: database\n        key: password\n';update();}),button('清空',()=>{input.value='';update();})),input,el('div',{class:'action-bar'},button('切换格式',toggle,'convert',{class:'primary'}),button('格式化 JSON',formatJSON),button('复制',()=>{detectFormat(input.value);return copy(input.value);}),...(canWrite()?[button('下载结果',()=>{const d=detectFormat(input.value);download(`config.${d.format}`,input.value,d.format==='yaml'?'text/yaml':'application/json');},'download-output'),button('保存配置项',save,'save-converted')]:[])),status));
}
async function selectConfig(id){if(!await leave())return;const c=config(id);editor=c?newEditor(c):null;renderConfigs();}
async function startNew(source=null){write();if(!await leave())return;editor=newEditor();if(source){Object.assign(editor,{jsonContent:source.jsonContent,fieldDescriptions:structuredClone(source.fieldDescriptions),itemMetadata:structuredClone(source.itemMetadata),description:source.description,tags:[...source.tags],sourceConfigId:source.id});editor.originalData=normalizeJSON(editor.jsonContent).data;editor.lastValid=editor.originalData;}renderConfigs();}
function renderConfigs(){
  const region=select('project-filter',dictionaries().regions,filters.regionId,'全部 region'),type=select('env-filter',dictionaries().environmentTypes,filters.environmentTypeId,'全部环境类型'),search=el('input',{id:'config-search',value:filters.query,placeholder:'配置名称、字段、说明、标签'}),archived=el('input',{type:'checkbox',checked:filters.archived,id:'show-archived'});
  const changeFilter=async()=>{const next={regionId:region.value,environmentTypeId:type.value,query:search.value,archived:archived.checked};if(editor&&dirty()&&!await leave()){renderConfigs();return;}filters=next;editor=null;renderConfigs();};
  region.onchange=changeFilter;type.onchange=changeFilter;search.onchange=changeFilter;archived.onchange=changeFilter;
  const list=el('div',{id:'config-list',class:'panel config-list'}),detail=el('div',{id:'config-detail',class:'panel'});
  function renderList(){list.replaceChildren();for(const c of repo.state.configs){if(!filters.archived&&c.archivedAt||filters.regionId&&c.regionId!==filters.regionId||filters.environmentTypeId&&c.environmentTypeId!==filters.environmentTypeId)continue;const keys=fieldRows(normalizeJSON(c.jsonContent).data).map(r=>r.name).join(' ');if(!`${configLabel(c)} ${c.description} ${c.tags.join(' ')} ${keys} ${Object.values(c.fieldDescriptions).join(' ')}`.toLowerCase().includes(filters.query.toLowerCase()))continue;list.append(button('',()=>selectConfig(c.id),'',{class:'config-card'+(editor?.id===c.id?' selected':''),text:`${configName(c)}\n${configLabel(c)}\n${c.archivedAt?'已归档':`v${latest(c)?.versionNumber||0}`}`}));}if(!list.childNodes.length)list.append(el('p',{class:'empty-state',text:'暂无匹配配置'}));}
  $('page-configs').replaceChildren(heading('配置管理','三项环境身份定位配置；打开默认表格，编辑值使用 JSON。',...(canWrite()?[button('＋ 新建配置集',()=>startNew(),'new-config',{class:'primary'}),button('按环境导出',()=>exportDialog('configs'),'export-configs')]:[])),panel(el('div',{class:'toolbar'},label('查找配置',search),label('环境 region',region),label('环境类型',type),label('显示归档',archived))),el('div',{class:'config-layout'},list,detail));renderList();
  if(!editor){detail.append(el('div',{class:'empty-state',text:'选择配置查看，或创建新配置。'}));return;}
  renderEditor(detail);
}
function renderEditor(host){
  const e=editor,c=config(e.id),writable=canWrite()&&!c?.archivedAt&&!environmentDeleted(c)&&!e.pending;
  const title=el('h2',{id:'config-title',text:c?configName(c):'新建配置'});
  host.append(el('div',{class:'panel-title'},title,el('span',{id:'draft-status',class:'pill'})),el('div',{class:'panel-body',id:'editor-body'}));const body=$('editor-body');
  if(!c){const identity=identitySelects(repo,e,()=>{markDirty();},'save');if(e.pending)identity.querySelectorAll('input,select').forEach(node=>node.disabled=true);body.append(identity);}
  else body.append(el('p',{text:configLabel(c)}),el('p',{class:'authorship',text:authors(latest(c)||{})}));
  if(environmentDeleted(c))body.append(el('p',{id:'environment-deleted-notice',class:'notice warning',text:'关联环境已删除。内容和历史仍可查看、比较和导出；请复制到有效环境后继续维护。'}));
  const controls=el('div',{class:'row'});
  if(c)controls.append(button('与历史版本比较',()=>compareEditor(e),'compare-editor'));
  if(writable)controls.append(button(e.mode==='table'?'编辑配置（JSON）':'返回表格',async()=>{if(e.mode==='edit'&&dirty()){if(!await leave())return;if(!editor){editor=newEditor(c);}}editor.mode=editor.mode==='table'?'edit':'table';renderConfigs();},'edit-config'));
  const reveal=el('input',{type:'checkbox',checked:e.reveal,id:'config-reveal',onchange:()=>{e.reveal=reveal.checked;renderConfigs();}});controls.append(label('显示并编辑敏感内容',reveal));body.append(controls);
  const parsed=()=>{try{const result=normalizeJSON(e.jsonContent);e.lastValid=result.data;return result;}catch{return null;}};
  const value=parsed(),masked=maskConfiguration(e.lastValid,e.itemMetadata,e.reveal),hasMask=serialize(masked,'asc',0)!==serialize(e.lastValid,'asc',0);
  if(e.mode==='edit'){
    const area=el('textarea',{id:'config-editor',class:'code-editor config-editor',value:hasMask?serialize(masked):e.jsonContent,readOnly:!writable||hasMask,spellcheck:false,ariaLabel:'配置内容 JSON'});
    const descriptions=el('aside',{id:'description-panel',class:'description-panel'}),validation=el('div',{id:'config-validation',class:'notice',role:'status'});
    area.addEventListener('input',()=>{e.jsonContent=area.value;markDirty();const ok=parsed();validation.textContent=ok?'严格 JSON 校验通过，修改尚未保存。':'JSON 暂时无效；说明基于上次有效结构，位置可能已变化。';renderDescriptions(descriptions,e,writable);});
    const locate=()=>{try{const rows=[...descriptions.querySelectorAll('[data-field-key]')],visibleKeys=new Set(rows.map(row=>row.dataset.fieldKey));const matches=[...jsonFieldLocations(area.value)].map(([key,v])=>[key,pairLocation(v)]).filter(([key,v])=>visibleKeys.has(key)&&area.selectionStart>=v.start&&area.selectionStart<v.end).sort((a,b)=>(a[1].end-a[1].start)-(b[1].end-b[1].start));for(const row of rows)row.classList.toggle('field-active',row.dataset.fieldKey===matches[0]?.[0]);}catch{}};area.addEventListener('click',locate);area.addEventListener('keyup',locate);
    const drawer=el('details',{class:'description-drawer',open:true},el('summary',{text:'字段说明（可展开／收起）'}),descriptions);
    body.append(el('div',{class:'json-notes-layout'},area,drawer),validation);validation.textContent=hasMask?'勾选显示敏感内容后可编辑原值。':value?'严格 JSON 编辑；字段说明单独保存。':'基于上次有效结构，位置可能已变化。';renderDescriptions(descriptions,e,writable);
  }else renderTable(body,e,writable);
  if(writable){
    const description=el('input',{value:e.description,maxLength:10000,oninput:event=>{e.description=event.target.value;markDirty();}}),tags=el('input',{value:e.tags.join(', '),oninput:event=>{e.tags=event.target.value.split(/[,，]/).map(x=>x.trim()).filter(Boolean);markDirty();}}),meta=el('textarea',{rows:3,value:Object.entries(e.itemMetadata).map(([key,v])=>(v?'':'!')+key).join('\n'),oninput:event=>{e.itemMetadata=Object.fromEntries(event.target.value.split('\n').map(s=>s.trim()).filter(Boolean).map(s=>[s.startsWith('!')?s.slice(1):s,!s.startsWith('!')]));markDirty();}});
    body.append(el('details',{class:'metadata'},el('summary',{text:'描述、标签及敏感字段'}),label('整体描述',description),label('标签（逗号分隔）',tags),label('敏感路径／env 名称；! 前缀取消敏感',meta)));
  }
  if(canWrite()&&!c?.archivedAt&&!environmentDeleted(c)){const note=el('input',{id:'version-note',value:e.note,disabled:!!e.pending,maxLength:2000,placeholder:'版本备注（可选）',oninput:event=>{e.note=event.target.value;if(!e.pending)e.requestId=uuid();}});body.append(el('div',{class:'action-bar'},note,button(e.pending?'查询提交结果／重试':'保存版本',()=>saveEditor(),'save-version',{class:'primary',disabled:busy})));}
  if(e.lastError)body.append(el('div',{class:'notice error',text:e.lastError}),...(e.conflict?[button('核对最新内容并处理冲突',async()=>{await repo.reload();const current=config(e.id)||repo.state.configs.find(x=>sameIdentity(x,e));if(!current)throw Error('配置已删除，请复制内容后新建');if(await dialog('确认以当前编辑覆盖最新版本',[el('p',{text:authors(latest(current)||{})}),pre(serialize(maskConfiguration(normalizeJSON(current.jsonContent).data,current.itemMetadata))),pre(serialize(maskConfiguration(normalizeJSON(e.jsonContent).data,e.itemMetadata)))])){e.id=current.id;e.baseRevision=current.revision;e.conflict=false;e.requestId=uuid();e.lastError='';await saveEditor();}})]:[]));
  if(c){body.append(el('div',{class:'row border-top'},button('查看历史',async()=>{historyId=c.id;await navigate('versions');},'config-history'),...(canWrite()?[button('复制到其他环境',()=>startNew(c),'copy-config'),button(c.archivedAt?'恢复配置集':'归档配置集',async()=>{if(!await leave())return;await repo.command({type:'archive',id:c.id,expectedRevision:c.revision,data:{}});editor=newEditor(config(c.id));renderConfigs();},'archive-config'),button('删除配置集',async()=>{if(!await dialog('删除配置及全部历史',[el('p',{text:`将删除${configLabel(c)}及${repo.state.versions.filter(v=>v.configSetId===c.id).length}个版本，请先备份。`})]))return;await repo.command({type:'delete',id:c.id,expectedRevision:c.revision,data:{}});editor=null;renderConfigs();},'delete-config',{class:'danger'})]:[])));}
  updateBadge();
}
const sameIdentity=(a,b)=>a.regionId===b.regionId&&a.environmentTypeId===b.environmentTypeId&&a.configNameId===b.configNameId;
const pairLocation=span=>({start:span.pairStart??span.start,end:span.pairEnd??span.end});
function visibleRows(e){return fieldRows(maskConfiguration(e.lastValid,e.itemMetadata,e.reveal)).filter(row=>row.key!=='');}
function descriptionInput(e,row,writable){return el('textarea',{rows:2,maxLength:2000,value:e.fieldDescriptions[row.key]||'',readOnly:!writable,ariaLabel:`${row.path} 配置说明`,dataset:{descriptionKey:row.key},oninput:event=>{const text=event.target.value;if(text)e.fieldDescriptions[row.key]=text;else delete e.fieldDescriptions[row.key];markDirty();}});}
function renderTable(body,e,writable){
  const search=el('input',{placeholder:'搜索字段名称或说明',value:e.search,oninput:event=>{e.search=event.target.value;draw();}}),table=el('table',{id:'config-table',class:'config-spreadsheet'}),tbody=el('tbody');table.append(el('thead',{},el('tr',{},...['配置名称','配置值','配置说明'].map(text=>el('th',{text})))),tbody);
  function draw(){tbody.replaceChildren();for(const row of visibleRows(e)){if(!`${row.path} ${e.fieldDescriptions[row.key]||''}`.toLowerCase().includes(e.search.toLowerCase()))continue;if([...e.collapsed].some(key=>key!==row.key&&row.path.startsWith(key+'/')))continue;const container=row.value&&typeof row.value==='object';const name=el('span',{text:row.path});if(container)name.prepend(button(e.collapsed.has(row.key)?'＋':'−',()=>{e.collapsed.has(row.key)?e.collapsed.delete(row.key):e.collapsed.add(row.key);draw();},'',{ariaLabel:`展开或收起 ${row.path}`}));tbody.append(el('tr',{},el('td',{},name),el('td',{},el('small',{class:'muted',text:row.type}),pre(row.type==='reference'?serialize(row.value):container?Array.isArray(row.value)?`${row.value.length} 项`:`${Object.keys(row.value).length} 个字段`:JSON.stringify(row.value)??'缺省空值')),el('td',{},descriptionInput(e,row,writable))));}}
  body.append(search,el('div',{class:'table-scroll'},table));if(!visibleRows(e).length)body.append(el('p',{class:'notice',text:'当前 JSON 没有可填写说明的字段。'}),pre(serialize(maskConfiguration(e.lastValid,e.itemMetadata,e.reveal))));draw();
}
function renderDescriptions(host,e,writable){
  const search=el('input',{placeholder:'搜索字段说明',value:e.search}),rows=el('div');search.addEventListener('input',()=>{e.search=search.value;draw();});host.replaceChildren(search,rows);
  function draw(){rows.replaceChildren();for(const row of visibleRows(e)){if(!`${row.path} ${e.fieldDescriptions[row.key]||''}`.toLowerCase().includes(e.search.toLowerCase()))continue;const locate=()=>{const area=$('config-editor');if(!area||area.readOnly)return;try{const span=jsonFieldLocations(e.jsonContent).get(row.key);if(span){const position=pairLocation(span);area.focus();area.setSelectionRange(position.start,position.end);}}catch{notify('当前JSON无效，请先修复后定位。',true);}};rows.append(el('div',{class:'field-note',dataset:{fieldKey:row.key}},button(row.path,locate,'',{class:'link-button'}),el('small',{class:'muted',text:`${row.type} · ${(JSON.stringify(row.value)??'缺省空值').slice(0,160)}`}),descriptionInput(e,row,writable)));}if(!visibleRows(e).length)rows.append(el('p',{class:'notice',text:'当前 JSON 没有可填写说明的字段。'}));}
  draw();
}
async function resolveDescriptions(e,data){
  const issues=descriptionIssues(e.originalData,data,e.fieldDescriptions);if(!issues.length)return true;
  const rows=fieldRows(data).filter(row=>row.key!==''),choices=issues.map(key=>{const choice=select('',rows.map(r=>({id:r.key,label:r.path})),rows.some(r=>r.key===key)?key:'','清除该说明');return {key,choice,node:label(`${key||'旧整体说明'}：${e.fieldDescriptions[key]}`,choice)};});
  if(!await dialog('确认字段说明的关联',[el('p',{text:'字段删除、重命名或数组变化可能影响说明。逐项选择新字段，或清除；确认后才可提交。'}),...choices.map(x=>x.node)]))return false;
  const notes={...e.fieldDescriptions};for(const {key}of choices)delete notes[key];for(const {key,choice}of choices)if(choice.value)notes[choice.value]=e.fieldDescriptions[key];e.fieldDescriptions=notes;e.originalData=data;e.requestId=uuid();return true;
}
async function saveEditor(){
  write();if(!editor||busy)return false;const e=editor;busy=true;
  try{
    let command=e.pending;
    if(!command){const normalized=normalizeJSON(e.jsonContent);if(!await resolveDescriptions(e,normalized.data))return false;validateDescriptions(normalized.data,e.fieldDescriptions);if(!e.regionId||!e.environmentTypeId||!e.configNameId)throw Error('请选择环境 region、环境类型和配置名称');
      const existing=repo.state.configs.find(c=>sameIdentity(c,e));let id=e.id,revision=e.baseRevision;
      if(!id&&existing){if(!await dialog('同名配置已存在，是否覆盖？',[el('p',{text:`${configLabel(existing)} · v${latest(existing)?.versionNumber}\n${authors(latest(existing)||{})}`}),el('h3',{text:'已保存内容与说明'}),pre(serialize(maskConfiguration(normalizeJSON(existing.jsonContent).data,existing.itemMetadata))),pre(serialize(existing.fieldDescriptions)),el('h3',{text:'待提交内容与说明'}),pre(serialize(maskConfiguration(normalized.data,e.itemMetadata))),pre(serialize(e.fieldDescriptions))],[{id:'confirm-cancel',text:'取消',value:false},{id:'confirm-ok',text:'确认覆盖并保存版本',value:true}]))return false;id=existing.id;revision=existing.revision;}
      command={type:'save',...(id?{id,expectedRevision:revision}:{}),data:{...payload(e),jsonContent:normalized.jsonContent}};e.pending=structuredClone(command);
    }
    renderConfigs();$('editor-body')?.querySelectorAll('input,textarea,select,button').forEach(node=>node.disabled=true);
    const result=await repo.command(command);if(editor!==e)return false;editor=newEditor(config(result.configId));notify(result.unchanged?'内容未变化，未创建重复版本':`已保存 v${result.version.versionNumber} · ${result.version.submittedByUsername} · ${time(result.version.submittedAt)}`);renderConfigs();return true;
  }catch(error){if(editor===e){if(error.status){e.pending=null;e.requestId=uuid();}e.lastError=error.status?error.message:`${error.message}。提交结果待确认，请使用原请求查询／重试。`;e.conflict=error.status===409;notify(e.lastError,true);renderConfigs();}return false;}
  finally{busy=false;if($('save-version'))$('save-version').disabled=false;}
}
function environmentFilters(prefix,onchange,values=exportFilters){const r=select(`${prefix}-region`,dictionaries().regions,values.regionId,'全部 region'),t=select(`${prefix}-type`,dictionaries().environmentTypes,values.environmentTypeId,'全部环境类型');r.onchange=()=>{values.regionId=r.value;onchange?.();};t.onchange=()=>{values.environmentTypeId=t.value;onchange?.();};return el('div',{class:'row'},label('环境 region',r),label('环境类型',t));}
async function exportDialog(kind,redacted=false){
  write();const scope={regionId:pageName==='configs'?filters.regionId:exportFilters.regionId,environmentTypeId:pageName==='configs'?filters.environmentTypeId:exportFilters.environmentTypeId},status=el('p');let pkg=null,run=0;
  const refresh=async()=>{const token=++run;pkg=null;if($('confirm-ok'))$('confirm-ok').disabled=true;status.textContent='正在读取导出快照…';try{const next=await repo.request(`/export?kind=${kind}&regionId=${encodeURIComponent(scope.regionId)}&environmentTypeId=${encodeURIComponent(scope.environmentTypeId)}&redacted=${redacted}`);if(token!==run)return;pkg=next;status.textContent=`配置 ${pkg.counts.configs} 项，版本 ${pkg.counts.versions} 项，归档 ${pkg.counts.archived??pkg.configs.filter(c=>c.archivedAt).length} 项，待映射 ${pkg.counts.unmapped??repo.state.legacy?.length??0} 项。\n${pkg.configs.length?'导出全部匹配记录，不受分页或搜索限制。':'没有匹配的可导出记录。'}\n${redacted?'脱敏包不能恢复。':'文件包含配置原值，请妥善保管。'}`;if($('confirm-ok'))$('confirm-ok').disabled=!pkg.configs.length;}catch(error){if(token===run)status.textContent=error.message;}};
  await refresh();const answer=dialog(redacted?'下载脱敏分享':'确认导出完整原值',[environmentFilters('export',refresh,scope),status]);$('confirm-ok').disabled=!pkg?.configs.length;if(!await answer||!pkg)return;run++;const archive=encodeArchive(pkg);download(`ops-toolkit-${kind}.${archive.type==='application/zip'?'zip':'json'}`,archive.bytes,archive.type);
}
function comparison(a,b,reveal){
  const left=normalizeJSON(a.jsonContent),right=normalizeJSON(b.jsonContent),metadata={};for(const source of [a.itemMetadata,b.itemMetadata])for(const [key,value]of Object.entries(source||{}))metadata[key]=metadata[key]===true||value;
  const aa=maskConfiguration(left.data,metadata,reveal),bb=maskConfiguration(right.data,metadata,reveal),env=left.kind==='k8s-env'&&right.kind==='k8s-env';
  return [el('div',{class:'editor-grid'},el('div',{},pre(authors(a)),pre(serialize(aa))),el('div',{},pre(b.current?`当前未保存编辑 · ${repo.user.username}`:authors(b)),pre(serialize(bb)))),el('h3',{text:'内容变化'}),pre(serialize(diff(env?(Array.isArray(aa)?aa:aa.env):aa,env?(Array.isArray(bb)?bb:bb.env):bb,env?'k8s-env':'json',{},true))),el('h3',{text:'说明变化'}),pre(serialize(diff(a.fieldDescriptions,b.fieldDescriptions,'json',{},true)))];
}
async function compareEditor(e){
  normalizeJSON(e.jsonContent);const versions=repo.state.versions.filter(v=>v.configSetId===e.id).sort((a,b)=>b.versionNumber-a.versionNumber),choice=select('editor-diff-version',versions.map(v=>({id:v.id,label:`v${v.versionNumber}`})),versions[0]?.id,null),reveal=el('input',{type:'checkbox',id:'editor-diff-reveal'}),result=el('div');
  const draw=()=>{const version=versions.find(v=>v.id===choice.value);if(version)result.replaceChildren(...comparison(version,{...e,current:true},reveal.checked));};choice.onchange=draw;reveal.onchange=draw;draw();await dialog('历史与当前编辑比较',[label('历史版本',choice),label('显示敏感内容',reveal),result],[{id:'confirm-ok',text:'返回编辑',value:true}]);
}
function renderVersions(){
  const visible=repo.state.configs.filter(c=>(!exportFilters.regionId||c.regionId===exportFilters.regionId)&&(!exportFilters.environmentTypeId||c.environmentTypeId===exportFilters.environmentTypeId));
  const chooser=select('history-config',visible.map(c=>({id:c.id,label:configLabel(c)})),historyId,'选择配置集');chooser.onchange=()=>{historyId=chooser.value;renderVersions();};
  const versions=repo.state.versions.filter(v=>v.configSetId===historyId).sort((a,b)=>b.versionNumber-a.versionNumber),list=el('div',{id:'version-list',class:'panel timeline'});
  for(const version of versions){const card=el('div',{class:'version-entry'},el('h3',{text:`v${version.versionNumber} · ${version.note||version.source}`}),el('p',{class:'authorship',text:authors(version)}));if(canWrite())card.append(button('恢复此版本',async()=>{if(!await leave())return;await navigate('configs',{guard:false});editor=newEditor(config(version.configSetId));Object.assign(editor,{jsonContent:version.jsonContent,fieldDescriptions:structuredClone(version.fieldDescriptions),itemMetadata:structuredClone(version.itemMetadata),description:version.description||'',tags:[...(version.tags||[])],restoredFromVersionId:version.id,mode:'edit'});editor.lastValid=normalizeJSON(version.jsonContent).data;editor.originalData=editor.lastValid;renderConfigs();notify('历史内容已载入，尚未保存。');},'',{dataset:{restore:version.id}}));list.append(card);}
  const left=select('diff-left',versions.map(v=>({id:v.id,label:`v${v.versionNumber}`})),versions[1]?.id||versions[0]?.id,null),right=select('diff-right',versions.map(v=>({id:v.id,label:`v${v.versionNumber}`})),versions[0]?.id,null),reveal=el('input',{id:'diff-reveal',type:'checkbox'}),result=el('div',{id:'diff-results'});
  const compare=()=>{const a=versions.find(v=>v.id===left.value),b=versions.find(v=>v.id===right.value);if(a&&b)result.replaceChildren(...comparison(a,b,reveal.checked));};
  $('page-versions').replaceChildren(heading('版本归档','历史不可变；恢复先载入编辑器，保存版本后才正式提交。',...(canWrite()?[button('按环境导出版本',()=>exportDialog('versions'),'export-versions')]:[])),panel(environmentFilters('history',()=>{historyId='';renderVersions();}),label('配置集',chooser),...(canWrite()?[button('清理旧版本',async()=>{const choices=versions.filter(v=>v.id!==config(historyId)?.latestVersionId).map(v=>({v,input:el('input',{type:'checkbox'})}));if(!choices.length)return notify('没有可清理的旧版本');if(!await dialog('选择要清理的旧版本',choices.map(({v,input})=>label(`v${v.versionNumber} · ${time(v.createdAt)}`,input))))return;const ids=choices.filter(x=>x.input.checked).map(x=>x.v.id);if(!ids.length)return;if(!await dialog('再次确认清理',[el('p',{text:`将永久清理 ${ids.length} 个旧版本，最新版本保留。`})]))return;await repo.command({type:'clean',id:historyId,data:{versionIds:ids}});renderVersions();},'clean-history')]:[])),el('div',{class:'history-layout'},list,panel(el('div',{class:'row'},label('左侧',left),label('右侧',right),label('显示敏感内容',reveal),button('比较',compare,'compare-versions')),result)));compare();
}
function renderBackup(){
  const mappings=el('div',{id:'import-mappings'}),conflicts=el('div',{id:'import-conflicts'});
  const mappingChoices=[];
  const showMappings=backup=>{mappingChoices.length=0;mappings.replaceChildren();conflicts.replaceChildren();if(backup.schemaVersion!==3)return;for(const row of backup.configs||[]){const conflict=repo.state.configs.find(c=>sameIdentity(c,row));if(conflict)conflicts.append(el('p',{text:`同名冲突：${configLabel(conflict)}；默认拒绝，可整项跳过或选择副本目标。`}));const enabled=el('input',{type:'checkbox'}),identity={regionId:'',environmentTypeId:'',configNameId:''},choices=identitySelects(repo,identity,()=>{},`import-${row.id}`);choices.hidden=true;enabled.onchange=()=>{choices.hidden=!enabled.checked;};mappings.append(el('details',{},el('summary',{text:`配置 ${row.id}：导入为副本（可选）`}),label('选择新三项身份',enabled),choices));mappingChoices.push({row,enabled,identity});}};
  const file=el('input',{type:'file',id:'backup-file',accept:'.json,.zip,application/json,application/zip'}),preview=el('div',{id:'import-preview',class:'notice',text:importData?`已读取 ${importData.name}，请确认预览后导入。`:'选择 JSON／ZIP 完整备份。旧 v1/v2 导入后需管理员映射环境。'}),skip=el('input',{type:'checkbox',id:'skip-conflicts'}),settings=el('input',{type:'checkbox',id:'import-settings'});
  const submit=button('确认导入',async()=>{write();if(!importData)return;const saved=importData,generation=repo.generation,copyMappings=mappingChoices.filter(x=>x.enabled.checked).map(x=>({configId:x.row.id,...x.identity}));if(copyMappings.some(x=>!x.regionId||!x.environmentTypeId||!x.configNameId))throw Error('请完整选择每个副本的三项身份');if(!await dialog('确认导入备份',[el('p',{text:`${saved.name}，冲突${skip.checked?'整项跳过':'阻止导入'}，${copyMappings.length} 项导入副本。历史作者标记为未验证。`})]))return;const response=await fetch(`/api/import-archive?skipConflicts=${skip.checked}&importSettings=${settings.checked}&copyMappings=${encodeURIComponent(JSON.stringify(copyMappings))}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':saved.type,'X-CSRF-Token':repo.csrf},body:saved.bytes});const value=await response.json();if(generation!==repo.generation)return;if(!response.ok){if(response.status===401)repo.clear('expired');throw Error(value.error);}repo.state=value.state;importData=null;renderBackup();notify('导入完成');},'import-backup',{disabled:!importData,class:'primary'});
  file.onchange=async()=>{const selected=file.files[0];if(!selected)return;const run=++fileRun,generation=repo.generation;try{if(selected.size>1024**3)throw Error('备份超过1GiB导入上限');const bytes=new Uint8Array(await selected.arrayBuffer());if(run!==fileRun||generation!==repo.generation)return;const backup=decodeArchive(bytes);if(![1,2,3].includes(backup.schemaVersion)||backup.redacted)throw Error('不支持此备份或脱敏包不可恢复');importData={name:selected.name,bytes,backup,type:selected.name.endsWith('.zip')?'application/zip':'application/json'};preview.textContent=`格式 v${backup.schemaVersion}，配置 ${(backup.configs||backup.workspace?.configs||[]).length} 项、版本 ${(backup.versions||backup.workspace?.versions||[]).length} 项。提交时服务端将完整校验。`;showMappings(backup);submit.disabled=false;}catch(e){importData=null;submit.disabled=true;preview.textContent=e.message;notify(e.message,true);}};
  if(importData?.backup)showMappings(importData.backup);
  const legacy=el('div',{id:'legacy-list'});for(const row of repo.state.legacy||[]){const identity={regionId:'',environmentTypeId:'',configNameId:''};const item=panel(el('h3',{text:row.configName||row.config?.name||'待映射历史'}),el('p',{text:`${row.projectName||''} / ${row.environmentName||''}`}),...(repo.user.role==='admin'?[identitySelects(repo,identity,()=>{},`legacy-${row.id}`),button('确认映射历史',async()=>{await repo.command({type:'mapLegacy',data:{legacyId:row.id,...identity}});renderBackup();notify('历史映射完成');})]:[el('p',{text:'请管理员完成环境映射'})]));legacy.append(item);}
  const recovery=el('div',{id:'recovery-list'});for(const row of repo.state.recoveryDrafts||[]){const c=config(row.configSetId);recovery.append(panel(el('h3',{text:c?configLabel(c):'历史恢复资料'}),el('p',{text:`${row.reason||'未提交内容'} · ${time(row.createdAt)}`}),button('下载原始资料',()=>download(`recovery-${row.id}.txt`,row.rawInput||'','text/plain')),button('载入修复',async()=>{if(!c)throw Error('请先完成环境映射');if(!await leave())return;await navigate('configs',{guard:false});editor=newEditor(c);try{editor.jsonContent=serialize(detectFormat(row.rawInput).data);}catch{editor.jsonContent=row.rawInput||'';}editor.mode='edit';editor.fieldDescriptions={};editor.note=`修复历史资料 ${row.id}`;renderConfigs();notify('已载入，修复后请手动保存版本；原始资料仍保留。');}),button('放弃此资料',async()=>{if(await dialog('永久放弃恢复资料',[el('p',{text:'该操作仅删除此恢复资料，请先下载需要保留的内容。'})])){await repo.command({type:'discardRecovery',id:row.id,data:{}});renderBackup();}})));}
  $('page-backup').replaceChildren(heading('数据备份与迁移','完整包保留配置和版本；旧数据明确映射后进入环境管理。'),panel(environmentFilters('backup'),el('div',{class:'action-bar'},button('下载完整备份',()=>exportDialog('versions'),'export-backup'),button('下载脱敏分享',()=>exportDialog('configs',true),'export-share'),button('导出待映射历史',async()=>{write();if(!await dialog('导出待映射原始历史',[el('p',{text:`共 ${repo.state.legacy?.length||0} 项，可能包含敏感原值。`})]))return;const data=await repo.request('/legacy-export');const archive=encodeArchive(data);download(archive.filename,archive.bytes,archive.type);}))),panel(label('备份文件',file),preview,conflicts,mappings,label('跳过同名配置（整项）',skip),label('恢复共享设置',settings),submit),heading('待映射历史',`${repo.state.legacy?.length||0} 项；不自动猜测旧项目与环境。`),legacy,heading('历史恢复资料','未提交或无效内容可下载、载入修复或明确放弃。'),recovery);
}
$('theme-toggle').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('ops-theme',document.documentElement.dataset.theme);}catch{}};
try{document.documentElement.dataset.theme=localStorage.getItem('ops-theme')||'dark';}catch{}
$('settings-open').onclick=async()=>{try{write();const days=el('input',{type:'number',min:0,max:3650,value:repo.state.settings.expiryWarningDays});if(await dialog('证书有效期预警设置',[label('提前预警天数',days)])){await repo.command({type:'settings',data:{expiryWarningDays:Number(days.value)}});notify('设置已更新');}}catch(e){notify(e.message,true);}};
mountIdentity({repo,notify,beforeLeave:leave,ready:async()=>{pageName='convert';if(held&&held.userId===repo.user.id&&canWrite()){editor=held.editor;pageName='configs';}held=null;history.replaceState({page:pageName},'',`#${pageName}`);document.querySelectorAll('.page').forEach(n=>n.hidden=n.id!==`page-${pageName}`);render();},lost:(reason,user)=>{if(reason==='expired'&&dirty()&&user)held={userId:user.id,editor};else held=null;editor=null;conversion='';conversionOutput=null;importData=null;fileRun++;clearCertificates();document.querySelectorAll('.page:not(#page-users)').forEach(n=>n.replaceChildren());if($('confirm-dialog').open)$('confirm-dialog').close();}});
