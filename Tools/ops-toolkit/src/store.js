import { parseInput, parseJSON, contentHash, serialize, redact, LIMITS, object, byteSize } from './core.js';

export const APP_VERSION = '1.0.0';
export const uuid = () => crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
const now = () => new Date().toISOString();
export const emptyState = () => ({ schemaVersion: 1, revision: 0, projects: [], environments: [], configs: [], versions: [], drafts: [], recoveryDrafts: [], settings: { theme: 'dark', sort: 'asc', autoArchiveEnabled: true, expiryWarningDays: 30 } });
export const configVersions = (state, id) => state.versions.filter(v => v.configSetId === id).sort((a, b) => b.versionNumber - a.versionNumber);
export function normalizeDraft(draft, kind) {
  const p = parseInput(draft.rawInput, draft.inputFormat, draft.options?.coerce || false);
  if (p.kind !== kind) throw Error('输入格式与配置类型不一致，请另存为新的配置集');
  return p;
}
export function makeDraft(rawInput, inputFormat, options = {}) {
  let validationState = 'valid';
  try { parseInput(rawInput, inputFormat, options.coerce || false); } catch (e) { validationState = e.message; }
  return { rawInput, inputFormat, options, validationState, updatedAt: now() };
}
export function addConfig(state, { project, environment, name, type, description = '', tags = [], sourceConfigId = null, itemMetadata = {} }, draft) {
  for (const [label, value] of Object.entries({ 项目: project, 环境: environment, 配置名: name })) if (typeof value !== 'string' || !value.trim() || value.length > 120) throw Error(`${label}须为 1～120 个字符`);
  project = project.trim(); environment = environment.trim(); name = name.trim();
  let p = state.projects.find(x => x.name === project);
  if (!p) { p = { id: uuid(), name: project, createdAt: now() }; state.projects.push(p); }
  let env = state.environments.find(x => x.projectId === p.id && x.name === environment);
  if (!env) { env = { id: uuid(), projectId: p.id, name: environment }; state.environments.push(env); }
  if (state.configs.some(x => x.projectId === p.id && x.environmentId === env.id && x.name === name)) throw Error('该项目和环境下已存在同名配置集');
  const config = { id: uuid(), projectId: p.id, environmentId: env.id, name, type, description, tags, sourceConfigId, createdAt: now(), updatedAt: now(), archivedAt: null, latestVersionId: null, nextVersionNumber: 1, revision: 0, itemMetadata: structuredClone(itemMetadata) };
  state.configs.push(config); saveDraft(state, config.id, draft); archiveVersion(state, config.id, 'create', '首次保存'); return config.id;
}
export function saveDraft(state, id, draft) {
  const config = state.configs.find(c => c.id === id); if (!config) throw Error('配置集不存在');
  if (byteSize(draft.rawInput) > LIMITS.config) throw Error('草稿超过 1 MiB，未写入本地存储；请下载内容后缩减输入');
  const index = state.drafts.findIndex(d => d.configSetId === id);
  const record = { ...draft, configSetId: id, baseVersionId: config.latestVersionId, revision: config.revision + 1, updatedAt: now() };
  if (index < 0) state.drafts.push(record); else state.drafts[index] = record;
  config.revision++; config.updatedAt = now(); return record;
}
export function archiveVersion(state, id, source = 'manual', note = '', restoredFromVersionId = null) {
  const config = state.configs.find(c => c.id === id);
  if (!config || config.archivedAt) throw Error('配置不存在或已归档，请先恢复配置集');
  const draft = state.drafts.find(d => d.configSetId === id), parsed = normalizeDraft(draft, config.type), digest = contentHash(config.type, parsed.data);
  const latest = state.versions.find(v => v.id === config.latestVersionId);
  if (latest?.contentHash === digest) return null;
  const version = { id: uuid(), configSetId: id, versionNumber: config.nextVersionNumber++, modelVersion: 1, rawInput: draft.rawInput, inputFormat: draft.inputFormat, options: structuredClone(draft.options), normalizedContent: parsed.data, contentHash: digest, itemMetadata: structuredClone(config.itemMetadata), source, note, createdAt: now(), restoredFromVersionId };
  state.versions.push(version); config.latestVersionId = version.id; config.updatedAt = now(); config.revision++; draft.baseVersionId = version.id; return version;
}
export function restoreVersion(state, id, versionId) {
  const config = state.configs.find(c => c.id === id), target = state.versions.find(v => v.id === versionId && v.configSetId === id);
  if (!config || !target) throw Error('目标版本不存在');
  const latest = state.versions.find(v => v.id === config.latestVersionId), draft = state.drafts.find(d => d.configSetId === id);
  // Preserve the actual draft, including invalid or formatting-only edits.
  if (draft && (!latest || draft.rawInput !== latest.rawInput || draft.inputFormat !== latest.inputFormat)) state.recoveryDrafts.push({ ...structuredClone(draft), id: uuid(), reason: `恢复 v${target.versionNumber} 前的草稿`, createdAt: now() });
  if (latest?.contentHash === target.contentHash && draft?.rawInput === target.rawInput) return null;
  saveDraft(state, id, makeDraft(target.rawInput, target.inputFormat, target.options));
  config.itemMetadata = structuredClone(target.itemMetadata || {});
  return archiveVersion(state, id, 'restore', `恢复自 v${target.versionNumber}`, target.id);
}
export function shouldAutoArchive(state, id, lastEdit, clock = Date.now()) {
  const c = state.configs.find(x => x.id === id); if (!c || c.archivedAt || !state.settings.autoArchiveEnabled || clock - lastEdit < 2000) return false;
  const latest = state.versions.find(v => v.id === c.latestVersionId);
  if (latest && clock - Date.parse(latest.createdAt) < 60000) return false;
  try { return contentHash(c.type, normalizeDraft(state.drafts.find(d => d.configSetId === id), c.type).data) !== latest?.contentHash; } catch { return false; }
}

