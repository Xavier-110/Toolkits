import {el,button,label,select,panel,heading,notify,dialog,$} from './online-ui.js';
const kinds={regions:'环境 region',environmentTypes:'环境类型',configNames:'配置名称'};
const fields=['regionId','environmentTypeId','configNameId'];

export function renderEnvironmentPage({repo}){
  const admin=repo.user?.role==='admin',generation=repo.generation,selected=new Set();let busy=false;
  const host=$('page-environments'),dict=()=>repo.state.dictionaries;
  const kind=select('enum-kind',Object.entries(kinds).map(([id,label])=>({id,label})),'regions',null),code=el('input',{id:'enum-code',maxLength:120,placeholder:'稳定编码'}),name=el('input',{id:'enum-label',maxLength:120,placeholder:'显示名称'});
  const rows=el('div',{id:'enum-list'}),bindings=el('div',{id:'binding-list'});
  const region=select('binding-region',[]),type=select('binding-type',[]),names=el('div',{id:'binding-names',class:'binding-names'}),count=el('span',{id:'binding-count',role:'status'});
  const search=el('input',{id:'binding-search',type:'search',placeholder:'搜索配置名称',ariaLabel:'搜索配置名称',oninput:drawNames});
  async function act(action){
    if(busy||repo.generation!==generation)return;busy=true;
    const controls=[...host.querySelectorAll('button,input,select')].map(node=>[node,node.disabled]);for(const [node] of controls)node.disabled=true;
    try{await action();}finally{busy=false;if(repo.generation===generation){for(const [node,disabled] of controls)if(node.isConnected)node.disabled=disabled;drawNames();updateSubmit();}}
  }
  const add=button('新增枚举',()=>act(async()=>{await repo.command({type:'dictionary',data:{kind:kind.value,code:code.value,label:name.value}});code.value='';name.value='';refresh();notify('枚举已新增');}),'enum-add',{class:'primary'});
  const save=button('分配组合',()=>act(async()=>{
    const result=await repo.command({type:'bindings',data:{regionId:region.value,environmentTypeId:type.value,configNameIds:[...selected]}});
    selected.clear();refresh();notify(`组合分配完成：新增 ${result.created}，恢复 ${result.restored}，已存在 ${result.existing}（停用组合保持停用）`);
  }),'binding-save',{class:'primary'});
  function updateSubmit(){save.disabled=busy||!region.value||!type.value||!selected.size;count.textContent=`已选 ${selected.size} 项`;}
  function drawNames(){
    names.replaceChildren();const available=dict().configNames.filter(x=>x.enabled&&!x.deletedAt);
    for(const id of selected)if(!available.some(x=>x.id===id))selected.delete(id);
    for(const row of available){const checkbox=el('input',{type:'checkbox',checked:selected.has(row.id),disabled:busy||!region.value||!type.value,dataset:{configNameId:row.id},onchange:event=>{if(event.target.checked)selected.add(row.id);else selected.delete(row.id);updateSubmit();}});
      names.append(el('label',{class:'binding-choice',hidden:!`${row.label} ${row.code}`.toLowerCase().includes(search.value.toLowerCase())},checkbox,el('span',{text:`${row.label} (${row.code})`})));
    }
    updateSubmit();
  }
  function refreshChoices(){
    let invalid=false;
    for(const [node,key] of [[region,'regions'],[type,'environmentTypes']]){
      const value=node.value,items=dict()[key].filter(x=>x.enabled&&!x.deletedAt),valid=items.some(x=>x.id===value);
      node.replaceChildren(...select('',items,valid?value:'').children);node.value=valid?value:'';if(value&&!valid)invalid=true;
    }
    if(invalid)selected.clear();drawNames();
  }
  const textFor=row=>Object.keys(kinds).map((k,i)=>dict()[k].find(x=>x.id===row[fields[i]])?.label||'缺失').join(' / ');
  async function remove(target){
    for(;;){
      const preview=await repo.request('/environment-delete-preview?'+new URLSearchParams(target));
      const c=preview.counts,content=[el('p',{text:`删除 ${preview.target.label}？影响 ${c.bindings} 个组合、${c.configs} 个配置（含 ${c.archived} 个归档）、${c.versions} 个版本、${c.recoveryDrafts} 条恢复资料。`}),
        el('p',{text:c.configs?'保留配置：内容、历史和署名仍可查询导出，但该身份不能保存新版本。同步删除：上述配置、全部历史、恢复资料和保存回执将永久删除，不可撤销。':'没有关联配置，只删除环境项。'}),
        el('details',{},el('summary',{text:'查看受影响清单'}),el('ul',{},...preview.bindings.map(x=>el('li',{text:`组合：${textFor(x)}`})),...preview.configs.map(x=>el('li',{text:`配置：${textFor(x)}${x.archivedAt?'（已归档）':''} · ${x.id}`})),...preview.versions.map(x=>el('li',{text:`版本：v${x.versionNumber} · ${x.id}`})),...preview.recoveryDrafts.map(x=>el('li',{text:`恢复资料：${x.id}`}))))];
      const choice=await dialog('删除环境项',content,[{id:'environment-delete-cancel',text:'取消',value:false},{id:'environment-delete-keep',text:c.configs?'删除并保留配置':'确认删除环境项',value:'keep'},...(c.configs?[{id:'environment-delete-cascade',text:'删除并同步删除配置',value:'cascade'}]:[])]);
      if(!choice||repo.generation!==generation)return;
      try{await repo.command({type:'deleteEnvironment',data:{...target,expectedRevision:preview.targetRevision,expectedWorkspaceRevision:preview.workspaceRevision,deleteConfigs:choice==='cascade'}});refresh();notify(choice==='cascade'?'环境项及关联配置、版本已删除':'环境项已删除，已有配置已保留');return;}
      catch(error){if(error.status!==409)throw error;await repo.reload();refresh();notify('删除范围已变化，请核对最新范围并再次确认',true);}
    }
  }
  function drawRows(){
    rows.replaceChildren();for(const d of dict()[kind.value].filter(x=>!x.deletedAt)){
      const input=el('input',{value:d.label,readOnly:!admin,ariaLabel:`${d.code} 显示名`});
      rows.append(el('div',{class:'user-row',dataset:{enumId:d.id}},el('code',{text:d.code}),input,el('span',{class:'pill',text:d.enabled?'已启用':'已停用'}),...(admin?[
        button('保存名称',()=>act(async()=>{await repo.command({type:'dictionary',data:{kind:kind.value,id:d.id,label:input.value,expectedRevision:d.revision}});refresh();})),
        button(d.enabled?'停用':'启用',()=>act(async()=>{await repo.command({type:'dictionary',data:{kind:kind.value,id:d.id,enabled:!d.enabled,expectedRevision:d.revision}});refresh();})),
        button('删除',()=>act(()=>remove({targetType:'dictionary',kind:kind.value,id:d.id})),'',{class:'danger quiet'})]:[])));
    }
  }
  function drawBindings(){
    bindings.replaceChildren();for(const b of repo.state.bindings.filter(x=>!x.deletedAt))bindings.append(el('div',{class:'user-row',dataset:{bindingId:b.id}},el('span',{text:textFor(b)}),el('span',{class:'pill',text:b.enabled?'已启用':'已停用'}),...(admin?[
      button(b.enabled?'停用组合':'启用组合',()=>act(async()=>{await repo.command({type:'binding',data:{regionId:b.regionId,environmentTypeId:b.environmentTypeId,configNameId:b.configNameId,enabled:!b.enabled,expectedRevision:b.revision}});refresh();})),
      button('删除组合',()=>act(()=>remove({targetType:'binding',id:b.id})),'',{class:'danger quiet'})]:[])));
  }
  function refresh(){drawRows();drawBindings();refreshChoices();}
  kind.addEventListener('change',drawRows);for(const node of [region,type])node.addEventListener('change',()=>{selected.clear();drawNames();});
  host.replaceChildren(heading('环境信息管理','region、环境类型、配置名称由管理员统一维护；配置保存只能选择已启用组合。'),panel(el('div',{class:'toolbar'},label('字典',kind),...(admin?[label('编码',code),label('显示名',name),add]:[])),rows),panel(el('h2',{text:'有效配置组合'}),...(admin?[el('div',{class:'toolbar'},label('region',region),label('环境类型',type)),label('配置名称（可多选）',search),names,el('div',{class:'toolbar'},count,save)]:[]),bindings));refresh();
}
