import { convert, parseInput, serialize, parseJSON, byteSize, sensitivePaths, redact, diff, LIMITS } from './core.js';
import { Repository, addConfig, saveDraft, makeDraft, archiveVersion, restoreVersion, configVersions, normalizeDraft, shouldAutoArchive, exportBackup, exportShare, validateBackup, importBackup } from './store.js';
import { parseCertificates, validity } from './certificates.js';

const $ = id => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'ariaLabel') node.setAttribute('aria-label', value);
    else node[key] = value;
  }
  node.append(...children.filter(x => x !== null && x !== undefined)); return node;
}
function toast(message, error = false) {
  $('toast').textContent = message; $('toast').className = 'toast' + (error ? ' error' : ''); $('toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, error ? 11000 : 4500);
}
function notice(id, text, mode = '') { $(id).textContent = text; $(id).className = `notice ${mode}`; }
function on(id, event, handler) { $(id).addEventListener(event, async e => { try { await handler(e); } catch (err) { toast(err.message || String(err), true); } }); }
const opt = (value, text) => el('option', { value, text });
function fillSelect(id, items, empty = null, preferred = undefined) {
  const node = $(id), value = preferred === undefined ? node.value : preferred;
  node.replaceChildren(...(empty !== null ? [opt('', empty)] : []), ...items.map(x => opt(x.value, x.text)));
  if ([...node.options].some(o => o.value === value)) node.value = value;
}
const localTime = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const displayValue = v => v === undefined ? '（不存在）' : typeof v === 'string' ? v : serialize(v, 'asc', 2);
function download(name, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = el('a', { href: url, download: name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function copy(text) {
  try { if (!navigator.clipboard) throw Error(); await navigator.clipboard.writeText(text); toast('已复制'); }
  catch { const area = el('textarea', { value: text, readOnly: true, rows: 10 }); await modal('浏览器未开放剪贴板，请手动复制', [area], '关闭'); }
}
function modal(title, nodes, okay = '确认') {
  if ($('modal').open) throw Error('请先完成当前对话框');
  $('modal-title').textContent = title; $('modal-body').replaceChildren(...nodes); $('modal-ok').textContent = okay;
  $('modal').returnValue = ''; $('modal').showModal();
  return new Promise(resolve => $('modal').addEventListener('close', () => resolve($('modal').returnValue === 'ok'), { once: true }));
}
const field = (label, value = '', props = {}) => { const input = el('input', { value, ...props }); return { input, node: el('label', { text: label }, input) }; };
const repo = new Repository();
let selected = '', editing = null, editEpoch = 0, dirty = false, lastEdit = 0, saveTimer, output = null, certificates = [], imported = null, certificateRun = 0;
let mutationQueue = Promise.resolve();
function mutate(fn) {
  const next = mutationQueue.then(() => repo.mutate(fn)); mutationQueue = next.catch(() => {}); return next;
}
const config = () => repo.state.configs.find(c => c.id === selected);
function configLabel(c) { return `${repo.state.projects.find(p => p.id === c.projectId)?.name} / ${repo.state.environments.find(e => e.id === c.environmentId)?.name} / ${c.name}`; }
async function navigate(page) {
  if (page !== 'configs') await flushDraft();
  document.querySelectorAll('.page').forEach(p => p.hidden = p.id !== `page-${page}`);
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $('crumb').textContent = { convert: 'env / JSON', cert: '证书解析', configs: '配置管理', versions: '版本归档', backup: '数据备份' }[page];
  if (page === 'configs') renderConfigs();
  if (page === 'cert' && certificates.length) renderCertificates();
  if (page === 'versions') renderHistory();
  if (page === 'backup') renderBackup();
}
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page).catch(e => toast(e.message, true))));

// Conversion workspace is deliberately transient until the user saves it.
const examples = {
  basic: { format: 'json', target: 'yaml', text: '{\n  "PORT": "8080",\n  "APP_NAME": "demo-api",\n  "DEBUG": "false",\n  "EMPTY": ""\n}' },
  refs: { format: 'yaml', target: 'env-json', text: 'env:\n  - name: APP_NAME\n    value: "demo-api"\n  - name: DB_PASSWORD\n    valueFrom:\n      secretKeyRef:\n        name: database-secret\n        key: password\n' },
  dependency: { format: 'yaml', target: 'env-json', text: 'env:\n  - name: SERVICE_HOST\n    value: "localhost"\n  - name: SERVICE_PORT\n    value: "8080"\n  - name: API_URL\n    value: "http://$(SERVICE_HOST):$(SERVICE_PORT)"\n' },
};
function staleOutput() {
  output = null; $('output-badge').textContent = '待重新转换'; $('output-badge').className = 'pill';
  for (const id of ['copy-output', 'download-output', 'save-converted']) $(id).disabled = true;
  $('input-size').textContent = `${byteSize($('convert-input').value).toLocaleString()} 字节`;
  notice('convert-status', '输入或选项已更新，请重新转换。');
}
function loadExample(key) {
  const ex = examples[key]; $('convert-input').value = ex.text; $('input-format').value = ex.format; $('output-format').value = ex.target; staleOutput();
}
for (const id of ['convert-input', 'input-format', 'output-format', 'sort', 'coerce']) on(id, id === 'convert-input' ? 'input' : 'change', staleOutput);
on('sample', 'change', () => { if ($('sample').value) loadExample($('sample').value); $('sample').value = ''; });
on('clear-input', 'click', () => { $('convert-input').value = ''; $('convert-output').value = ''; $('output-count').textContent = '—'; staleOutput(); });
on('switch-structured', 'click', () => { $('output-format').value = 'env-json'; staleOutput(); });
on('convert', 'click', () => {
  staleOutput();
  try {
    output = convert($('convert-input').value, { format: $('input-format').value, target: $('output-format').value, sort: $('sort').value, coerce: $('coerce').checked });
    $('convert-output').value = output.text; $('output-badge').textContent = '转换完成'; $('output-badge').className = 'pill good';
    $('output-count').textContent = `${Array.isArray(output.data) ? output.data.length + ' 项' : output.data && typeof output.data === 'object' ? Object.keys(output.data).length + ' 个顶层键' : 'JSON 值'} · ${byteSize(output.text).toLocaleString()} 字节`;
    for (const id of ['copy-output', 'download-output', 'save-converted']) $(id).disabled = false;
    notice('convert-status', output.warnings.length ? [...new Set(output.warnings)].join('\n') : '转换成功，已按所选规则生成输出。', output.warnings.length ? 'warning' : 'success');
  } catch (e) { notice('convert-status', e.message, 'error'); }
});
on('copy-output', 'click', () => output && copy(output.text));
on('download-output', 'click', () => { if (output) download(`config.${output.format === 'yaml' ? 'yaml' : 'json'}`, output.text, output.format === 'yaml' ? 'text/yaml' : 'application/json'); });
on('save-converted', 'click', () => output && createConfigDialog(output));

// Certificates never enter IndexedDB or drafts.
async function inspectCertificates(inputs) {
  const run = ++certificateRun; certificates = []; $('cert-results').replaceChildren(); $('download-cert').disabled = true;
  notice('cert-status', '正在解析证书…');
  try {
    const totalBytes = inputs.reduce((sum, x) => sum + (typeof x === 'string' ? byteSize(x) : x.length), 0);
    if (totalBytes > LIMITS.cert) throw Error('证书输入合计超过 5 MiB');
    const results = [];
    // Reject the whole batch before parsing if any selected input contains a private key.
    if (inputs.some(x => /-----BEGIN [^-]*PRIVATE KEY-----/.test(typeof x === 'string' ? x : new TextDecoder().decode(x)))) throw Error('输入包含私钥，已停止解析；内容不会保存');
    for (let n = 0; n < inputs.length; n++) {
      try {
        const parsed = await parseCertificates(inputs[n], repo.state.settings.expiryWarningDays, (done, count) => { if (run === certificateRun) notice('cert-status', `文件 ${n + 1}/${inputs.length} · 证书 ${done}/${count}`); });
        results.push(...parsed.map(x => ({ ...x, file: n + 1 })));
      } catch (e) { results.push({ file: n + 1, index: 1, error: e.message }); }
      if (results.length > 50) throw Error('一次最多解析 50 张证书');
    }
    if (run !== certificateRun) return;
    certificates = results; renderCertificates();
    const errors = results.filter(x => x.error).length;
    notice('cert-status', `${results.length - errors} 张解析成功${errors ? `，${errors} 项失败（部分解析失败）` : ''}。仅检查有效期，不代表可信。`, errors ? 'warning' : 'success');
    $('download-cert').disabled = !results.some(x => x.data);
  } catch (e) { if (run === certificateRun) notice('cert-status', e.message, 'error'); }
}
function renderCertificates() {
  $('cert-results').replaceChildren(...certificates.map((item, i) => {
    if (item.error) return el('div', { class: 'notice error', text: `文件 ${item.file} · 第 ${item.index} 项：${item.error}` });
    const c = item.data, status = validity(c.notBefore, c.notAfter, repo.state.settings.expiryWarningDays), subject = c.subject.map(x => `${x.name}=${x.value}`).join(', '), issuer = c.issuer.map(x => `${x.name}=${x.value}`).join(', ');
    const fields = [
      ['版本 / 序列号', `X.509 v${c.version}\n${c.serialNumber}`], ['主体 Subject', subject || '未提供'], ['签发者 Issuer', issuer || '未提供'],
      ['生效时间', `${c.notBefore}\n本地：${localTime(c.notBefore)}`], ['到期时间', `${c.notAfter}\n本地：${localTime(c.notAfter)}`],
      ['剩余时间', `${status.remainingDays.toFixed(2)} 天`], ['SAN', c.subjectAltName.length ? c.subjectAltName.map(x => `${x.type}: ${displayValue(x.value)}`).join('\n') : '未提供'],
      ['签名算法', c.signatureAlgorithm], ['公钥', `${c.publicKeyAlgorithm}\n${c.publicKeyParameters}`], ['Key Usage', c.keyUsage.join(', ') || '未提供'], ['Extended Usage', c.extendedKeyUsage.join('\n') || '未提供'],
      ['Basic Constraints', c.basicConstraints ? displayValue(c.basicConstraints) : '未提供'], ['SHA-256 指纹', c.sha256], ['扩展 OID', c.extensions.map(x => `${x.oid}${x.critical ? ' · critical' : ''}`).join('\n') || '未提供'],
    ];
    const list = el('dl', { class: 'cert-fields' });
    for (const [label, value] of fields) list.append(el('dt', { text: label }), el('dd', {}, el('button', { class: 'quiet', text: '复制', onclick: () => copy(value) }), value));
    const badgeClass = status.status === '有效期内' ? 'good' : status.status === '已过期' ? 'error' : 'warning';
    return el('div', { class: 'panel' }, el('div', { class: 'panel-title' }, el('h2', { text: c.subject.find(x => x.name === 'CN')?.value || `证书 ${i + 1}` }), el('span', { class: `pill ${badgeClass}`, text: status.status })), list, ...(c.warnings.length ? [el('p', { class: 'notice warning', text: c.warnings.join('\n') })] : []));
  }));
}
async function inspectFiles(files) {
  const list = [...files]; if (!list.length) return;
  if (list.length > 50 || list.reduce((n, f) => n + f.size, 0) > LIMITS.cert) throw Error('最多 50 个文件，合计不得超过 5 MiB');
  await inspectCertificates(await Promise.all(list.map(async f => new Uint8Array(await f.arrayBuffer()))));
}
on('parse-cert', 'click', () => inspectCertificates([$('cert-input').value]));
on('cert-file', 'change', e => inspectFiles(e.target.files));
on('cert-example', 'click', () => { $('cert-input').value = __CERT_EXAMPLE__; return inspectCertificates([$('cert-input').value]); });
on('clear-cert', 'click', () => { certificateRun++; certificates = []; $('cert-input').value = ''; $('cert-file').value = ''; $('cert-results').replaceChildren(); $('download-cert').disabled = true; notice('cert-status', '证书输入和结果已清空。'); });
on('cert-input', 'input', () => { certificateRun++; certificates = []; $('cert-results').replaceChildren(); $('download-cert').disabled = true; notice('cert-status', '输入已变化，请重新解析。'); });
on('download-cert', 'click', () => download('certificate-info.json', serialize(certificates)));
on('cert-drop', 'dragover', e => { e.preventDefault(); $('cert-drop').classList.add('drag'); });
on('cert-drop', 'dragleave', () => $('cert-drop').classList.remove('drag'));
on('cert-drop', 'drop', e => { e.preventDefault(); $('cert-drop').classList.remove('drag'); return inspectFiles(e.dataTransfer.files); });

// Configuration library and editing session.
async function createConfigDialog(source = null, copyFrom = null) {
  await flushDraft();
  const current = copyFrom || config(), p = field('项目', current ? repo.state.projects.find(p => p.id === current.projectId).name : '默认项目', { required: true, maxLength: 120 });
  const env = field('环境', copyFrom ? 'test' : current ? repo.state.environments.find(e => e.id === current.environmentId).name : 'dev', { required: true, maxLength: 120 });
  const name = field('配置名', copyFrom ? `${copyFrom.name}-copy` : '', { required: true, maxLength: 120 });
  const format = el('select', {}, opt('json', '普通 JSON'), opt('yaml', 'env YAML'), opt('env-json', 'env JSON 数组'));
  const area = el('textarea', { class: 'code-editor', rows: 10, required: true, value: source?.text || '{\n  "APP_NAME": "my-service"\n}' });
  format.value = source?.format || 'json';
  const existing = el('select', {}, opt('', '新建独立配置集'), ...repo.state.configs.filter(c => !c.archivedAt && (!source || source.kind === c.type)).map(c => opt(c.id, configLabel(c))));
  const nodes = [el('p', { text: '保存后将启用本地草稿和版本管理。敏感字段在浏览器内以原值存储。' }), ...(!copyFrom && source ? [el('label', { text: '保存位置' }, existing)] : []), el('div', { class: 'form-grid' }, p.node, env.node, name.node), el('label', { class: 'block-label', text: '输入格式' }, format), area];
  existing.addEventListener('change', () => { p.input.required = env.input.required = name.input.required = !existing.value; });
  if (!await modal(copyFrom ? '复制到其他环境' : '保存配置集', nodes, '保存配置')) return;
  try {
  const parsed = parseInput(area.value, format.value), draft = makeDraft(area.value, format.value);
  let id;
  if (existing.value) {
    const target = repo.state.configs.find(c => c.id === existing.value);
    if (target.type !== parsed.kind) throw Error('目标配置类型不一致');
    if (!await modal('更新现有配置', [el('p', { text: `将更新 ${configLabel(target)}。原草稿将保留到恢复草稿，归档历史不会覆盖。` }), el('pre', { text: area.value })], '确认更新')) return;
    await mutate(state => {
      const old = state.drafts.find(d => d.configSetId === target.id);
      if (old) state.recoveryDrafts.push({ ...structuredClone(old), id: crypto.randomUUID(), reason: '从转换页更新前的草稿', createdAt: new Date().toISOString() });
      saveDraft(state, target.id, draft); archiveVersion(state, target.id, 'manual', '从转换页更新');
    }); id = target.id;
  } else id = await mutate(state => addConfig(state, { project: p.input.value, environment: env.input.value, name: name.input.value, type: parsed.kind, description: copyFrom?.description || '', tags: copyFrom?.tags || [], sourceConfigId: copyFrom?.id || null, itemMetadata: copyFrom?.itemMetadata || {} }, draft));
  await selectConfig(id); await navigate('configs'); toast('配置已保存，版本已归档');
  } catch (e) {
    $('convert-input').value = area.value; $('input-format').value = format.value; staleOutput();
    await navigate('convert'); notice('convert-status', `配置保存失败：${e.message}\n本次输入已保留在左侧，可修复、复制或重新转换后下载。`, 'error'); throw e;
  }
}
function renderConfigs() {
  const state = repo.state;
  fillSelect('project-filter', state.projects.map(p => ({ value: p.id, text: p.name })), '所有项目');
  const envs = state.environments.filter(e => !$('project-filter').value || e.projectId === $('project-filter').value);
  fillSelect('env-filter', [...new Set(envs.map(e => e.name))].map(name => ({ value: name, text: name })), '所有环境');
  const query = $('config-search').value.toLowerCase();
  const list = state.configs.filter(c => {
    if (!$('show-archived').checked && c.archivedAt) return false;
    if ($('project-filter').value && c.projectId !== $('project-filter').value) return false;
    if ($('env-filter').value && state.environments.find(e => e.id === c.environmentId)?.name !== $('env-filter').value) return false;
    const latest = state.versions.find(v => v.id === c.latestVersionId);
    const keys = c.type === 'k8s-env' ? latest?.normalizedContent.map(x => x.name) : collectKeys(latest?.normalizedContent);
    return `${c.name} ${c.description} ${c.tags.join(' ')} ${(keys || []).join(' ')}`.toLowerCase().includes(query);
  });
  $('config-list').replaceChildren(...list.map(c => el('button', { class: 'config-card' + (c.id === selected ? ' selected' : ''), onclick: () => selectConfig(c.id).catch(e => toast(e.message, true)) }, el('strong', { text: c.name }), el('small', { text: `${state.projects.find(p => p.id === c.projectId)?.name} / ${state.environments.find(e => e.id === c.environmentId)?.name}` }), el('small', { text: `${c.type === 'json' ? 'JSON' : 'K8S ENV'} · ${c.archivedAt ? '配置已归档' : `v${state.versions.find(v => v.id === c.latestVersionId)?.versionNumber || 0}`} · ${c.tags.join(' · ')}` }))));
  if (!list.length) $('config-list').append(el('div', { class: 'empty-state' }, el('h3', { text: '暂无匹配配置' }), el('p', { text: '新建配置，或调整筛选条件。' })));
}
function collectKeys(value) { const keys = []; function walk(v) { if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) { keys.push(k); walk(child); } } walk(value); return keys; }
async function selectConfig(id) {
  await flushDraft(); selected = id; const c = config();
  $('config-empty').hidden = !!c; $('config-detail').hidden = !c;
  if (!c) { editing = null; return; }
  editing = structuredClone(repo.state.drafts.find(d => d.configSetId === id)); dirty = false; editEpoch++; $('config-reveal').checked = false; $('config-view').value = 'text';
  $('config-title').textContent = c.name; $('config-type').textContent = c.type === 'json' ? 'JSON' : 'K8S ENV';
  $('config-name').value = c.name; $('config-tags').value = c.tags.join(', '); $('config-description').value = c.description;
  $('sensitive-metadata').value = Object.entries(c.itemMetadata || {}).map(([k, val]) => (val ? '' : '!') + k).join('\n');
  $('config-format').value = editing.inputFormat; $('config-format').disabled = !!c.archivedAt;
  $('archive-config').textContent = c.archivedAt ? '恢复配置集' : '归档配置集';
  $('save-version').disabled = !!c.archivedAt; $('save-metadata').disabled = !!c.archivedAt;
  updateEditorView(); updateSaveBadges(); renderRecovery(); renderConfigs();
  if (editing.rawInput !== repo.state.versions.find(v => v.id === c.latestVersionId)?.rawInput) toast('已恢复最近一次保存的草稿');
}
function updateSaveBadges() {
  if (!config()) return;
  $('draft-status').textContent = dirty ? '草稿待保存' : '草稿已保存'; $('draft-status').className = 'pill' + (dirty ? '' : ' good');
  const latest = repo.state.versions.find(v => v.id === config().latestVersionId);
  $('version-status').textContent = latest ? `已归档为 v${latest.versionNumber}` : '尚无版本';
}
function updateEditorView() {
  if (!editing || !config()) return;
  const c = config(), reveal = $('config-reveal').checked;
  let parsed, masked = false;
  try {
    parsed = normalizeDraft(editing, c.type); masked = sensitivePaths(parsed.data, c.type, c.itemMetadata).size > 0 && !reveal;
    $('config-editor').value = masked ? serialize(redact(parsed.data, c.type, c.itemMetadata), 'none') : editing.rawInput;
    notice('config-validation', masked ? '敏感内容已遮罩。勾选“显示并编辑敏感内容”后可以编辑完整配置。' : parsed.warnings.length ? parsed.warnings.join('\n') : '校验通过。草稿自动保存；有效改动每隔至少 60 秒归档。', masked || parsed.warnings.length ? 'warning' : 'success');
  } catch (e) {
    masked = !reveal; $('config-editor').value = reveal ? editing.rawInput : '草稿包含无效内容。为避免暴露敏感值，请勾选“显示并编辑敏感内容”后继续修复。'; notice('config-validation', '草稿尚未通过校验，正式版本不会更新。', 'warning');
  }
  $('config-editor').readOnly = masked || !!c.archivedAt;
  const table = $('config-view').value === 'table' && c.type === 'k8s-env';
  $('config-editor').hidden = table; $('env-table').hidden = !table;
  if (table) renderEnvTable(parsed, reveal);
}
function renderEnvTable(parsed, reveal) {
  const host = $('env-table'); host.replaceChildren();
  if (!parsed) { host.append(el('p', { class: 'notice warning', text: '草稿校验失败，请切换文本视图修复。' })); return; }
  const table = el('table', { class: 'env-edit-table' }, el('thead', {}, el('tr', {}, ...['名称', '值 / 引用（JSON）', '操作'].map(x => el('th', { text: x }))))), body = el('tbody');
  const rows = structuredClone(parsed.data), hidden = sensitivePaths(rows, 'k8s-env', config().itemMetadata);
  function apply() { editing.rawInput = serialize(rows, 'none'); editing.inputFormat = 'env-json'; $('config-format').value = 'env-json'; markEdited(); }
  rows.forEach((row, i) => {
    const masked = hidden.has(row.name) && !reveal;
    const name = el('input', { value: row.name, ariaLabel: `第 ${i + 1} 项名称`, disabled: masked || !!config().archivedAt });
    const value = el('textarea', { value: masked ? '••••' : row.valueFrom ? serialize(row.valueFrom, 'none') : row.value, rows: row.valueFrom ? 4 : 2, disabled: masked || !!config().archivedAt, ariaLabel: `第 ${i + 1} 项值` });
    name.addEventListener('change', () => { row.name = name.value; apply(); updateEditorView(); });
    value.addEventListener('change', () => { try { if (row.valueFrom) row.valueFrom = parseJSON(value.value); else row.value = value.value; apply(); updateEditorView(); } catch (e) { toast(e.message, true); } });
    const remove = el('button', { text: '删除', class: 'danger quiet', disabled: !!config().archivedAt, onclick: () => { rows.splice(i, 1); apply(); updateEditorView(); } });
    body.append(el('tr', {}, el('td', {}, name), el('td', {}, value), el('td', {}, remove)));
  }); table.append(body); host.append(table, el('button', { text: '＋ 增加变量', disabled: !!config().archivedAt, onclick: () => { let i = rows.length + 1; while (rows.some(r => r.name === `NEW_VAR_${i}`)) i++; rows.push({ name: `NEW_VAR_${i}`, value: '' }); apply(); updateEditorView(); } }));
}
function markEdited() {
  dirty = true; lastEdit = Date.now(); editEpoch++; clearTimeout(saveTimer); updateSaveBadges();
  saveTimer = setTimeout(() => flushDraft().catch(e => { $('draft-status').textContent = '草稿保存失败'; toast(e.message, true); }), 800);
}
async function flushDraft() {
  if (!dirty || !editing || !selected) return;
  clearTimeout(saveTimer); const id = selected, epoch = editEpoch, snapshot = makeDraft(editing.rawInput, editing.inputFormat, editing.options);
  await mutate(state => saveDraft(state, id, snapshot));
  if (selected === id && editEpoch === epoch) { dirty = false; editing = { ...editing, ...snapshot }; updateSaveBadges(); }
}
function renderRecovery() {
  $('recovery-list').replaceChildren(...repo.state.recoveryDrafts.filter(d => d.configSetId === selected).map(d => el('div', { class: 'row border-top' }, el('span', { class: 'grow small', text: `${d.reason} · ${localTime(d.createdAt)}` }), el('button', { text: '下载草稿', onclick: () => download(`${config().name}-recovery.${d.inputFormat === 'yaml' ? 'yaml' : 'json'}`, d.rawInput, 'text/plain') }))));
  if (!$('recovery-list').childNodes.length) $('recovery-list').textContent = '暂无恢复草稿';
}
on('new-config', 'click', () => createConfigDialog());
for (const id of ['project-filter', 'env-filter', 'show-archived', 'config-search']) on(id, id === 'config-search' ? 'input' : 'change', renderConfigs);
on('config-editor', 'input', () => { editing.rawInput = $('config-editor').value; markEdited(); });
on('config-format', 'change', () => { editing.inputFormat = $('config-format').value; markEdited(); updateEditorView(); });
on('config-view', 'change', updateEditorView); on('config-reveal', 'change', updateEditorView);
on('save-version', 'click', async () => {
  await flushDraft(); const version = await mutate(state => archiveVersion(state, selected, 'manual', $('version-note').value.trim()));
  $('version-note').value = ''; updateSaveBadges(); updateEditorView(); renderConfigs(); toast(version ? `已归档为 v${version.versionNumber}` : '内容未变化，无需创建重复版本');
});
on('download-draft', 'click', () => { if (editing) download(`${config().name}-${repo.state.environments.find(e => e.id === config().environmentId)?.name}-draft.${editing.inputFormat === 'yaml' ? 'yaml' : 'json'}`, editing.rawInput, 'text/plain'); });
on('save-metadata', 'click', async () => {
  await flushDraft(); const metadata = Object.create(null);
  for (const line of $('sensitive-metadata').value.split('\n').map(x => x.trim()).filter(Boolean)) metadata[line.startsWith('!') ? line.slice(1) : line] = !line.startsWith('!');
  await mutate(state => {
    const c = state.configs.find(c => c.id === selected), name = $('config-name').value.trim();
    if (!name || name.length > 120 || state.configs.some(x => x.id !== c.id && x.projectId === c.projectId && x.environmentId === c.environmentId && x.name === name)) throw Error('配置名为空、过长或与同环境的配置重复');
    c.name = name; c.description = $('config-description').value; c.tags = $('config-tags').value.split(/[,，]/).map(x => x.trim()).filter(Boolean); c.itemMetadata = metadata; c.updatedAt = new Date().toISOString(); c.revision++;
  }); $('config-title').textContent = config().name; updateEditorView(); renderConfigs(); toast('元数据已保存');
});
on('copy-config', 'click', () => createConfigDialog({ text: editing.rawInput, format: editing.inputFormat, kind: config().type }, config()));
on('archive-config', 'click', async () => { await flushDraft(); await mutate(state => { const c = state.configs.find(c => c.id === selected); c.archivedAt = c.archivedAt ? null : new Date().toISOString(); c.revision++; }); await selectConfig(selected); });
on('delete-config', 'click', async () => {
  const id = selected, c = config(), count = configVersions(repo.state, id).length;
  if (!await modal('删除配置集', [el('p', { text: `删除“${c.name}”及其 ${count} 个版本、当前草稿和恢复草稿？此操作不可撤销，可先到数据备份页导出。` })], '删除配置集')) return;
  await mutate(state => { for (const key of ['configs', 'versions', 'drafts', 'recoveryDrafts']) state[key] = state[key].filter(x => key === 'configs' ? x.id !== id : x.configSetId !== id); });
  dirty = false; selected = ''; editing = null; clearTimeout(saveTimer); $('config-detail').hidden = true; $('config-empty').hidden = false; renderConfigs(); toast('配置集已删除');
});
on('config-history', 'click', async () => { await flushDraft(); renderHistory(selected); await navigate('versions'); });
setInterval(async () => {
  if (!selected || dirty || !repo.persistent || !shouldAutoArchive(repo.state, selected, lastEdit)) return;
  try { await mutate(state => shouldAutoArchive(state, selected, lastEdit) ? archiveVersion(state, selected, 'auto', '自动归档') : null); updateSaveBadges(); }
  catch (e) { repo.state.settings.autoArchiveEnabled = false; toast(`自动归档已暂停：${e.message}`, true); }
}, 1000);
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

