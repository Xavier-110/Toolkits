import {el,label,select} from './online-ui.js';
const kinds={regions:'环境 region',environmentTypes:'环境类型',configNames:'配置名称'};
const fields=['regionId','environmentTypeId','configNameId'];
export function identitySelects(repo,identity,changed,prefix='save'){
  const host=el('div',{class:'form-grid identity-selects'}),nodes=[];
  const dict=repo.state.dictionaries;
  function draw(){
    host.replaceChildren();nodes.length=0;
    ['regions','environmentTypes','configNames'].forEach((kind,i)=>{
      const allowed=repo.state.bindings.filter(b=>b.enabled&&!b.deletedAt&&(!i||b.regionId===identity.regionId)&&(i<2||b.environmentTypeId===identity.environmentTypeId)&&fields.every((key,j)=>dict[Object.keys(kinds)[j]].some(x=>x.id===b[key]&&x.enabled&&!x.deletedAt)));
      const items=dict[kind].filter(d=>d.enabled&&!d.deletedAt&&allowed.some(b=>b[fields[i]]===d.id));
      const node=select(`${prefix}-${['region','type','name'][i]}`,items,identity[fields[i]]);node.disabled=!!i&&!identity[fields[i-1]];node.setAttribute('aria-label',kinds[kind]);
      const search=el('input',{type:'search',placeholder:`搜索${kinds[kind]}`,ariaLabel:`搜索${kinds[kind]}`,oninput:event=>{for(const option of node.options)option.hidden=!!option.value&&!option.textContent.toLowerCase().includes(event.target.value.toLowerCase());}});
      node.addEventListener('change',()=>{identity[fields[i]]=node.value;for(let j=i+1;j<3;j++)identity[fields[j]]='';changed();draw();});nodes.push(node);host.append(label(kinds[kind],node),search);
    });
    if(!nodes[0].options.length||nodes[0].options.length===1)host.append(el('p',{class:'notice warning',text:'没有有效组合，请管理员在环境信息管理中维护三项枚举。'}));
  }
  draw();return host;
}
export {renderEnvironmentPage} from './online-environment-page.js';
