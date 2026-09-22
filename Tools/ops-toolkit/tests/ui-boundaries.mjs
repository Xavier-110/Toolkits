import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createService } from '../server/http.js';
import { Certificate,AttributeTypeAndValue } from 'pkijs';
import { Integer,Utf8String } from 'asn1js';
import { mkdir } from 'node:fs/promises';
const service=createService({dbPath:':memory:'});let browser;const errors=[];
try{
  const user=await service.auth.bootstrap('verifier','Verifier-Initial-123'),first=await service.auth.login('verifier','Verifier-Initial-123');await service.auth.changePassword(first.token,'Verifier-Initial-123','Verifier-Changed-456');const session=await service.auth.login('verifier','Verifier-Changed-456');
  const run=(type,data)=>service.workspace.execute(user,{type,data}).result;
  const regionId=run('dictionary',{kind:'regions',code:'r',label:'R'}).id,environmentTypeId=run('dictionary',{kind:'environmentTypes',code:'e',label:'E'}).id,configNameId=run('dictionary',{kind:'configNames',code:'n',label:'N'}).id;
  run('binding',{regionId,environmentTypeId,configNameId,enabled:true});run('save',{regionId,environmentTypeId,configNameId,jsonContent:JSON.stringify({env:[{name:'NORMAL_REF',valueFrom:{configMapKeyRef:{name:'demo-config',key:'endpoint'}}}]}),fieldDescriptions:{},itemMetadata:{},description:'',tags:[],note:'',requestId:'env-reference'});
  const pairName=run('dictionary',{kind:'configNames',code:'pair',label:'Pair example'}).id;
  run('binding',{regionId,environmentTypeId,configNameId:pairName,enabled:true});
  run('save',{regionId,environmentTypeId,configNameId:pairName,jsonContent:'{"host":"localhost","port":8080}',fieldDescriptions:{'':'Historical whole document note','/host':'Hostname'},itemMetadata:{},description:'',tags:[],note:'',requestId:'pair-example'});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${service.server.address().port}`;
  browser=await chromium.launch({channel:process.env.OPS_BROWSER||'chrome',headless:true});const context=await browser.newContext();await context.addCookies([{name:'ops_session',value:session.token,url,httpOnly:true,sameSite:'Strict'}]);await context.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text;}}});});const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(url);await page.locator('#convert-input').waitFor();
  await page.locator('#convert-input').fill('"foo": bar');assert.equal(await page.locator('#detected-format').textContent(),'YAML');await page.getByRole('button',{name:'复制',exact:true}).click();assert.equal(await page.evaluate(()=>window.copied),'"foo": bar');
  await page.locator('#convert-input').fill('{"a":}');await page.getByRole('button',{name:'复制',exact:true}).click();assert.equal(await page.locator('#detected-format').textContent(),'输入无效');assert.equal(await page.evaluate(()=>window.copied),'"foo": bar');assert.notEqual(await page.locator('#toast').textContent(),'已复制');
  const yaml='foo: bar # important note';
  for(const action of [page.getByRole('button',{name:'格式化 JSON',exact:true}),page.locator('#convert'),page.locator('#save-converted')]){
    await page.locator('#convert-input').fill(yaml);await action.click();await page.locator('#confirm-dialog').waitFor({state:'visible'});await page.locator('#confirm-cancel').click();assert.equal(await page.locator('#convert-input').inputValue(),yaml);assert.equal(service.workspace.read().versions.length,2);
  }
  await page.getByRole('button',{name:'格式化 JSON',exact:true}).click();await page.locator('#confirm-ok').click();await page.waitForFunction(()=>document.getElementById('convert-input').value.trim().startsWith('{'));assert.deepEqual(JSON.parse(await page.locator('#convert-input').inputValue()),{foo:'bar'});
  await page.locator('[data-page="configs"]').click();await page.locator('.config-card').filter({hasText:'Pair example'}).click();
  assert.equal(await page.locator('#config-table tbody tr').count(),2);assert.equal(await page.locator('[data-description-key="/host"]').inputValue(),'Hostname');assert.equal(await page.locator('[data-description-key=""]').count(),0);
  assert.equal(service.workspace.read().configs.find(c=>c.configNameId===pairName).fieldDescriptions[''],'Historical whole document note','existing stored notes remain intact');
  await page.locator('.config-card').first().click();const table=await page.locator('#config-table').textContent();assert.match(table,/configMapKeyRef/);assert.match(table,/demo-config/);assert.match(table,/endpoint/);
  assert.equal(await page.locator('[data-description-key=""]').count(),0,'no root description in the table');assert.ok(!table.includes('根值'));
  await page.locator('#edit-config').click();
  const highlight=async(key,text)=>{await page.locator('#config-editor').evaluate((area,needle)=>{const offset=area.value.indexOf(needle);if(offset<0)throw Error('Missing cursor target');area.focus();area.setSelectionRange(offset+1,offset+1);area.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true}));},text);assert.equal(await page.locator('.field-note.field-active').count(),1);assert.equal(await page.locator('.field-note.field-active').getAttribute('data-field-key'),key);};
  await highlight('env:NORMAL_REF','endpoint');
  await page.locator('#config-editor').fill('{"host":"localhost","port":8080}');
  assert.equal(await page.locator('.field-note').count(),2);assert.equal(await page.locator('[data-description-key=""]').count(),0);
  await highlight('/host','"host"');await highlight('/host','localhost');await highlight('/port','"port"');await highlight('/port','8080');
  await page.locator('[data-field-key="/host"] button').click();assert.equal(await page.locator('#config-editor').evaluate(e=>e.value.slice(e.selectionStart,e.selectionEnd)),'"host":"localhost"');
  for(const end of [false,true]){await page.locator('#config-editor').evaluate((area,end)=>{const at=end?area.value.length-1:0;area.setSelectionRange(at,at);area.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true}));},end);assert.equal(await page.locator('.field-note.field-active').count(),0,'root braces have no description');}
  for(const json of ['{}','[]','null','42']){await page.locator('#config-editor').fill(json);assert.equal(await page.locator('.field-note').count(),0);assert.match(await page.locator('#description-panel').textContent(),/没有可填写说明的字段/);}
  await page.locator('#config-editor').fill(JSON.stringify([{name:'PLAIN',value:'cursor-value'},{name:'REF',valueFrom:{secretKeyRef:{name:'source',key:'nested-cursor'}}}]));
  await highlight('env:PLAIN','cursor-value');await highlight('env:REF','nested-cursor');
  const nested={one:{env:[{name:'X',value:'one'}]},two:{env:[{name:'X',value:'two'}]}};await page.locator('#config-editor').fill(JSON.stringify(nested));
  await page.locator('[data-description-key="/one/env/0/value"]').fill('first');await page.locator('[data-description-key="/two/env/0/value"]').fill('second');assert.equal(await page.locator('[data-description-key="/one/env/0/value"]').inputValue(),'first');
  await page.locator('[data-field-key="/two/env/0/value"] button').click();assert.equal(await page.locator('#config-editor').evaluate(e=>e.value.slice(e.selectionStart,e.selectionEnd)),'"value":"two"');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await mkdir('test-output/manual-online',{recursive:true});await page.screenshot({path:'test-output/manual-online/mobile-editor.png',fullPage:true});await page.locator('.description-drawer summary').click();assert.equal(await page.locator('.description-drawer').getAttribute('open'),null);
  await page.locator('[data-page="cert"]').click();await page.locator('#leave-discard').click();
  const cert=new Certificate();cert.version=2;cert.serialNumber=new Integer({value:44});cert.subject.typesAndValues.push(new AttributeTypeAndValue({type:'2.5.4.3',value:new Utf8String({value:'pss.test'})}));cert.issuer.typesAndValues=cert.subject.typesAndValues;cert.notBefore.value=new Date('2026-01-01');cert.notAfter.value=new Date('2027-01-01');const keys=await crypto.subtle.generateKey({name:'RSA-PSS',modulusLength:2048,publicExponent:Uint8Array.of(1,0,1),hash:'SHA-256'},true,['sign','verify']);await cert.subjectPublicKeyInfo.importKey(keys.publicKey);await cert.sign(keys.privateKey,'SHA-256');
  const pem=`-----BEGIN CERTIFICATE-----\n${Buffer.from(cert.toSchema().toBER(false)).toString('base64')}\n-----END CERTIFICATE-----`;await page.locator('#cert-input').fill(pem);await page.locator('#parse-cert').click();await page.getByText('Salt length: 32',{exact:false}).waitFor();const fields=page.locator('#cert-results dl');for(const name of ['SAN','Basic Constraints'])assert.match(await fields.locator('dt').filter({hasText:new RegExp(`^${name}$`)}).locator('xpath=following-sibling::dd[1]').textContent(),/未提供/);
  assert.deepEqual(errors,[]);console.log('PASS UI boundaries: all YAML comment confirmations, full valueFrom, root/bare env cursor highlighting, scoped descriptions/locations, mobile drawer, RSA-PSS parameters and absent fields');
}finally{if(browser)await browser.close();await service.close();}