// History is read-only until an explicit restore creates a new version.
function renderHistory(preferred) {
  fillSelect('history-config', repo.state.configs.map(c => ({ value: c.id, text: configLabel(c) + (c.archivedAt ? '（已归档）' : '') })), '选择配置集', preferred);
  const id = $('history-config').value, versions = configVersions(repo.state, id);
  fillSelect('diff-left', versions.map(v => ({ value: v.id, text: `v${v.versionNumber} · ${localTime(v.createdAt)}` })), null, versions[1]?.id || versions[0]?.id);
  fillSelect('diff-right', [...versions.map(v => ({ value: v.id, text: `v${v.versionNumber} · ${localTime(v.createdAt)}` })), ...(id ? [{ value: 'draft', text: '当前草稿（未归档）' }] : [])], null, versions[0]?.id);
  $('version-list').replaceChildren(...versions.map(v => el('div', { class: 'version-card' }, el('div', { class: 'row' }, el('strong', { text: `v${v.versionNumber}` }), el('span', { class: 'pill', text: ({ auto: '自动归档', restore: '恢复版本', create: '首次保存', manual: '手动保存' })[v.source] || v.source })), el('p', { text: v.note || '无备注' }), el('time', { text: localTime(v.createdAt) }), el('div', { class: 'row' }, el('button', { text: '查看', onclick: () => { $('diff-right').value = v.id; compareVersions(); } }), el('button', { text: '恢复此版本', onclick: () => restoreDialog(id, v.id).catch(e => toast(e.message, true)) }), el('button', { text: '下载', onclick: () => { const c = repo.state.configs.find(x => x.id === id); download(`${c.name}-v${v.versionNumber}.${v.inputFormat === 'yaml' ? 'yaml' : 'json'}`, v.rawInput, 'text/plain'); } })) )));
  if (!versions.length) $('version-list').append(el('div', { class: 'empty-state' }, el('h3', { text: '尚无版本' }), el('p', { text: '保存配置集后即可查看历史。' })));
  $('diff-results').replaceChildren(); $('diff-left-text').textContent = ''; $('diff-right-text').textContent = ''; notice('diff-summary', '选择两个版本，或与当前草稿比较。');
}
function comparisonRecord(id, choice) {
  const c = repo.state.configs.find(x => x.id === id);
  if (choice === 'draft') { const d = id === selected && editing ? editing : repo.state.drafts.find(x => x.configSetId === id); return { normalizedContent: normalizeDraft(d, c.type).data, itemMetadata: c.itemMetadata, rawInput: d.rawInput }; }
  const v = repo.state.versions.find(x => x.id === choice && x.configSetId === id); if (!v) throw Error('请先选择配置集和版本'); return v;
}
function combinedMetadata(c, left, right) {
  const data = Object.create(null);
  for (const m of [left.itemMetadata || {}, right.itemMetadata || {}, c.itemMetadata || {}]) for (const [k, v] of Object.entries(m)) data[k] = data[k] || v;
  return data;
}
function diffTable(rows) {
  return el('table', { class: 'diff-table' }, el('thead', {}, el('tr', {}, ...['字段 / 名称', '变化', '之前', '之后'].map(text => el('th', { text })))), el('tbody', {}, ...rows.map(r => el('tr', {}, el('td', { text: r.path }), el('td', { text: r.type }), el('td', { text: displayValue(r.before) }), el('td', { text: displayValue(r.after) })))));
}
function compareVersions() {
  try {
    const id = $('history-config').value, c = repo.state.configs.find(x => x.id === id), left = comparisonRecord(id, $('diff-left').value), right = comparisonRecord(id, $('diff-right').value), meta = combinedMetadata(c, left, right), reveal = $('diff-reveal').checked;
    const rows = diff(left.normalizedContent, right.normalizedContent, c.type, meta, reveal);
    $('diff-results').replaceChildren(diffTable(rows));
    notice('diff-summary', `${$('diff-left').selectedOptions[0].text} → ${$('diff-right').selectedOptions[0].text}\n${rows.length ? `${rows.length} 处变化` : '内容一致'}${reveal ? ' · 正在显示原值' : ' · 敏感内容已遮罩'}`, 'success');
    $('diff-left-text').textContent = reveal ? left.rawInput : serialize(redact(left.normalizedContent, c.type, meta));
    $('diff-right-text').textContent = reveal ? right.rawInput : serialize(redact(right.normalizedContent, c.type, meta));
  } catch (e) { notice('diff-summary', e.message, 'error'); $('diff-results').replaceChildren(); $('diff-left-text').textContent = ''; $('diff-right-text').textContent = ''; }
}
async function restoreDialog(id, versionId) {
  await flushDraft(); const c = repo.state.configs.find(x => x.id === id), target = repo.state.versions.find(x => x.id === versionId), current = repo.state.versions.find(x => x.id === c.latestVersionId);
  if (c.archivedAt) throw Error('请先在配置管理中恢复已归档的配置集');
  const changes = diff(current.normalizedContent, target.normalizedContent, c.type, combinedMetadata(c, current, target));
  if (!await modal(`恢复 ${c.name} · v${target.versionNumber}`, [el('p', { text: '以下比较当前归档版本和目标版本。恢复前草稿将单独保留；历史版本不会覆盖。相同内容不会创建重复版本。' }), diffTable(changes)], '确认恢复')) return;
  const v = await mutate(state => restoreVersion(state, id, versionId));
  if (selected === id) { dirty = false; await selectConfig(id); }
  renderHistory(id); toast(v ? `已恢复并创建 v${v.versionNumber}` : '目标内容与最新版本一致，草稿已同步');
}
on('history-config', 'change', () => renderHistory()); on('refresh-history', 'click', () => renderHistory()); on('compare-versions', 'click', compareVersions); on('diff-reveal', 'change', compareVersions);
on('clean-history', 'click', async () => {
  const id = $('history-config').value, c = repo.state.configs.find(x => x.id === id); if (!c) throw Error('请先选择配置集');
  const versions = configVersions(repo.state, id).filter(v => v.id !== c.latestVersionId), checks = versions.map(v => ({ v, input: el('input', { type: 'checkbox' }) }));
  if (!checks.length) throw Error('没有可清理的旧版本');
  if (!await modal('选择要清理的版本', [el('p', { text: `共 ${checks.length} 个旧版本可选。最新版本不可删除；删除后版本号不会复用。建议先导出完整备份。` }), ...checks.map(x => el('label', { class: 'check' }, x.input, `v${x.v.versionNumber} · ${localTime(x.v.createdAt)}`))], '预览清理')) return;
  const ids = new Set(checks.filter(x => x.input.checked).map(x => x.v.id)); if (!ids.size) return;
  if (!await modal('确认清理', [el('p', { text: `将永久删除 ${ids.size} 个历史版本。指向这些版本的恢复来源关联将清除，恢复备注和恢复草稿保留。` })], `删除 ${ids.size} 个版本`)) return;
  await mutate(state => {
    state.versions = state.versions.filter(v => !ids.has(v.id));
    for (const v of state.versions) if (ids.has(v.restoredFromVersionId)) v.restoredFromVersionId = null;
    for (const d of [...state.drafts, ...state.recoveryDrafts]) if (ids.has(d.baseVersionId)) d.baseVersionId = null;
  }); renderHistory(id); toast(`已清理 ${ids.size} 个旧版本`);
});