export class Repository {
  constructor(factory = globalThis.indexedDB, name = 'offline-ops-toolkit-v1') { this.factory = factory; this.name = name; this.state = emptyState(); this.db = null; this.persistent = false; }
  async open() {
    if (!this.factory) throw Error('浏览器不支持本地数据库，已进入临时模式');
    this.db = await new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('workspace')) request.result.createObjectStore('workspace'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('数据库升级被其他标签页阻塞，请关闭旧页面后重试'));
    });
    this.db.onversionchange = () => { this.db.close(); this.persistent = false; this.onUnavailable?.('数据库版本已变化，请刷新页面'); };
    await this.reload(); this.persistent = true; return this.state;
  }
  async reload() {
    const state = await new Promise((resolve, reject) => { const r = this.db.transaction('workspace').objectStore('workspace').get('state'); r.onsuccess = () => resolve(r.result || emptyState()); r.onerror = () => reject(r.error); });
    if (state.schemaVersion !== 1) throw Error('数据库版本不兼容，原始数据已保留');
    this.state = state; return state;
  }
  async mutate(fn) {
    if (!this.persistent) throw Error('本地持久化不可用；请下载当前内容，临时模式不能保存配置');
    const expected = this.state.revision;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('workspace', 'readwrite'), store = tx.objectStore('workspace'), get = store.get('state');
      let next, result, failure;
      get.onsuccess = () => {
        try {
          const current = get.result || emptyState();
          if (current.revision !== expected) throw Error('其他标签页已修改数据：请下载当前草稿后点击“重新载入本地数据”，或另存内容。未覆盖任何数据。');
          next = structuredClone(current); result = fn(next); next.revision = current.revision + 1; store.put(next, 'state');
        } catch (e) { failure = e; tx.abort(); }
      };
      tx.oncomplete = () => { this.state = next; resolve(result); };
      tx.onabort = () => reject(failure || tx.error || Error('数据库事务失败，内容未保存'));
      tx.onerror = () => { failure ||= tx.error; };
    });
  }
}

