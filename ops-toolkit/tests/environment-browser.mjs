import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createService} from '../server/http.js';

const service=createService({dbPath:':memory:'});let browser;const errors=[];
try{
  const user=await service.auth.bootstrap('admin','Initial-Password-123'),initial=await service.auth.login('admin','Initial-Password-123');
  await service.auth.changePassword(initial.token,'Initial-Password-123','Changed-Password-456');const session=await service.auth.login('admin','Changed-Password-456');
  const run=(type,data,extra={})=>service.workspace.execute(user,{type,data,...extra}).result;
  const add=(kind,code)=>run('dictionary',{kind,code,label:code}).id;
  const regionId=add('regions','cn'),otherRegion=add('regions','eu'),environmentTypeId=add('environmentTypes','prod');
  const n1=add('configNames','app'),n2=add('configNames','worker');
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${service.server.address().port}`;
  browser=await chromium.launch({channel:process.env.OPS_BROWSER||'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies([{name:'ops_session',value:session.token,url,httpOnly:true,sameSite:'Strict'}]);const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  const nav=name=>page.locator(`[data-page="${name}"]`).click();
  const wait=async(condition,message)=>{for(let i=0;i<100;i++){if(await condition())return;await new Promise(r=>setTimeout(r,30));}throw Error(message);};
  const choose=id=>page.locator(`[data-config-name-id="${id}"]`);
  const enumRow=id=>page.locator(`[data-enum-id="${id}"]`);
  const bindingRow=id=>page.locator(`[data-binding-id="${id}"]`);
  const closeDialog=async id=>{await page.locator('#'+id).click();await page.locator('#confirm-dialog').waitFor({state:'hidden'});};
  await page.goto(url);await nav('environments');
  await page.locator('#binding-region').selectOption(regionId);await page.locator('#binding-type').selectOption(environmentTypeId);await choose(n1).check();
  // Successful enum mutations update options locally without replacing either form.
  await page.locator('#enum-kind').selectOption('environmentTypes');await page.evaluate(()=>window.enumNode=document.getElementById('enum-kind'));
  for(const code of ['dev','staging']){
    await page.locator('#enum-code').fill(code);await page.locator('#enum-label').fill(code);await page.locator('#enum-add').click();
    await wait(async()=>await page.locator('#enum-code').inputValue()==='','enum saved');assert.equal(await page.locator('#enum-kind').inputValue(),'environmentTypes');
    assert.equal(await page.evaluate(()=>window.enumNode===document.getElementById('enum-kind')),true);assert.equal(await page.locator('#binding-region').inputValue(),regionId);assert.equal(await page.locator('#binding-type').inputValue(),environmentTypeId);assert.equal(await choose(n1).isChecked(),true);
  }
  await page.locator('#enum-kind').selectOption('configNames');await page.locator('#enum-code').fill('third');await page.locator('#enum-label').fill('third');
  // Hold a response so repeated clicks cannot create a duplicate.
  let release;const gate=new Promise(r=>release=r);let calls=0;
  await page.route('**/api/commands',async route=>{calls++;await gate;await route.continue();},{times:1});
  await page.locator('#enum-add').click();await wait(()=>calls===1,'pending request');assert.equal(await page.locator('#enum-add').isDisabled(),true);assert.equal(await page.locator('#enum-code').isDisabled(),true);release();
  await wait(async()=>await page.locator('#enum-code').inputValue()==='','new name saved');const n3=service.workspace.read().dictionaries.configNames.find(x=>x.code==='third').id;
  assert.equal(await page.locator('#enum-kind').inputValue(),'configNames');assert.equal(await choose(n1).isChecked(),true);assert.equal(await choose(n3).count(),1);
  await page.locator('#enum-code').fill('third');await page.locator('#enum-label').fill('retry label');await page.locator('#enum-add').click();await wait(async()=>await page.locator('#enum-add').isEnabled(),'duplicate finished');assert.equal(await page.locator('#enum-code').inputValue(),'third');assert.equal(await page.locator('#enum-label').inputValue(),'retry label');
  // Search keeps hidden selections, parent changes clear them, failures keep all selections.
  await page.locator('#binding-search').fill('worker');await choose(n2).check();assert.equal(await choose(n1).isChecked(),true);assert.match(await page.locator('#binding-count').textContent(),/2/);
  await page.locator('#binding-search').fill('');await page.locator('#binding-region').selectOption(otherRegion);assert.equal(await choose(n1).isChecked(),false);assert.equal(await choose(n2).isChecked(),false);await page.locator('#binding-region').selectOption(regionId);await choose(n1).check();await choose(n2).check();
  await page.route('**/api/commands',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试暂时失败'})}),{times:1});await page.locator('#binding-save').click();await wait(async()=>await page.locator('#binding-save').isEnabled(),'batch failure');assert.equal(await choose(n1).isChecked(),true);assert.equal(await choose(n2).isChecked(),true);assert.equal(service.workspace.read().bindings.length,0);
  await page.locator('#binding-save').click();await wait(()=>service.workspace.read().bindings.length===2,'batch created');await wait(async()=>!(await choose(n1).isChecked()),'selections cleared');assert.equal(await page.locator('#binding-region').inputValue(),regionId);assert.equal(await page.locator('#binding-type').inputValue(),environmentTypeId);
  const firstBinding=service.workspace.read().bindings.find(x=>x.configNameId===n1);await bindingRow(firstBinding.id).getByRole('button',{name:'停用组合'}).click();await wait(()=>service.workspace.read().bindings[0].enabled===false,'disabled');await choose(n1).check();await page.locator('#binding-save').click();await wait(async()=>!(await choose(n1).isChecked()),'existing returned');assert.equal(service.workspace.read().bindings[0].enabled,false);assert.match(await page.locator('#toast').textContent(),/已存在 1/);
  await bindingRow(firstBinding.id).getByRole('button',{name:'启用组合'}).click();await wait(()=>service.workspace.read().bindings[0].enabled===true,'enabled');
  const data={regionId,environmentTypeId,configNameId:n1,jsonContent:'{"port":80}',fieldDescriptions:{'/port':'端口'},itemMetadata:{},description:'',tags:[],note:'',requestId:'first'},created=run('save',data);
  const second=run('save',{...data,configNameId:n2,requestId:'worker'});await nav('configs');await nav('environments');
  // Cancel and close never write. A concurrent version forces a fresh preview and explicit second decision.
  const before=service.workspace.read();await bindingRow(firstBinding.id).getByRole('button',{name:'删除组合'}).click();await page.locator('#confirm-dialog').waitFor({state:'visible'});assert.match(await page.locator('#confirm-body').textContent(),/1 个配置.*1 个版本/s);await closeDialog('environment-delete-cancel');assert.deepEqual(service.workspace.read(),before);
  await bindingRow(firstBinding.id).getByRole('button',{name:'删除组合'}).click();await page.locator('#confirm-dialog').waitFor({state:'visible'});await page.keyboard.press('Escape');await page.locator('#confirm-dialog').waitFor({state:'hidden'});assert.deepEqual(service.workspace.read(),before);
  await bindingRow(firstBinding.id).getByRole('button',{name:'删除组合'}).click();await page.locator('#confirm-dialog').waitFor({state:'visible'});
  run('save',{...data,jsonContent:'{"port":81}',requestId:'concurrent'},{id:created.configId,expectedRevision:1});
  await page.locator('#environment-delete-keep').click();await wait(async()=>await page.locator('#confirm-dialog').isVisible()&&(await page.locator('#confirm-body').textContent()).includes('2 个版本'),'fresh deletion preview');assert.ok(!service.workspace.read().bindings[0].deletedAt);await closeDialog('environment-delete-cancel');
  await bindingRow(firstBinding.id).getByRole('button',{name:'删除组合'}).click();await closeDialog('environment-delete-keep');await wait(()=>!!service.workspace.read().bindings[0].deletedAt,'binding tombstone');assert.equal(service.workspace.read().versions.length,3);await wait(()=>bindingRow(firstBinding.id).count().then(n=>n===0),'binding hidden');
  await nav('configs');await page.locator('.config-card').filter({hasText:'app'}).click();await page.locator('#environment-deleted-notice').waitFor();assert.equal(await page.locator('#save-version').count(),0);assert.equal(await page.locator('#copy-config').isVisible(),true);assert.equal(await page.locator('[data-description-key="/port"]').inputValue(),'端口');
  await nav('environments');await page.locator('#binding-region').selectOption(regionId);await page.locator('#binding-type').selectOption(environmentTypeId);await choose(n1).check();await page.locator('#binding-save').click();await wait(async()=>/恢复 1/.test(await page.locator('#toast').textContent()),'binding restored response');assert.ok(!service.workspace.read().bindings[0].deletedAt);
  // Enum keep hides its dependent combinations while its retained config remains exportable.
  await page.locator('#enum-kind').selectOption('configNames');await enumRow(n1).getByRole('button',{name:'删除',exact:true}).click();await closeDialog('environment-delete-keep');await wait(()=>!!service.workspace.read().dictionaries.configNames[0].deletedAt,'enum deleted');assert.equal(service.workspace.export(user).configs.length,2);assert.equal(await page.locator('#enum-kind').inputValue(),'configNames');assert.equal(await page.locator('#binding-region').inputValue(),regionId);
  await enumRow(n2).getByRole('button',{name:'删除',exact:true}).click();await page.locator('#confirm-dialog').waitFor({state:'visible'});assert.match(await page.locator('#confirm-body').textContent(),/不可撤销/);
  await mkdir('test-output/environment',{recursive:true});await page.screenshot({path:'test-output/environment/delete-desktop.png',fullPage:true});await closeDialog('environment-delete-cascade');await wait(()=>!service.workspace.read().configs.some(x=>x.id===second.configId),'cascade deleted');assert.equal(service.workspace.read().configs[0].id,created.configId);assert.equal(service.workspace.read().versions.length,2);assert.equal(service.workspace.read().receipts.some(x=>x.result.configId===second.configId),false);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'test-output/environment/mobile.png',fullPage:true});
  // A new account gets a fresh form and sees no environment mutation controls.
  await service.auth.createUser(user.id,{username:'reader',password:'Reader-Password-123',role:'readonly'});const readerInitial=await service.auth.login('reader','Reader-Password-123');await service.auth.changePassword(readerInitial.token,'Reader-Password-123','Reader-Changed-456');const reader=await service.auth.login('reader','Reader-Changed-456');
  await page.locator('#enum-code').fill('unsaved');await page.locator('#logout').click();await page.locator('#login-form').waitFor();await context.addCookies([{name:'ops_session',value:reader.token,url,httpOnly:true,sameSite:'Strict'}]);await page.reload();await nav('environments');assert.equal(await page.locator('#enum-kind').inputValue(),'regions');assert.equal(await page.locator('#enum-code').count(),0);assert.equal(await page.locator('#binding-save').count(),0);assert.equal(await page.getByRole('button',{name:'删除组合'}).count(),0);
  assert.deepEqual(errors,[]);console.log('PASS environment browser: local selection retention, pending/failed inputs, multi-select search and reset, batch, cancel/Escape, concurrent preview, keep/cascade, restore, tombstones, mobile and account reset');
}finally{await browser?.close();await service.close();}
