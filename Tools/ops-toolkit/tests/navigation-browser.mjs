import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createService} from '../server/http.js';
const service=createService({dbPath:':memory:'});let browser;
try{
  await service.auth.bootstrap('admin','Initial-Password-123');
  const initial=await service.auth.login('admin','Initial-Password-123');
  await service.auth.changePassword(initial.token,'Initial-Password-123','Changed-Password-456');
  const session=await service.auth.login('admin','Changed-Password-456');
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${service.server.address().port}`;
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext();
  await context.addCookies([{name:'ops_session',value:session.token,url,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();page.setDefaultTimeout(6000);
  for(const name of ['environments','configs','versions','cert','backup','users','settings']){
    await page.goto(`${url}/#${name}`);await page.locator(`#page-${name}`).waitFor({state:'visible'});
    await page.reload();await page.locator(`#page-${name}`).waitFor({state:'visible'});
    assert.equal(await page.locator('.nav-item.active').getAttribute('data-page'),name);
  }
  assert.deepEqual(await page.locator('nav [data-page]').evaluateAll(nodes=>nodes.map(n=>n.dataset.page)),['convert','configs','versions','cert','environments','backup','users','settings']);
  console.log('PASS navigation: deep links, refresh and menu order');
}finally{if(browser)await browser.close();await service.close();}
