import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const argumentsList = process.argv.slice(2);
if (argumentsList.length && (argumentsList.length !== 2 || argumentsList[0] !== '--output' || !argumentsList[1])) {
  throw Error('用法：npm.cmd run release [-- --output <目录>]');
}
const output = path.resolve(argumentsList[1] || path.join(root, 'dist'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw Error('package.json 的 version 无效');
const name = `ops-toolkit-v${pkg.version}`;
const stage = path.join(output, name);
const archive = path.join(output, `${name}.zip`);
const checksumFile = `${archive}.sha256`;
const exists = async filename => stat(filename).then(() => true, () => false);
if (await exists(stage) || await exists(archive) || await exists(checksumFile)) {
  throw Error(`版本 ${pkg.version} 的发布产物已存在，请先更改 package.json 版本号或使用其他输出目录`);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(`${command} 执行失败（退出码 ${code}）`)));
  });
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function filesIn(directory, prefix = '') {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name);
    if (item.isDirectory()) files.push(...await filesIn(path.join(directory, item.name), relative));
    else if (item.isFile()) files.push(relative);
  }
  return files;
}
const psLiteral = value => `'${value.replaceAll("'", "''")}'`;

let stageCreated = false;
try {
  const tests = (await readdir(path.join(root, 'tests'))).filter(file => file.endsWith('.test.mjs')).sort();
  console.log('检查项目测试…');
  await run(process.execPath, ['--test', ...tests.map(file => path.join(root, 'tests', file))], root);
  console.log('构建单文件 HTML…');
  await run(process.execPath, [path.join(root, 'build.mjs')], root);

  await mkdir(output, { recursive: true });
  await mkdir(stage);
  stageCreated = true;
  const app = path.join(stage, 'ops-toolkit');
  const server = path.join(app, 'server');
  await mkdir(server, { recursive: true });
  await cp(path.join(root, '..', 'ops_toolkit_online.html'), path.join(stage, 'ops_toolkit_online.html'));
  for (const filename of ['package.json', 'package-lock.json', 'THIRD_PARTY_LICENSES.txt', 'start-linux.sh']) {
    await cp(path.join(root, filename), path.join(app, filename));
  }

  console.log('压缩项目服务端入口…');
  await build({
    entryPoints: ['start.mjs', 'init-admin.mjs', 'restore-backup.mjs'].map(file => path.join(root, 'server', file)),
    outdir: server, entryNames: '[name]', outExtension: { '.js': '.mjs' },
    bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm',
    minify: true, sourcemap: false, legalComments: 'none', logLevel: 'silent',
  });

  const npmCli = process.env.npm_execpath?.endsWith('.js')
    ? process.env.npm_execpath
    : path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!await exists(npmCli)) throw Error('找不到 npm CLI，请使用包含 npm 的 Node.js 安装环境');
  console.log('安装发布所需的运行依赖…');
  await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], app);

  const launcher = command => `@echo off\r\ncd /d "%~dp0"\r\nnode server\\${command}.mjs\r\nif errorlevel 1 pause\r\n`;
  await writeFile(path.join(app, 'start.cmd'), launcher('start'));
  await writeFile(path.join(app, 'init-admin.cmd'), launcher('init-admin'));
  await writeFile(path.join(stage, 'README-RELEASE.md'), `# 运维工具箱 ${pkg.version}\n\n需要 Node.js 24 或更新版本。Windows：在 ops-toolkit 目录双击 init-admin.cmd 交互创建管理员，再双击 start.cmd。Linux：在 ops-toolkit 目录运行 bash start-linux.sh init 创建管理员，再运行 bash start-linux.sh 启动；首次运行会重新安装适用于 Linux 的生产依赖，需要 npm 可访问依赖源。两种系统均通过浏览器访问 http://127.0.0.1:4173/ 。已有数据升级时先停服并备份 data 目录；保持原 OPS_TOOLKIT_DB 路径，勿用空库覆盖原库。\n\nops_toolkit_online.html 是单文件前端，但登录、配置及版本功能依赖同包中的服务，不支持通过 file:// 双击使用。前端和项目服务端代码已压缩且不附带源码映射；浏览器端和本机运行代码仍可被分析，不能保证防反编译。包内不含业务数据、数据库、密钥或账号。\n\nSHA256SUMS.json 列出包内文件校验值，同名 .zip.sha256 文件校验整个 ZIP。\n`);

  const checksums = {};
  for (const relative of (await filesIn(stage)).sort()) {
    checksums[relative] = digest(await readFile(path.join(stage, ...relative.split('/'))));
  }
  await writeFile(path.join(stage, 'SHA256SUMS.json'), JSON.stringify({ version: pkg.version, algorithm: 'SHA-256', files: checksums }, null, 2) + '\n');

  if (process.platform !== 'win32') throw Error('当前发布压缩步骤需要 Windows PowerShell');
  console.log('生成 ZIP…');
  const script = `Compress-Archive -LiteralPath ${psLiteral(stage)} -DestinationPath ${psLiteral(archive)} -CompressionLevel Optimal -ErrorAction Stop`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], root);
  await writeFile(checksumFile, `${digest(await readFile(archive))}  ${path.basename(archive)}\n`);
  console.log(`发布包：${archive}`);
  console.log(`校验值：${checksumFile}`);
} catch (error) {
  if (stageCreated) await rm(stage, { recursive: true, force: true });
  if (await exists(archive)) await rm(archive, { force: true });
  throw error;
}
