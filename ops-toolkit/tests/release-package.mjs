import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version;
const temp = await mkdtemp(path.join(tmpdir(), 'ops-release-test-'));
const exists = async filename => stat(filename).then(() => true, () => false);
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: project, windowsHide: true, ...options });
  let output = '';
  child.stdout?.on('data', chunk => { output += chunk; });
  child.stderr?.on('data', chunk => { output += chunk; });
  child.on('error', reject);
  child.on('close', code => resolve({ code, output }));
});
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

try {
  const result = await run(process.execPath, ['release.mjs', '--output', temp]);
  assert.equal(result.code, 0, `Release build failed:\n${result.output}`);

  const name = `ops-toolkit-v${version}`;
  const archive = path.join(temp, `${name}.zip`);
  const extracted = path.join(temp, 'extracted');
  assert.ok(await exists(archive), 'release ZIP must exist');
  const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
  const expand = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath ${psLiteral(archive)} -DestinationPath ${psLiteral(extracted)} -Force`]);
  assert.equal(expand.code, 0, `Cannot extract release ZIP:\n${expand.output}`);

  const release = path.join(extracted, name);
  const app = path.join(release, 'ops-toolkit');
  const html = await readFile(path.join(release, 'ops_toolkit_online.html'), 'utf8');
  assert.match(html, /<html lang="zh-CN"/);
  assert.doesNotMatch(html, /sourceMappingURL/);
  for (const filename of ['server/start.mjs', 'server/init-admin.mjs', 'node_modules/yaml/package.json', 'THIRD_PARTY_LICENSES.txt', 'start.cmd', 'init-admin.cmd', 'start-linux.sh']) {
    assert.ok(await exists(path.join(app, filename)), `Missing release file: ${filename}`);
  }
  assert.equal(await exists(path.join(app, 'data')), false, 'business data must not be packaged');
  assert.equal(await exists(path.join(app, 'server/http.js')), false, 'server source files must not be copied');
  const manifest = JSON.parse(await readFile(path.join(release, 'SHA256SUMS.json'), 'utf8'));
  assert.equal(manifest.files['ops_toolkit_online.html'], createHash('sha256').update(html).digest('hex'));
  const archiveHash = createHash('sha256').update(await readFile(archive)).digest('hex');
  assert.match(await readFile(`${archive}.sha256`, 'utf8'), new RegExp(`^${archiveHash}  ${name}\\.zip\\n$`));
  const imports = await run(process.execPath, ['--input-type=module', '-e',
    "await Promise.all(['oracledb','mysql2/promise','pg','yaml'].map(name=>import(name)))"], { cwd: app });
  assert.equal(imports.code, 0, `A runtime dependency cannot load:\n${imports.output}`);

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/start.mjs'], {
    cwd: app, windowsHide: true,
    env: { ...process.env, OPS_TOOLKIT_PORT: String(port), OPS_TOOLKIT_ORIGIN: origin, OPS_TOOLKIT_DB: path.join(temp, 'runtime.sqlite') },
    stdio: 'ignore',
  });
  try {
    let response;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { response = await fetch(origin); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(response, 'release service did not start');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /运维工具箱/);
    assert.equal((await fetch(`${origin}/api/me`)).status, 401);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
  console.log('PASS release package: ZIP content, exclusions, manifest and served HTML/API');
} finally {
  await rm(temp, { recursive: true, force: true });
}
