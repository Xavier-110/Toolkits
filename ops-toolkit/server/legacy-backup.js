// Read-only validation for historical v1/v2 imports. No browser storage runtime.
import { parseInput, parseJSON, contentHash, serialize, LIMITS, object } from '../src/core.js';

const configVersions = (state, id) => state.versions.filter(v => v.configSetId === id).sort((a, b) => b.versionNumber - a.versionNumber);
function normalizeDraft(draft, kind) {
  const p = parseInput(draft.rawInput, draft.inputFormat, draft.options?.coerce || false);
  if (p.kind !== kind) throw Error('输入格式与配置类型不一致，请另存为新的配置集');
  return p;
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
