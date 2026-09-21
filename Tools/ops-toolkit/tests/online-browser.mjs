import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createService } from '../server/http.js';
import { rootCertificates } from 'node:tls';
const initial='Initial-Password-123',changed='Changed-Password-456';
const service=createService({dbPath:':memory:'});const adminUser=await service.auth.bootstrap('admin',initial);
await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${service.server.address().port}`;
const browser=await chromium.launch({channel:process.env.OPS_BROWSER || 'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
const until=async(fn,message)=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(message);};
async function login(username,password) {
  await page.locator('#login-username').fill(username);await page.locator('#login-password').fill(password);await page.locator('#login-submit').click();
}
async function changeInitial() {
  await page.locator('#password-form').waitFor({state:'visible'});
  await page.locator('#old-password').fill(initial);await page.locator('#new-password').fill(changed);await page.locator('#confirm-password').fill(changed);await page.locator('#password-submit').click();
  await page.locator('#login-form').waitFor({state:'visible'});
}
const nav=pageName=>page.locator(`[data-page="${pageName}"]`).click();
try {
  await page.goto(base);await page.locator('#login-form').waitFor({state:'visible',timeout:5000});
  await mkdir('test-output/online',{recursive:true});await page.screenshot({path:'test-output/online/login.png',fullPage:true});
  await login('admin',initial);await changeInitial();await login('admin',changed);
  await until(async()=>await page.locator('#account-name').textContent()==='admin · admin','admin not ready');
  await page.locator('#theme-toggle').click();const theme=await page.locator('html').getAttribute('data-theme');
  await page.reload();await page.locator('#account-name').waitFor({state:'visible'});
  assert.equal(await page.locator('html').getAttribute('data-theme'),theme,'local theme preference persists across reload');
  await nav('users');
  for(const [username,role] of [['alice','operate'],['reader','readonly']]) {
    await page.locator('#user-name').fill(username);await page.locator('#user-password').fill(initial);await page.locator('#user-role').selectOption(role);await page.locator('#user-create').click();
    await until(async()=>(await page.locator('#user-list').textContent()).includes(username),'user not created');
  }
  await page.locator('#logout').click();await login('alice',initial);await changeInitial();await login('alice',changed);
  await nav('configs');await page.locator('#new-config').click();await page.getByLabel('配置名',{exact:true}).last().fill('在线配置');await page.locator('#modal-ok').click();
  await until(async()=>await page.locator('#config-title').textContent()==='在线配置','create failed');
  const opened=service.workspace.read().configs[0];
  service.workspace.execute({id:adminUser.id},{type:'draft',id:opened.id,expectedRevision:opened.revision,data:{draft:{rawInput:'{"APP_NAME":"other-user"}',inputFormat:'json'}}});
  await page.locator('#settings-open').click();await page.locator('#modal-ok').click();
  await until(async()=>(await page.locator('#toast').textContent()).includes('设置已更新'),'settings not saved');
  await page.locator('#config-editor').fill('{"APP_NAME":"stale-edit"}');
  await new Promise(r=>setTimeout(r,1300));
  assert.match(service.workspace.read().drafts[0].rawInput,/other-user/,'settings refresh must not let a stale editor overwrite another user');
  await page.reload();await page.locator('#account-name').waitFor({state:'visible'});await nav('configs');await page.locator('.config-card').first().click();
  await page.locator('#config-editor').fill('{"APP_NAME":"changed"}');
  await until(async()=>service.workspace.read().drafts[0]?.rawInput.includes('changed'),'draft not saved');
  await page.locator('#save-version').click();await until(async()=>service.workspace.read().versions.length===2,'archive failed');
  await page.locator('#config-history').click();
  assert.match(await page.locator('#version-list').textContent(),/最后编辑：alice/);
  assert.match(await page.locator('#version-list').textContent(),/提交：alice/);
  await page.screenshot({path:'test-output/online/versions.png',fullPage:true});
  await nav('backup');const downloaded=page.waitForEvent('download');await page.locator('#export-backup').click();assert.match((await downloaded).suggestedFilename(),/backup/);
  await page.evaluate(()=>{
    const text=File.prototype.text,bytes=File.prototype.arrayBuffer;
    File.prototype.text=function(){return new Promise(resolve=>{window.releaseBackup=()=>text.call(this).then(resolve);});};
    File.prototype.arrayBuffer=function(){return new Promise(resolve=>{window.releaseCert=()=>bytes.call(this).then(resolve);});};
  });
  await page.locator('#backup-file').setInputFiles({name:'private-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(service.workspace.backup({id:adminUser.id})))});
  await nav('cert');await page.locator('#cert-file').setInputFiles({name:'private-cert.pem',mimeType:'application/x-pem-file',buffer:Buffer.from(rootCertificates[0])});
  await until(()=>page.evaluate(()=>typeof window.releaseBackup==='function'&&typeof window.releaseCert==='function'),'file readers not pending');
  await page.locator('#logout').click();await login('reader',initial);await changeInitial();await login('reader',changed);
  await until(async()=>await page.locator('#account-name').textContent()==='reader · readonly','reader not ready');
  await page.evaluate(()=>{window.releaseBackup();window.releaseCert();});await new Promise(r=>setTimeout(r,700));
  assert.equal(await page.locator('#cert-results').textContent(),'','previous account certificate must be discarded');
  assert.equal(await page.locator('#import-backup').isDisabled(),true,'previous account backup must not become importable');
  await nav('configs');await page.locator('.config-card').first().click();
  assert.equal(await page.locator('#config-editor').getAttribute('readonly')!==null,true);
  assert.equal(await page.locator('#new-config').isVisible(),false);
  assert.equal(await page.locator('#save-version').isVisible(),false);
  assert.equal(await page.locator('[data-page="users"]').isVisible(),false);
  const before=service.workspace.read().revision;await nav('versions');await page.locator('#history-config').selectOption({index:1});
  assert.equal(await page.getByRole('button',{name:'恢复此版本'}).first().isVisible(),false);
  assert.equal(service.workspace.read().revision,before);
  await page.locator('#logout').click();await page.locator('#login-form').waitFor({state:'visible'});assert.equal(await page.locator('#config-list').textContent(),'');
  const historical=service.workspace.backup({id:adminUser.id});historical.workspace.configs[0].name='imported-config';
  service.workspace.execute({id:adminUser.id},{type:'import',data:{backup:historical}});
  await login('admin',changed);await nav('configs');await page.locator('.config-card').filter({hasText:'imported-config'}).click();
  assert.match(await page.locator('#draft-status').textContent(),/身份未验证/,'imported draft author must be marked unverified');
  assert.deepEqual(errors,[]);console.log('PASS online login, mandatory password change, user administration, operate edits, authorship, backup, readonly and logout isolation');
}catch(error){console.error('UI diagnostics',JSON.stringify({errors,toast:await page.locator('#toast').textContent(),gate:await page.locator('#login-message').textContent()}));await page.screenshot({path:'test-output/online/failure.png',fullPage:true});throw error;}
finally{await browser.close();await service.close();}
