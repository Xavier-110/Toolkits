import { build } from 'esbuild';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const css = await readFile(path.join(root, 'src/styles.css'), 'utf8');
const licenses = [];
for (const name of ['yaml', 'pkijs', 'asn1js', '@noble/hashes', 'pvtsutils', 'pvutils', 'tslib']) {
  const dir = path.join(root, 'node_modules', name), pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const filename = (await readdir(dir)).find(x => /^licen[sc]e(?:\.md|\.txt)?$/i.test(x));
  licenses.push(`${name}@${pkg.version}\n${pkg.license}\n${filename ? await readFile(path.join(dir, filename), 'utf8') : 'See package license.'}`);
}
for (const online of [false, true]) {
const result = await build({ entryPoints: [path.join(root, online ? 'src/online.js' : 'src/app.js')], bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['chrome110', 'edge110', 'firefox115'], write: false, legalComments: 'inline', define: { __CERT_EXAMPLE__: JSON.stringify(rootCertificates[0]), __ONLINE__: String(online) } });
let template = await readFile(path.join(root, online ? 'src/online.html' : 'src/index.html'), 'utf8');
if (online) template = template.replace("connect-src 'none'", "connect-src 'self'").replace("form-action 'none'", "form-action 'self'").replace('<body>', '<body data-online="true" data-session="locked">').replace('本地优先 · 离线可用','在线协作 · 权限管理').replace('按项目与环境组织配置，将每次编辑留在本地。','按项目与环境组织共享配置，记录编辑者与提交者。').replace('把本地工作空间带走，或在新的浏览器中恢复。','备份共享工作空间，或从离线工具导入历史数据。').replace('浏览器存储会受来源地址、隐私模式及清理操作影响。定期下载完整备份；固定地址下的数据不会自动出现在其他端口或浏览器中。','配置和版本保存在服务端。完整备份包含配置原值，请妥善保管。账号与会话不会包含在备份中。').replace('本地处理，无需上传','转换与证书在本机处理 · 保存的配置由团队共享').replaceAll('重新载入本地数据','重新载入共享数据');
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = template.replace('/*__STYLES__*/', () => css).replace('/*__SCRIPT__*/', () => js + '\n/*\n' + licenses.join('\n\n').replace(/\*\//g, '* /').replace(/<\/script/gi, '<\\/script') + '\n*/').replace(/^(\s*\*)[ \t]+$/gm, '$1');
const filename = online ? 'ops_toolkit_online.html' : 'ops_toolkit.html';
await writeFile(path.join(root, '..', filename), html, 'utf8');
console.log(`Built Tools/${filename} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB).`);
}
await writeFile(path.join(root, 'THIRD_PARTY_LICENSES.txt'), licenses.join('\n\n'), 'utf8');