export function exportBackup(state, configId = '') {
  const copy = structuredClone(state);
  if (configId) {
    copy.configs = copy.configs.filter(c => c.id === configId);
    copy.versions = copy.versions.filter(v => v.configSetId === configId);
    copy.drafts = copy.drafts.filter(d => d.configSetId === configId);
    copy.recoveryDrafts = copy.recoveryDrafts.filter(d => d.configSetId === configId);
    copy.environments = copy.environments.filter(e => copy.configs.some(c => c.environmentId === e.id));
    copy.projects = copy.projects.filter(p => copy.configs.some(c => c.projectId === p.id));
  }
  return { schemaVersion: 1, toolVersion: APP_VERSION, exportedAt: now(), redacted: false, workspace: copy };
}
export function exportShare(state, configId = '') {
  return { schemaVersion: 1, redacted: true, exportedAt: now(), configs: state.configs.filter(c => !configId || c.id === configId).map(c => {
    const version = state.versions.find(v => v.id === c.latestVersionId);
    return { name: c.name, type: c.type, environment: state.environments.find(e => e.id === c.environmentId)?.name, content: redact(version.normalizedContent, c.type, c.itemMetadata) };
  }) };
}
export function validateBackup(text) {
  const b = parseJSON(text, LIMITS.backup), fail = message => { throw Error(`备份无效：${message}`); };
  if (b.redacted !== false) fail('脱敏分享包不能恢复');
  if (b.schemaVersion !== 1 || !object(b.workspace) || b.workspace.schemaVersion !== 1) fail('不支持的备份版本');
  const s = b.workspace;
  const sets = {};
  for (const key of ['projects', 'environments', 'configs', 'versions', 'drafts', 'recoveryDrafts']) {
    if (!Array.isArray(s[key])) fail(`${key} 缺失`);
    sets[key] = new Set();
    for (const row of s[key]) {
      const id = key === 'drafts' ? row?.configSetId : row?.id;
      if (!object(row) || typeof id !== 'string' || !id || sets[key].has(id)) fail(`${key} ID 缺失或重复`);
      sets[key].add(id);
    }
  }
  const string = v => typeof v === 'string' && v.trim().length > 0;
  const date = v => string(v) && Number.isFinite(Date.parse(v));
  const projectNames = new Set();
  for (const p of s.projects) { if (!string(p.name) || projectNames.has(p.name)) fail('项目名为空或重复'); projectNames.add(p.name); }
  const envNames = new Set(), configNames = new Set();
  for (const e of s.environments) {
    const key = serialize([e.projectId, e.name], 'none', 0);
    if (!sets.projects.has(e.projectId) || !string(e.name) || envNames.has(key)) fail('环境关联或名称错误'); envNames.add(key);
  }
  for (const c of s.configs) {
    const key = serialize([c.projectId, c.environmentId, c.name], 'none', 0);
    if (!sets.projects.has(c.projectId) || !s.environments.some(e => e.id === c.environmentId && e.projectId === c.projectId) || !string(c.name) || configNames.has(key)) fail('配置集关联或名称错误'); configNames.add(key);
    if (!['json', 'k8s-env'].includes(c.type) || !Array.isArray(c.tags) || c.tags.some(x => typeof x !== 'string') || typeof c.description !== 'string' || !object(c.itemMetadata) || Object.values(c.itemMetadata).some(v => typeof v !== 'boolean')) fail('配置元数据错误');
    const versions = configVersions(s, c.id), latest = versions[0];
    if (!latest || latest.id !== c.latestVersionId || !Number.isSafeInteger(c.nextVersionNumber) || c.nextVersionNumber <= latest.versionNumber || !sets.drafts.has(c.id)) fail('配置集版本指针错误');
    if (new Set(versions.map(v => v.versionNumber)).size !== versions.length) fail('版本号重复');
  }
  for (const v of s.versions) {
    const c = s.configs.find(c => c.id === v.configSetId);
    if (!c || v.modelVersion !== 1 || !Number.isSafeInteger(v.versionNumber) || v.versionNumber < 1 || !date(v.createdAt) || !['json', 'yaml', 'env-json'].includes(v.inputFormat) || !object(v.options)) fail('版本元数据错误');
    if (!object(v.itemMetadata) || Object.values(v.itemMetadata).some(x => typeof x !== 'boolean')) fail('版本敏感标记错误');
    if (v.restoredFromVersionId && !s.versions.some(x => x.id === v.restoredFromVersionId && x.configSetId === c.id && x.versionNumber < v.versionNumber)) fail('恢复来源错误');
    if (contentHash(c.type, v.normalizedContent) !== v.contentHash || contentHash(c.type, normalizeDraft(v, c.type).data) !== v.contentHash) fail('版本内容摘要不匹配');
  }
  for (const d of [...s.drafts, ...s.recoveryDrafts]) {
    if (!sets.configs.has(d.configSetId) || typeof d.rawInput !== 'string' || !['json', 'yaml', 'env-json'].includes(d.inputFormat) || !object(d.options)) fail('草稿结构错误');
    if (new TextEncoder().encode(d.rawInput).length > LIMITS.config) fail('草稿超过 1 MiB');
    if (d.baseVersionId && !s.versions.some(v => v.id === d.baseVersionId && v.configSetId === d.configSetId)) fail('草稿版本引用错误');
  }
  if (!object(s.settings) || !['dark', 'light'].includes(s.settings.theme) || typeof s.settings.autoArchiveEnabled !== 'boolean' || !Number.isFinite(s.settings.expiryWarningDays) || s.settings.expiryWarningDays < 0 || s.settings.expiryWarningDays > 3650) fail('设置错误');
  return b;
}
export function importBackup(state, backup, skipConflicts = false, importSettings = true) {
  const incoming = backup.workspace, mapping = new Map(); let count = 0;
  const skipped = new Set();
  for (const c of incoming.configs) {
    const project = incoming.projects.find(p => p.id === c.projectId).name, env = incoming.environments.find(e => e.id === c.environmentId).name;
    if (skipConflicts && state.configs.some(x => x.name === c.name && state.projects.find(p => p.id === x.projectId)?.name === project && state.environments.find(e => e.id === x.environmentId)?.name === env)) skipped.add(c.id);
  }
  const accepted = incoming.configs.filter(c => !skipped.has(c.id));
  for (const p of incoming.projects.filter(p => accepted.some(c => c.projectId === p.id))) {
    const copy = { ...p, id: uuid(), name: uniqueName(p.name, state.projects.map(x => x.name)) }; mapping.set(p.id, copy.id); state.projects.push(copy);
  }
  for (const e of incoming.environments.filter(e => accepted.some(c => c.environmentId === e.id))) { const copy = { ...e, id: uuid(), projectId: mapping.get(e.projectId) }; mapping.set(e.id, copy.id); state.environments.push(copy); }
  for (const c of accepted) mapping.set(c.id, uuid());
  for (const v of incoming.versions.filter(v => mapping.has(v.configSetId))) mapping.set(v.id, uuid());
  for (const c of accepted) { state.configs.push({ ...structuredClone(c), id: mapping.get(c.id), projectId: mapping.get(c.projectId), environmentId: mapping.get(c.environmentId), latestVersionId: mapping.get(c.latestVersionId), sourceConfigId: mapping.get(c.sourceConfigId) || null, revision: 0 }); count++; }
  for (const v of incoming.versions.filter(v => mapping.has(v.configSetId))) state.versions.push({ ...structuredClone(v), id: mapping.get(v.id), configSetId: mapping.get(v.configSetId), restoredFromVersionId: mapping.get(v.restoredFromVersionId) || null });
  for (const key of ['drafts', 'recoveryDrafts']) for (const d of incoming[key].filter(d => mapping.has(d.configSetId))) state[key].push({ ...structuredClone(d), ...(key === 'recoveryDrafts' ? { id: uuid() } : {}), configSetId: mapping.get(d.configSetId), baseVersionId: mapping.get(d.baseVersionId) || null, revision: 0 });
  if (importSettings) state.settings = structuredClone(incoming.settings);
  return count;
}
function uniqueName(name, names) { if (!names.includes(name)) return name; let i = 1; while (names.includes(`${name}（导入 ${i}）`)) i++; return `${name}（导入 ${i}）`; }
