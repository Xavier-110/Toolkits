import { hash } from './core.js';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const DEFAULT_MAX = 20 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const ARRAY_KINDS = { configs: 'config', versions: 'version', recoveryDrafts: 'recoveryDraft', legacy: 'legacy' };
const u16 = (a, p, n) => { a[p] = n & 255; a[p + 1] = n >>> 8 & 255; };
const u32 = (a, p, n) => { u16(a, p, n); u16(a, p + 2, n >>> 16); };
const r16 = (a, p) => a[p] | a[p + 1] << 8;
const r32 = (a, p) => (a[p] | a[p + 1] << 8 | a[p + 2] << 16 | a[p + 3] << 24) >>> 0;
function crc32(bytes) {
  let c = -1;
  for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = c & 1 ? c >>> 1 ^ 0xedb88320 : c >>> 1; }
  return (c ^ -1) >>> 0;
}
function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name), crc = crc32(content);
    const local = new Uint8Array(30 + nameBytes.length + content.length);
    u32(local, 0, 0x04034b50); u16(local, 4, 20); u16(local, 8, 0); u32(local, 14, crc); u32(local, 18, content.length); u32(local, 22, content.length); u16(local, 26, nameBytes.length);
    local.set(nameBytes, 30); local.set(content, 30 + nameBytes.length); locals.push(local);
    const central = new Uint8Array(46 + nameBytes.length);
    u32(central, 0, 0x02014b50); u16(central, 4, 20); u16(central, 6, 20); u32(central, 16, crc); u32(central, 20, content.length); u32(central, 24, content.length); u16(central, 28, nameBytes.length); u32(central, 42, offset); central.set(nameBytes, 46); centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, e) => n + e.length, 0);
  const end = new Uint8Array(22); u32(end, 0, 0x06054b50); u16(end, 8, entries.length); u16(end, 10, entries.length); u32(end, 12, centralSize); u32(end, 16, offset);
  const result = new Uint8Array(offset + centralSize + end.length); let at = 0;
  for (const e of [...locals, ...centrals, end]) { result.set(e, at); at += e.length; }
  return result;
}
export function encodeArchive(backup, maxBytes = DEFAULT_MAX) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > DEFAULT_MAX) throw Error('归档分片限制无效');
  const bytes = encoder.encode(JSON.stringify(backup));
  if (bytes.length > MAX_TOTAL) throw Error('归档过大');
  if (bytes.length <= maxBytes) return { filename: 'ops-toolkit-backup.json', bytes, type: 'application/json' };
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw Error('归档必须为对象');
  const header = { ...backup }; for (const key of Object.keys(ARRAY_KINDS)) delete header[key];
  const records = [];
  for (const [key, kind] of Object.entries(ARRAY_KINDS)) {
    if (backup[key] !== undefined && !Array.isArray(backup[key])) throw Error('归档记录必须为数组');
    (backup[key] || []).forEach((record, index) => {
      if (kind === 'legacy' && record && typeof record === 'object' && encoder.encode(JSON.stringify({ kind, records: [{ kind, index, record }] })).length > maxBytes) {
        const stripped = { ...record };
        for (const nested of ['versions', 'drafts', 'recoveryDrafts']) {
          if (!Array.isArray(record[nested])) throw Error('待映射资料结构无效');
          stripped[nested] = [];
          record[nested].forEach((child, childIndex) => records.push({ kind: `legacy-${nested}`, parentIndex: index, index: childIndex, record: child }));
        }
        records.push({ kind, index, record: stripped, split: true });
      } else records.push({ kind, index, record });
    });
  }
  const shards = [];
  const add = (kind, items) => {
    const content = encoder.encode(JSON.stringify({ kind, records: items }));
    if (content.length > maxBytes) throw Error('单条归档记录超过分片限制');
    shards.push({ kind, content, count: items.length, from: items[0]?.index ?? 0, to: items.at(-1)?.index ?? 0 });
  };
  add('header', [{ index: 0, record: header }]);
  for (const kind of ['config', 'version', 'recoveryDraft', 'legacy', 'legacy-versions', 'legacy-drafts', 'legacy-recoveryDrafts']) {
    let group = [];
    for (const item of records.filter(record => record.kind === kind)) {
      if (encoder.encode(JSON.stringify({ kind, records: [...group, item] })).length > maxBytes && group.length) { add(kind, group); group = []; }
      group.push(item);
      if (encoder.encode(JSON.stringify({ kind, records: group })).length > maxBytes) throw Error('单条归档记录超过分片限制');
    }
    if (group.length) add(kind, group);
  }
  const manifest = { archiveVersion: 2, schemaVersion: backup.schemaVersion, exportKind: backup.exportKind ?? null, scope: backup.scope ?? null, topLevelKeys: Object.keys(backup), arraysPresent: Object.fromEntries(Object.keys(ARRAY_KINDS).map(key => [key, Object.hasOwn(backup, key)])),
    exportedAt: backup.exportedAt ?? backup.exportedUtc ?? null, counts: Object.fromEntries(Object.keys(ARRAY_KINDS).map(key => [key, backup[key]?.length || 0])), totalBytes: bytes.length, sha256: hash(bytes), shardCount: shards.length,
    shards: shards.map((shard, i) => ({ name: `parts/${String(i).padStart(5, '0')}.json`, kind: shard.kind, bytes: shard.content.length, sha256: hash(shard.content), count: shard.count, from: shard.from, to: shard.to })) };
  const entries = [['manifest.json', encoder.encode(JSON.stringify(manifest))], ...shards.map((shard, i) => [manifest.shards[i].name, shard.content])];
  return { filename: 'ops-toolkit-backup.zip', bytes: zip(entries), type: 'application/zip' };
}
function unzip(bytes) {
  if (bytes.length < 22) throw Error('ZIP 不完整');
  const end = bytes.length - 22;
  if (r32(bytes, end) !== 0x06054b50 || r16(bytes, end + 20)) throw Error('ZIP 目录不完整');
  const count = r16(bytes, end + 10), size = r32(bytes, end + 12), start = r32(bytes, end + 16);
  if (!count || count > 10000 || start + size !== end) throw Error('ZIP 目录无效');
  const entries = new Map(); let p = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || r32(bytes, p) !== 0x02014b50) throw Error('ZIP 目录损坏');
    const method = r16(bytes, p + 10), crc = r32(bytes, p + 16), compressed = r32(bytes, p + 20), raw = r32(bytes, p + 24), nameLength = r16(bytes, p + 28), extra = r16(bytes, p + 30), comment = r16(bytes, p + 32), offset = r32(bytes, p + 42);
    if (method || compressed !== raw || raw > DEFAULT_MAX || p + 46 + nameLength + extra + comment > end) throw Error('ZIP 条目无效');
    const name = decoder.decode(bytes.slice(p + 46, p + 46 + nameLength));
    if (entries.has(name) || !/^(manifest\.json|parts\/\d{5}\.json)$/.test(name)) throw Error('ZIP 条目名称无效');
    if (offset + 30 > start || r32(bytes, offset) !== 0x04034b50 || r16(bytes, offset + 8) !== 0 || r32(bytes, offset + 18) !== raw || r32(bytes, offset + 22) !== raw) throw Error('ZIP 本地条目损坏');
    const localNameLength = r16(bytes, offset + 26), localExtra = r16(bytes, offset + 28), bodyAt = offset + 30 + localNameLength + localExtra;
    if (bodyAt + raw > start || decoder.decode(bytes.slice(offset + 30, offset + 30 + localNameLength)) !== name) throw Error('ZIP 条目范围无效');
    const body = bytes.slice(bodyAt, bodyAt + raw);
    if (crc32(body) !== crc || r32(bytes, offset + 14) !== crc) throw Error('ZIP 校验失败');
    entries.set(name, body); total += raw; if (total > MAX_TOTAL) throw Error('归档过大');
    p += 46 + nameLength + extra + comment;
  }
  if (p !== end) throw Error('ZIP 目录尾部无效');
  return entries;
}
export function decodeArchive(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX_TOTAL + 1024 * 1024) throw Error('归档过大');
  if (r32(bytes, 0) !== 0x04034b50) return JSON.parse(decoder.decode(bytes));
  const entries = unzip(bytes), rawManifest = entries.get('manifest.json');
  if (!rawManifest || rawManifest.length > 1024 * 1024) throw Error('缺少归档清单');
  const manifest = JSON.parse(decoder.decode(rawManifest));
  if (manifest.archiveVersion !== 2 || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes > MAX_TOTAL || !Number.isSafeInteger(manifest.shardCount) || manifest.shardCount !== manifest.shards?.length || entries.size !== manifest.shardCount + 1 || !manifest.counts || Object.keys(ARRAY_KINDS).some(key => !Number.isSafeInteger(manifest.counts[key]))) throw Error('归档清单无效');
  const collected = { header: [], config: [], version: [], recoveryDraft: [], legacy: [], 'legacy-versions': [], 'legacy-drafts': [], 'legacy-recoveryDrafts': [] };
  manifest.shards.forEach((part, i) => {
    const name = `parts/${String(i).padStart(5, '0')}.json`, data = entries.get(name);
    if (part.name !== name || !data || part.bytes !== data.length || part.sha256 !== hash(data) || !Object.hasOwn(collected, part.kind)) throw Error('归档分片缺失或损坏');
    const shard = JSON.parse(decoder.decode(data));
    if (shard.kind !== part.kind || !Array.isArray(shard.records) || shard.records.length !== part.count || shard.records[0]?.index !== part.from || shard.records.at(-1)?.index !== part.to) throw Error('归档分片范围无效');
    collected[part.kind].push(...shard.records);
  });
  if (collected.header.length !== 1 || Object.entries(ARRAY_KINDS).some(([key, kind]) => collected[kind].length !== manifest.counts[key])) throw Error('归档记录数量不符');
  for (const kind of Object.values(ARRAY_KINDS)) collected[kind].forEach((item, i) => { if (item.index !== i || item.kind !== kind) throw Error('归档记录序号或类型无效'); });
  for (const nested of ['versions', 'drafts', 'recoveryDrafts']) {
    for (const item of collected[`legacy-${nested}`]) {
      const parent = collected.legacy[item.parentIndex];
      if (!parent?.split || !Array.isArray(parent.record[nested]) || item.index !== parent.record[nested].length) throw Error('待映射子记录顺序无效');
      parent.record[nested].push(item.record);
    }
  }
  const header = collected.header[0].record, backup = {};
  if (!Array.isArray(manifest.topLevelKeys) || new Set(manifest.topLevelKeys).size !== manifest.topLevelKeys.length) throw Error('归档字段顺序无效');
  for (const key of manifest.topLevelKeys) {
    if (Object.hasOwn(ARRAY_KINDS, key) && manifest.arraysPresent?.[key]) backup[key] = collected[ARRAY_KINDS[key]].map(item => item.record);
    else if (Object.hasOwn(header, key)) backup[key] = header[key];
    else throw Error('归档字段缺失');
  }
  if (Object.keys(backup).length !== manifest.topLevelKeys.length || Object.keys(header).length + Object.keys(ARRAY_KINDS).filter(key => manifest.arraysPresent?.[key]).length !== manifest.topLevelKeys.length) throw Error('归档字段数量无效');
  if (backup.schemaVersion !== manifest.schemaVersion || (backup.exportKind ?? null) !== manifest.exportKind || JSON.stringify(backup.scope ?? null) !== JSON.stringify(manifest.scope) || (backup.exportedAt ?? backup.exportedUtc ?? null) !== manifest.exportedAt || manifest.totalBytes !== encoder.encode(JSON.stringify(backup)).length || manifest.sha256 !== hash(encoder.encode(JSON.stringify(backup)))) throw Error('归档内容损坏');
  return backup;
}
