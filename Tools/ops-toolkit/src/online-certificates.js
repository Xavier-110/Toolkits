import {parseCertificates,validity} from './certificates.js';
import {serialize,byteSize,LIMITS} from './core.js';
import {$,el,button,label,panel,heading,pre,copy,download,time,notify} from './online-ui.js';
let text='',results=[],run=0;
export function clearCertificates(){text='';results=[];run++;}
export function renderCertificatesPage({repo,canWrite}){
  const input=el('textarea',{id:'cert-input',class:'code-editor cert-input',value:text,ariaLabel:'PEM证书内容',placeholder:'-----BEGIN CERTIFICATE-----'}),status=el('div',{id:'cert-status',class:'notice',role:'status',text:'证书仅在本机内存解析，不代表信任验证。'}),host=el('div',{id:'cert-results',class:'cert-results'});
  function display(){host.replaceChildren();for(const [i,item]of results.entries()){
    if(item.error){host.append(el('div',{class:'notice error',text:`第${i+1}项：${item.error}`}));continue;}
    const c=item.data,v=validity(c.notBefore,c.notAfter,repo.state.settings.expiryWarningDays);
    const rows=[['版本／序列号',`X.509 v${c.version} / ${c.serialNumber}`],['Subject',c.subject.map(x=>`${x.name}=${x.value}`).join(', ')],['Issuer',c.issuer.map(x=>`${x.name}=${x.value}`).join(', ')],['生效',`${c.notBefore}\n${time(c.notBefore)}`],['到期',`${c.notAfter}\n${time(c.notAfter)}`],['剩余',`${v.remainingDays.toFixed(2)}天 · ${v.status}`],['SAN',c.subjectAltName.length?serialize(c.subjectAltName):'未提供'],['签名算法',c.signatureAlgorithm],['签名参数',c.signatureParameters],['公钥算法／参数',`${c.publicKeyAlgorithm}\n${c.publicKeyParameters}`],['Key Usage',c.keyUsage.join(', ')],['Extended Usage',c.extendedKeyUsage.join(', ')],['Basic Constraints',c.basicConstraints?serialize(c.basicConstraints):'未提供'],['SHA-256',c.sha256],['扩展 OID',c.extensions.map(x=>`${x.oid}${x.critical?' · critical':''}`).join('\n')]];
    const list=el('dl',{class:'cert-fields'});for(const [name,value]of rows)list.append(el('dt',{text:name}),el('dd',{},button('复制',()=>copy(value||'未提供'),'',{class:'quiet'}),pre(value||'未提供')));
    host.append(panel(el('h2',{text:c.subject.find(x=>x.name==='CN')?.value||`证书${i+1}`}),el('span',{class:'pill',text:v.status}),list,...(c.warnings.length?[el('div',{class:'notice warning',text:c.warnings.join('\n')})]:[])));
  }}
  async function inspect(inputs,token=++run,generation=repo.generation){
    results=[];host.replaceChildren();
    try{
      if(inputs.reduce((n,x)=>n+(typeof x==='string'?byteSize(x):x.length),0)>LIMITS.cert)throw Error('证书合计超过5MiB');
      if(inputs.some(x=>/-----BEGIN [^-]*PRIVATE KEY-----/.test(typeof x==='string'?x:new TextDecoder().decode(x))))throw Error('输入包含私钥，已停止整批解析');
      const collected=[];
      for(let i=0;i<inputs.length;i++){try{collected.push(...await parseCertificates(inputs[i],repo.state.settings.expiryWarningDays,(done,count)=>{if(run===token)status.textContent=`文件${i+1}/${inputs.length}，证书${done}/${count}`;}));}catch(e){collected.push({error:e.message});}if(collected.length>50)throw Error('一次最多50张证书');}
      if(token!==run||generation!==repo.generation)return;results=collected;display();status.textContent=`${results.filter(x=>x.data).length}项成功，${results.filter(x=>x.error).length}项失败。未验证信任链、签名和吊销。`;
    }catch(e){if(token===run&&generation===repo.generation){status.textContent=e.message;notify(e.message,true);}}
  }
  const file=el('input',{id:'cert-file',type:'file',multiple:true,accept:'.pem,.crt,.cer,.der'});
  async function files(values){const selected=[...values],token=++run,generation=repo.generation;if(selected.length>50||selected.reduce((n,f)=>n+f.size,0)>LIMITS.cert)throw Error('最多50个文件，合计5MiB');const bytes=await Promise.all(selected.map(async f=>new Uint8Array(await f.arrayBuffer())));if(token!==run||generation!==repo.generation)return;await inspect(bytes,token,generation);}
  file.onchange=()=>files(file.files).catch(e=>notify(e.message,true));
  const drop=label('选择或拖入 PEM／DER 证书文件',file);drop.id='cert-drop';drop.className='drop-zone';drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();files(e.dataTransfer.files).catch(e=>notify(e.message,true));};
  input.oninput=()=>{text=input.value;run++;results=[];host.replaceChildren();status.textContent='输入已变化，请重新解析';};
  $('page-cert').replaceChildren(heading('证书解析','按内容识别 PEM / DER，逐项查看证书字段与有效期。'),el('div',{class:'cert-layout'},panel(drop,input,el('div',{class:'row'},button('解析证书',()=>inspect([input.value]),'parse-cert',{class:'primary'}),button('加载示例',()=>{text=input.value=__CERT_EXAMPLE__;return inspect([text]);},'cert-example'),button('清空',()=>{clearCertificates();input.value='';host.replaceChildren();status.textContent='已清空';},'clear-cert'),...(canWrite()?[button('下载信息JSON',()=>{if(!canWrite())throw Error('无导出权限');if(!results.length)throw Error('请先解析证书');download('certificate-info.json',serialize(results));},'download-cert')]:[]))),el('div',{},status,host)));display();
}