// Backup import is validated before any transaction is started.
function renderBackup() {
  const s = repo.state; $('backup-stats').replaceChildren(...[['项目', s.projects.length], ['配置集', s.configs.length], ['归档版本', s.versions.length], ['当前草稿', s.drafts.length]].map(([label, count]) => el('div', { class: 'stat' }, el('strong', { text: String(count) }), el('span', { text: label }))));
  fillSelect('backup-scope', s.configs.map(c => ({ value: c.id, text: configLabel(c) })), '整个工作空间');
}
on('export-backup', 'click', async () => { await flushDraft(); download(`ops-toolkit-backup-${new Date().toISOString().slice(0, 10)}.json`, serialize(exportBackup(repo.state, $('backup-scope').value))); toast('已导出完整备份，文件包含配置原值'); });
on('preview-share', 'click', () => { $('share-preview').hidden = false; $('share-preview').textContent = serialize(exportShare(repo.state, $('backup-scope').value)); });
on('export-share', 'click', () => download('ops-toolkit-redacted-share.json', serialize(exportShare(repo.state, $('backup-scope').value))));
on('backup-file', 'change', async e => {
  imported = null; $('import-backup').disabled = true; const file = e.target.files[0]; if (!file) return;
  if (file.size > LIMITS.backup) throw Error('备份超过 20 MiB');
  try {
    imported = validateBackup(await file.text()); const s = imported.workspace;
    const conflicts = s.configs.filter(c => repo.state.configs.some(x => x.name === c.name && repo.state.projects.find(p => p.id === x.projectId)?.name === s.projects.find(p => p.id === c.projectId)?.name && repo.state.environments.find(e => e.id === x.environmentId)?.name === s.environments.find(e => e.id === c.environmentId)?.name));
    notice('import-preview', `校验通过：${s.projects.length} 个项目，${s.configs.length} 个配置集，${s.versions.length} 个版本，${s.drafts.length} 个草稿。\n${conflicts.length ? '同名冲突：' + conflicts.map(c => c.name).join('、') + '\n将以新项目副本导入，或勾选跳过同名配置。' : '未发现同名冲突。'}`, 'success'); $('import-backup').disabled = false;
  } catch (e) { notice('import-preview', e.message, 'error'); }
});
on('import-backup', 'click', async () => {
  if (!imported) return; await flushDraft();
  const count = await mutate(state => importBackup(state, imported, $('skip-conflicts').checked, $('import-settings').checked));
  imported = null; $('import-backup').disabled = true; $('backup-file').value = ''; applySettings(); renderBackup(); renderConfigs(); notice('import-preview', `成功导入 ${count} 个配置集，所有关联已重映射。`, 'success');
});
on('reload-data', 'click', async () => {
  if (!await modal('重新载入本地数据', [el('p', { text: '将读取其他标签页写入的最新数据。如有未保存草稿，确认前请先下载草稿，重新载入会放弃当前内存编辑。' })], '重新载入')) return;
  clearTimeout(saveTimer); await mutationQueue; await repo.reload(); dirty = false; editing = null; selected = ''; $('config-detail').hidden = true; $('config-empty').hidden = false; applySettings(); renderBackup(); renderConfigs(); renderHistory(); toast('已载入本地最新数据');
});
function applySettings() { document.documentElement.dataset.theme = repo.state.settings.theme; const next = repo.state.settings.sort || 'asc'; if ($('sort').value !== next) { $('sort').value = next; staleOutput(); } }
on('theme-toggle', 'click', async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  if (repo.persistent) await mutate(s => { s.settings.theme = next; }); else repo.state.settings.theme = next;
  document.documentElement.dataset.theme = next;
});
on('settings-open', 'click', async () => {
  const auto = el('input', { type: 'checkbox', checked: repo.state.settings.autoArchiveEnabled }), days = field('证书到期提醒阈值（天）', repo.state.settings.expiryWarningDays, { type: 'number', min: 0, max: 3650, required: true });
  const sort = el('select', {}, opt('asc', '自动排序 · 升序'), opt('desc', '自动排序 · 降序'), opt('none', '保持原序')); sort.value = repo.state.settings.sort || 'asc';
  if (!await modal('工具设置', [el('label', { class: 'check' }, auto, '自动归档有效改动（间隔至少 60 秒）'), days.node, el('label', { text: '默认排序' }, sort), el('p', { text: '已纳管草稿在停止输入 800 毫秒后保存。数据仅存于当前浏览器来源，建议定期导出备份。' })], '保存设置')) return;
  const apply = s => { s.settings.autoArchiveEnabled = auto.checked; s.settings.expiryWarningDays = Number(days.input.value); s.settings.sort = sort.value; };
  if (repo.persistent) await mutate(apply); else apply(repo.state); applySettings(); staleOutput(); if (certificates.length) renderCertificates(); toast('设置已更新');
});
async function initialize() {
  loadExample('basic');
  repo.onUnavailable = message => { $('storage-status').textContent = '本地存储已断开'; toast(message, true); };
  try { await repo.open(); $('storage-status').textContent = '● 本地存储已连接'; $('storage-status').className = 'pill good'; }
  catch (e) { $('storage-status').textContent = '临时模式 · 存储不可用'; toast(e.message, true); }
  applySettings(); renderConfigs(); renderBackup(); renderHistory();
  const drafts = repo.state.drafts.filter(d => d.rawInput !== repo.state.versions.find(v => v.id === d.baseVersionId)?.rawInput);
  if (drafts.length) toast(`发现 ${drafts.length} 份未归档草稿，可在配置管理中打开继续编辑。`);
}
initialize().catch(e => toast(e.message, true));
