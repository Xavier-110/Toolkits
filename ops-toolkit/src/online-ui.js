export const $=id=>document.getElementById(id);
export function el(tag,props={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(props)){
    if(key.startsWith('on'))node.addEventListener(key.slice(2),event=>{Promise.resolve().then(()=>value(event)).catch(e=>notify(e.message,true));});
    else if(key==='text')node.textContent=value;
    else if(key==='class')node.className=value;
    else if(key==='dataset')Object.assign(node.dataset,value);
    else if(key==='ariaLabel')node.setAttribute('aria-label',value);
    else node[key]=value;
  }
  node.append(...children.filter(x=>x!==undefined&&x!==null));return node;
}
export const button=(text,action,id='',extra={})=>el('button',{text,onclick:action,id,...extra});
export const label=(text,input)=>el('label',{text},input);
export const option=(value,text)=>el('option',{value,text});
export function select(id,items,value='',empty='请选择'){
  const node=el('select',{id},...(empty===null?[]:[option('',empty)]),...items.map(x=>option(x.id,x.label??x.name??x.code)));
  node.value=value;return node;
}
export const panel=(...nodes)=>el('div',{class:'panel panel-body'},...nodes);
export const heading=(title,text,...actions)=>el('div',{class:'page-heading'},el('div',{},el('div',{class:'eyebrow',text:'OPS TOOLKIT · TEAM WORKSPACE'}),el('h1',{text:title}),el('p',{text})),...actions);
export const pre=text=>el('pre',{text});
export const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false,timeZoneName:'short'}):'未记录';
export const authors=v=>`最后编辑：${v.editedByUsername||'未记录'} · ${time(v.editedAt)}\n提交：${v.submittedByUsername||'未记录'} · ${time(v.submittedAt||v.createdAt)}${v.provenance==='imported'?'\n导入历史，身份未验证':''}`;
export function notify(text,error=false){$('toast').textContent=text;$('toast').className='toast'+(error?' error':'');$('toast').hidden=false;clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('toast').hidden=true,error?12000:4500);}
export function dialog(title,content,actions=[{id:'confirm-cancel',text:'取消',value:false},{id:'confirm-ok',text:'确认',value:true}]){
  const node=$('confirm-dialog');if(node.open)throw Error('请先完成当前对话框');
  $('confirm-title').textContent=title;$('confirm-body').replaceChildren(...content);node.returnValue='';
  return new Promise(resolve=>{
    let result=false;
    $('confirm-actions').replaceChildren(...actions.map(a=>button(a.text,()=>{result=a.value;node.close();},a.id,{class:a.value?'primary':''})));
    node.addEventListener('close',()=>resolve(result),{once:true});node.showModal();
  });
}
export function download(name,content,type='application/json'){
  const url=URL.createObjectURL(new Blob([content],{type})),anchor=el('a',{href:url,download:name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')});
  document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
}
export async function copy(text){try{await navigator.clipboard.writeText(text);notify('已复制');}catch{await dialog('请手动复制',[el('textarea',{value:text,readOnly:true,rows:10})],[{id:'confirm-ok',text:'关闭',value:true}]);}}
