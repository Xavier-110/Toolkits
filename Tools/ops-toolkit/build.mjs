import { build } from 'esbuild';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const result = await build({ entryPoints: [path.join(root, 'src/app.js')], bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['chrome110', 'edge110', 'firefox115'], write: false, legalComments: 'inline', define: { __CERT_EXAMPLE__: JSON.stringify(rootCertificates[0]) } });
const css = await readFile(path.join(root, 'src/styles.css'), 'utf8');
const licenses = [];
for (const name of ['yaml', 'pkijs', 'asn1js', '@noble/hashes', 'pvtsutils', 'pvutils', 'tslib']) {
  const dir = path.join(root, 'node_modules', name), pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const filename = (await readdir(dir)).find(x => /^licen[sc]e(?:\.md|\.txt)?$/i.test(x));
  licenses.push(`${name}@${pkg.version}\n${pkg.license}\n${filename ? await readFile(path.join(dir, filename), 'utf8') : 'See package license.'}`);
}
const template = await readFile(path.join(root, 'src/index.html'), 'utf8');
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = template.replace('/*__STYLES__*/', () => css).replace('/*__SCRIPT__*/', () => js + '\n/*\n' + licenses.join('\n\n').replace(/\*\//g, '* /').replace(/<\/script/gi, '<\\/script') + '\n*/');
await writeFile(path.join(root, '../ops_toolkit.html'), html, 'utf8');
await writeFile(path.join(root, 'THIRD_PARTY_LICENSES.txt'), licenses.join('\n\n'), 'utf8');
console.log(`Built Tools/ops_toolkit.html (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB), all dependencies embedded.`);
