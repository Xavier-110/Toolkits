import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'test-output', process.env.OPS_BROWSER || 'chrome'); await mkdir(outputDir, { recursive: true });
const html = await readFile(path.join(root, '../ops_toolkit.html'));
const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: process.env.OPS_BROWSER || 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage(), errors = [], external = [];
page.on('pageerror', error => errors.push(error.message));
context.on('request', req => { if (/^(https?|wss?):/.test(req.url()) && !req.url().startsWith(url)) external.push(req.url()); });
const done = name => console.log(`PASS ${name}`);
async function until(fn, message, timeout = 7000) { const start = Date.now(); while (!await fn()) { if (Date.now() - start > timeout) throw Error(message); await delay(80); } }
const nav = name => page.locator(`[data-page="${name}"]`).click();
async function saveConfig(name) { await page.locator('#save-converted').click(); await page.getByLabel('配置名', { exact: true }).last().fill(name); await page.locator('#modal-ok').click(); await until(async () => await page.locator('#config-title').textContent() === name, 'configuration not created'); }
try {
  await page.goto(url); await until(async () => (await page.locator('#storage-status').textContent()).includes('已连接'), 'database not ready');
  await page.locator('#convert').click(); assert.match(await page.locator('#convert-output').inputValue(), /APP_NAME/);
  await page.screenshot({ path: path.join(outputDir, '01-converter-desktop.png'), fullPage: true });
  await page.locator('#convert-input').fill('{"a":1,"a":2}'); assert.equal(await page.locator('#copy-output').isDisabled(), true);
  await page.locator('#convert').click(); assert.match(await page.locator('#convert-status').textContent(), /重复键/);
  await page.locator('#sample').selectOption('refs'); await page.locator('#convert').click(); assert.match(await page.locator('#convert-output').inputValue(), /secretKeyRef/);
  await page.locator('#output-format').selectOption('json'); await page.locator('#convert').click(); assert.match(await page.locator('#convert-status').textContent(), /不能转换/);
  await page.locator('#sample').selectOption('dependency'); await page.locator('#convert').click(); assert.match(await page.locator('#convert-status').textContent(), /跳过/);
  done('conversion, stale output, duplicate keys, references and dependency ordering');

  await page.locator('#sample').selectOption('basic'); await page.locator('#convert').click(); await saveConfig('browser-env');
  let raw = await page.locator('#config-editor').inputValue(); await page.locator('#config-editor').fill(raw.replace('demo-api', 'edited-api'));
  await until(async () => (await page.locator('#draft-status').textContent()).includes('已保存'), 'draft was not saved');
  await page.reload(); await nav('configs'); await page.locator('.config-card').filter({ hasText: 'browser-env' }).click();
  assert.match(await page.locator('#config-editor').inputValue(), /edited-api/);
  await page.locator('#save-version').click(); await until(async () => (await page.locator('#version-status').textContent()).includes('v2'), 'manual archive not created');
  await page.locator('#config-view').selectOption('table'); await page.getByRole('button', { name: '＋ 增加变量' }).click();
  assert.equal(await page.locator('.env-edit-table tbody tr').count(), 5);
  await page.locator('#config-view').selectOption('text');
  await page.locator('#save-version').click(); await until(async () => (await page.locator('#version-status').textContent()).includes('v3'), 'table edit not archived');
  done('configuration creation, 800ms draft save, reload recovery, table edit and manual archive');

  await page.locator('#config-editor').fill('{invalid'); await until(async () => (await page.locator('#draft-status').textContent()).includes('已保存'), 'invalid draft not saved');
  await page.locator('#config-history').click();
  await page.locator('.version-card').last().getByRole('button', { name: '恢复此版本' }).click(); await page.locator('#modal-ok').click();
  await until(async () => await page.locator('.version-card').count() === 4, 'restore did not create version');
  await nav('configs'); assert.match(await page.locator('#config-editor').inputValue(), /demo-api/);
  assert.match(await page.locator('#recovery-list').textContent(), /恢复 v1/);
  await page.screenshot({ path: path.join(outputDir, '02-configurations.png'), fullPage: true });
  done('restore creates new version and retains invalid pre-restore draft');

  await page.clock.install();
  raw = await page.locator('#config-editor').inputValue(); await page.locator('#config-editor').fill(raw.replace('demo-api', 'auto-api'));
  await page.clock.fastForward(1000); await until(async () => (await page.locator('#draft-status').textContent()).includes('已保存'), 'clock draft save failed');
  await page.clock.fastForward(61000); await until(async () => (await page.locator('#version-status').textContent()).includes('v5'), 'automatic archive did not trigger without another keystroke');
  done('automatic archive after idle and 60s deadline, without additional input');

  await nav('versions'); await page.locator('#history-config').selectOption({ label: '默认项目 / dev / browser-env' });
  await page.locator('#compare-versions').click(); assert.match(await page.locator('#diff-summary').textContent(), /变化/);
  await page.screenshot({ path: path.join(outputDir, '03-history.png'), fullPage: true });
  await nav('cert'); await page.locator('#cert-example').click(); await page.clock.runFor(500);
  await until(async () => (await page.locator('#cert-status').textContent()).includes('解析成功'), 'certificate example parse failed');
  assert.ok(await page.locator('.cert-fields').count() > 0);
  await page.screenshot({ path: path.join(outputDir, '04-certificate.png'), fullPage: true });
  done('history difference and real X.509 certificate rendering');

  await nav('backup'); const downloadEvent = page.waitForEvent('download'); await page.locator('#export-backup').click(); const download = await downloadEvent;
  const backupFile = path.join(outputDir, 'browser-backup.json'); await download.saveAs(backupFile);
  await page.locator('#backup-file').setInputFiles(backupFile); await until(async () => !await page.locator('#import-backup').isDisabled(), 'backup validation failed');
  await page.locator('#import-backup').click(); await until(async () => (await page.locator('#import-preview').textContent()).includes('成功导入'), 'import failed');
  await page.locator('#backup-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":999,"redacted":false}') });
  await until(async () => (await page.locator('#import-preview').textContent()).includes('备份无效'), 'bad backup not rejected');
  assert.equal(await page.locator('#import-backup').isDisabled(), true);
  done('backup export, validated copy import and malformed backup rejection');

  // Two isolated pages share the origin, but maintain independent loaded revisions.
  const tab2 = await context.newPage(); await tab2.goto(url); await tab2.locator('[data-page="configs"]').click(); await tab2.locator('.config-card').first().click();
  await nav('configs'); await page.locator('.config-card').first().click();
  raw = await page.locator('#config-editor').inputValue(); await page.locator('#config-editor').fill(raw.replace('auto-api', 'tab1-api'));
  await page.clock.fastForward(1000); await until(async () => (await page.locator('#draft-status').textContent()).includes('已保存'), 'tab1 save failed');
  const raw2 = await tab2.locator('#config-editor').inputValue(); await tab2.locator('#config-editor').fill(raw2.replace('auto-api', 'tab2-api'));
  await until(async () => (await tab2.locator('#toast').textContent()).includes('其他标签页'), 'concurrent update was not rejected');
  await tab2.close(); done('real IndexedDB cross-tab conflict protection');

  await nav('convert'); await page.locator('#input-format').selectOption('json'); await page.locator('#output-format').selectOption('yaml');
  await page.locator('#convert-input').fill('{"PASSWORD":"browser-secret-never-show","PUBLIC":"hello"}'); await page.locator('#convert').click(); await saveConfig('sensitive-env');
  assert.ok(!(await page.locator('#config-editor').inputValue()).includes('browser-secret-never-show'));
  await page.locator('#config-view').selectOption('table');
  assert.equal(await page.getByLabel('第 1 项名称', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('第 1 项值', { exact: true }).inputValue(), '••••');
  await page.locator('#config-reveal').check(); assert.equal(await page.getByLabel('第 1 项值', { exact: true }).inputValue(), 'browser-secret-never-show');
  await nav('backup'); await page.locator('#preview-share').click(); assert.ok(!(await page.locator('#share-preview').textContent()).includes('browser-secret-never-show'));
  done('sensitive values masked in text/table/share and protected from rename disclosure');

  await nav('convert'); await page.locator('#sample').selectOption('basic'); await page.locator('#convert').click();
  await page.clock.fastForward(6000);
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(outputDir, '05-mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); assert.equal(overflow, false, 'mobile horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('#theme-toggle').click(); await page.screenshot({ path: path.join(outputDir, '06-light-theme.png'), fullPage: true });
  await context.setOffline(true); await page.locator('#convert').click(); assert.match(await page.locator('#output-badge').textContent(), /转换完成/);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  done('mobile layout, light theme, offline operation, no external requests or runtime errors');

  const fileContext = await browser.newContext(), filePage = await fileContext.newPage();
  await filePage.goto(pathToFileURL(path.join(root, '../ops_toolkit.html')).href);
  await filePage.locator('#convert').click(); assert.match(await filePage.locator('#output-badge').textContent(), /转换完成/);
  await filePage.locator('[data-page="cert"]').click(); await filePage.locator('#cert-example').click();
  await until(async () => (await filePage.locator('#cert-status').textContent()).includes('解析成功'), 'file:// certificate failed');
  await fileContext.close(); done('direct file:// HTML conversion and certificate parsing');

  const unavailable = await browser.newContext(); await unavailable.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
  const noDb = await unavailable.newPage(); await noDb.goto(url);
  await until(async () => (await noDb.locator('#storage-status').textContent()).includes('临时模式'), 'storage unavailable not reported');
  await noDb.locator('#convert').click(); assert.match(await noDb.locator('#output-badge').textContent(), /转换完成/); await unavailable.close();
  const quota = await browser.newContext(); await quota.addInitScript(() => { IDBObjectStore.prototype.put = function() { throw new DOMException('Simulated quota exceeded', 'QuotaExceededError'); }; });
  const quotaPage = await quota.newPage(); await quotaPage.goto(url); await quotaPage.locator('#convert').click(); await quotaPage.locator('#save-converted').click();
  await quotaPage.getByLabel('配置名', { exact: true }).last().fill('quota-test'); await quotaPage.locator('#modal-ok').click();
  await until(async () => (await quotaPage.locator('#toast').textContent()).includes('quota'), 'quota failure not reported');
  assert.equal(await quotaPage.locator('.config-card').count(), 0); assert.match(await quotaPage.locator('#convert-input').inputValue(), /demo-api/); await quota.close();
  done('unavailable storage fallback and quota failure retain input with no false save success');
  console.log(`Browser: ${await browser.version()}`);
  await writeFile(path.join(outputDir, 'browser-result.json'), JSON.stringify({ browser: await browser.version(), errors, externalRequests: external, result: 'passed', timestamp: new Date().toISOString() }, null, 2));
} catch (e) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {}); console.error(e); process.exitCode = 1;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
