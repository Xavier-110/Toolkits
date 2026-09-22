import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createService } from '../server/http.js';
const initial='Initial-Password-123', password='Changed-Password-456';
const service=createService({dbPath:':memory:'});
await service.auth.bootstrap('admin',initial);
await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:process.env.OPS_BROWSER||'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.setDefaultTimeout(8000);
const wait=async(fn,message)=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error(message);};
const nav=name=>page.locator(`[data-page="${name}"]`).click();
async function login(name,secret){await page.locator('#login-username').fill(name);await page.locator('#login-password').fill(secret);await page.locator('#login-submit').click();}
async function changeInitial(){await page.locator('#password-form').waitFor({state:'visible'});await page.locator('#old-password').fill(initial);await page.locator('#new-password').fill(password);await page.locator('#confirm-password').fill(password);await page.locator('#password-submit').click();await page.locator('#login-form').waitFor({state:'visible'});}
try {
  await page.goto(`http://127.0.0.1:${service.server.address().port}`);
  await login('admin',initial);await changeInitial();await login('admin',password);
  await wait(async()=>(await page.locator('#account-name').textContent())==='admin · admin','login');
  await nav('environments');
  for(const [kind,code,label] of [['regions','cn-east','华东'],['environmentTypes','dev','开发'],['configNames','app','应用配置']]){
    await page.locator('#enum-kind').selectOption(kind);await page.locator('#enum-code').fill(code);await page.locator('#enum-label').fill(label);await page.locator('#enum-add').click();
    await wait(()=>service.workspace.read().dictionaries?.[kind].length===1,`dictionary ${kind}`);
  }
  await page.locator('#binding-region').selectOption({index:1});await page.locator('#binding-type').selectOption({index:1});await page.locator('#binding-names input').first().check();await page.locator('#binding-save').click();
  await wait(()=>service.workspace.read().bindings.length===1,'binding');
  await nav('convert');await page.locator('#convert-input').fill('name: demo\nport: 8080\n');await page.locator('#convert').click();
  assert.equal(JSON.parse(await page.locator('#convert-input').inputValue()).port,8080);
  await page.locator('#convert').click();assert.match(await page.locator('#convert-input').inputValue(),/port: 8080/);
  await nav('configs');await page.locator('#new-config').click();
  await page.locator('#save-region').selectOption({index:1});await page.locator('#save-type').selectOption({index:1});await page.locator('#save-name').selectOption({index:1});
  await page.locator('#config-editor').fill('{"port":8080,"host":"localhost"}');await page.locator('#save-version').click();
  await wait(()=>service.workspace.read().versions.length===1,'first version');
  assert.equal(await page.locator('#config-table th').allTextContents().then(x=>x.join(',')),'配置名称,配置值,配置说明');
  await page.locator('#edit-config').click();await page.locator('#config-editor').fill('{"port":9090,"host":"localhost"}');
  await page.locator('[data-description-key="/port"]').fill('服务端口');
  await new Promise(r=>setTimeout(r,1300));assert.equal(service.workspace.read().versions.length,1);assert.equal(JSON.parse(service.workspace.read().configs[0].jsonContent).port,8080);
  await nav('versions');await page.locator('#leave-continue').click();assert.equal(await page.locator('#config-editor').inputValue(),'{"port":9090,"host":"localhost"}');
  await page.locator('#save-version').click();await wait(()=>service.workspace.read().versions.length===2,'second version');
  assert.equal(service.workspace.read().versions.at(-1).fieldDescriptions['/port'],'服务端口');
  assert.equal(service.workspace.read().versions.at(-1).submittedByUsername,'admin');
  await page.locator('#edit-config').click();await page.locator('#config-editor').fill('{"port":9999}');await nav('versions');await page.locator('#leave-discard').click();
  await page.locator('#history-config').selectOption({index:1});
  await page.locator('[data-restore]').last().click();
  assert.equal(service.workspace.read().versions.length,2,'restore only loads editor');
  await page.locator('#save-version').click();await wait(()=>service.workspace.read().versions.length===3,'restore submit');
  await nav('versions');await page.locator('#history-config').selectOption({index:1});assert.match(await page.locator('#version-list').textContent(),/提交：admin/);
  const download=page.waitForEvent('download');await page.locator('#export-versions').click();await page.locator('#confirm-ok').click();assert.match((await download).suggestedFilename(),/versions/);
  await nav('cert');await page.locator('#cert-example').click();await wait(async()=>(await page.locator('#cert-status').textContent()).includes('1项成功'),'certificate');assert.match(await page.locator('#cert-results').textContent(),/SHA-256/);
  const theme=await page.locator('html').getAttribute('data-theme');await page.locator('#theme-toggle').click();assert.notEqual(await page.locator('html').getAttribute('data-theme'),theme);
  await nav('configs');await page.locator('.config-card').first().click();await page.locator('#edit-config').click();await page.locator('#config-editor').fill('{"port":7000,"host":"localhost"}');
  await page.locator('#compare-editor').click();assert.match(await page.locator('#confirm-body').textContent(),/当前未保存编辑/);await page.locator('#confirm-ok').click();
  await page.locator('#logout').click();await page.locator('#leave-continue').click();assert.equal(await page.locator('#config-editor').inputValue(),'{"port":7000,"host":"localhost"}');
  let unload=false;page.once('dialog',async dialog=>{unload=dialog.type()==='beforeunload';await dialog.dismiss();});await page.reload({timeout:2000}).catch(()=>{});assert.equal(unload,true);assert.equal(await page.locator('#config-editor').inputValue(),'{"port":7000,"host":"localhost"}');
  // Commit reaches server but its response is lost: retry must use the same receipt.
  const beforeLost=service.workspace.read().versions.length;
  await page.route('**/api/commands',async route=>{const body=route.request().postDataJSON();if(body.type==='save'){await route.fetch();await route.abort('failed');}else await route.continue();},{times:1});
  await page.locator('#save-version').click();await wait(async()=>(await page.locator('#save-version').textContent()).includes('重试'),'lost response');assert.equal(service.workspace.read().versions.length,beforeLost+1);await page.locator('#save-version').click();await page.locator('#config-table').waitFor();assert.equal(service.workspace.read().versions.length,beforeLost+1);
  await page.locator('#edit-config').click();await page.locator('#config-editor').fill('{"port":7100,"host":"localhost"}');
  const concurrent=await page.evaluate(async()=>{const session=await fetch('/api/me').then(r=>r.json()),state=await fetch('/api/workspace').then(r=>r.json()),c=state.configs[0];const r=await fetch('/api/commands',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify({type:'save',id:c.id,expectedRevision:c.revision,data:{regionId:c.regionId,environmentTypeId:c.environmentTypeId,configNameId:c.configNameId,fieldDescriptions:c.fieldDescriptions,itemMetadata:c.itemMetadata,description:c.description,tags:c.tags,note:"concurrent",jsonContent:'{"port":7200,"host":"localhost"}',requestId:crypto.randomUUID()}})});return r.status;});assert.equal(concurrent,200);
  await page.locator('#save-version').click();await page.getByRole('button',{name:'核对最新内容并处理冲突'}).click();await page.locator('#confirm-dialog').waitFor({state:'visible'});assert.match(await page.locator('#confirm-body').textContent(),/7200/);await page.locator('#confirm-ok').click();await page.locator('#config-table').waitFor();assert.equal(JSON.parse(service.workspace.read().configs[0].jsonContent).port,7100);
  // New configuration using an existing identity requires a reviewable overwrite.
  await page.locator('#new-config').click();for(const id of ['save-region','save-type','save-name'])await page.locator('#'+id).selectOption({index:1});await page.locator('#config-editor').fill('{"port":7300,"host":"localhost"}');await page.locator('#save-version').click();await page.locator('#confirm-dialog').waitFor({state:'visible'});assert.match(await page.locator('#confirm-title').textContent(),/同名配置/);await page.locator('#confirm-cancel').click();await nav('users');await page.locator('#leave-discard').click();
  await nav('users');await page.locator('#user-name').fill('reader');await page.locator('#user-password').fill(initial);await page.locator('#user-role').selectOption('readonly');await page.locator('#user-create').click();await wait(async()=>(await page.locator('#user-list').textContent()).includes('reader'),'reader create');
  await page.locator('#user-name').fill('writer');await page.locator('#user-password').fill(initial);await page.locator('#user-role').selectOption('operate');await page.locator('#user-create').click();await wait(async()=>(await page.locator('#user-list').textContent()).includes('writer'),'writer create');
  await page.locator('#logout').click();await login('writer',initial);await changeInitial();await login('writer',password);await wait(async()=>(await page.locator('#account-name').textContent())==='writer · operate','writer login');await nav('environments');assert.equal(await page.locator('#enum-add').count(),0);await nav('configs');await page.locator('.config-card').first().click();await page.locator('#edit-config').click();await page.locator('#config-editor').fill('{"port":7400,"host":"localhost"}');await page.locator('#save-version').click();await wait(()=>service.workspace.read().versions.at(-1).submittedByUsername==='writer','operate save');
  await page.locator('#edit-config').click();await page.locator('#config-editor').fill('{"port":7500,"host":"localhost"}');await page.evaluate(async()=>{const me=await fetch('/api/me').then(r=>r.json());await fetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf},body:'{}'});});await page.locator('#save-version').click();await page.locator('#login-form').waitFor({state:'visible'});await login('writer',password);await page.locator('#config-editor').waitFor();assert.equal(await page.locator('#config-editor').inputValue(),'{"port":7500,"host":"localhost"}');await page.locator('#logout').click();await page.locator('#leave-discard').click();await page.locator('#login-form').waitFor({state:'visible'});await login('writer',password);await wait(async()=>(await page.locator('#account-name').textContent())==='writer · operate','writer second login');
  await page.locator('#logout').click();await login('reader',initial);await changeInitial();await login('reader',password);await wait(async()=>(await page.locator('#account-name').textContent())==='reader · readonly','reader login');
  await nav('configs');await page.locator('.config-card').first().click();assert.equal(await page.locator('#edit-config').count(),0);assert.equal(await page.locator('#save-version').count(),0);
  const before=service.workspace.read().revision;await nav('versions');assert.equal(service.workspace.read().revision,before);
  await mkdir('test-output/manual-online',{recursive:true});await page.screenshot({path:'test-output/manual-online/versions.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await nav('configs');await page.locator('.config-card').first().click();await page.screenshot({path:'test-output/manual-online/mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);console.log('PASS manual online: auth, enums, format toggle, table, notes, no autosave, leave protection, restore, export and readonly');
} catch(error) {console.error('UI diagnostics',errors,await page.locator('#toast').textContent());throw error;}
finally {await browser.close();await service.close();}
