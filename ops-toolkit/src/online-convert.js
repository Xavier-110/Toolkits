import {detectFormat,environmentConversion,conversionJSON} from './config-model.js';
import {$,el,button,label,select,panel,heading,dialog,download,copy} from './online-ui.js';
export function renderConvertPage({value,canWrite,oninput,save}){
  const input=el('textarea',{id:'convert-input',class:'code-editor',value,ariaLabel:'输入配置',spellcheck:false});
  const status=el('div',{id:'convert-status',class:'notice',role:'status'}),format=el('span',{id:'detected-format',class:'pill'});
  const update=()=>{oninput(input.value);try{format.textContent=detectFormat(input.value).format.toUpperCase();status.textContent='自动识别；切换格式将简单 env 与 JSON 键值对互转。';}catch(e){format.textContent=input.value.trim()?'输入无效':'暂无内容';status.textContent=input.value.trim()?e.message:'粘贴 JSON 或 YAML 配置。';}};
  input.addEventListener('input',update);update();
  const sort=select('convert-sort',[{id:'asc',label:'对象键升序'},{id:'desc',label:'对象键降序'},{id:'none',label:'保持原序'}],'asc',null);
  const confirmResult=async result=>{const warnings=[...(result.hasComments?['YAML 原生注释不会写入 JSON，可取消并移入字段说明。']:[]),...(result.confirmations||[])];return !warnings.length||await dialog('确认转换内容',[el('p',{text:warnings.join('\n')})]);};
  const formatJSON=async()=>{const result=conversionJSON(input.value,sort.value);if(!await confirmResult(result))return;input.value=result.text;update();};
  const toggle=async()=>{const result=environmentConversion(input.value,sort.value);if(!await confirmResult(result))return;input.value=result.text;update();status.textContent='切换成功：env 名称与 JSON 键对应。';};
  $('page-convert').replaceChildren(heading('JSON / YAML 自动切换','env 变量名对应 JSON 键，默认升序，保存统一为 JSON。'),panel(el('div',{class:'row'},format,label('对象排序',sort),button('加载示例',()=>{input.value='env:\n  - name: APP_NAME\n    value: demo\n  - name: PORT\n    value: "8080"\n';update();}),button('清空',()=>{input.value='';update();})),input,el('div',{class:'action-bar'},button('切换格式',toggle,'convert',{class:'primary'}),button('格式化 JSON',formatJSON),button('复制',()=>{detectFormat(input.value);return copy(input.value);}),...(canWrite()?[button('下载结果',()=>{const d=detectFormat(input.value);download(`config.${d.format}`,input.value,d.format==='yaml'?'text/yaml':'application/json');},'download-output'),button('保存配置项',async()=>{const result=conversionJSON(input.value);if(await confirmResult(result))await save(result);},'save-converted')]:[])),status));
}
