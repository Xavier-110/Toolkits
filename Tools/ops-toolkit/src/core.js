import { parseDocument, isAlias, isMap, isSeq, isScalar, stringify as yamlStringify } from 'yaml';
import { sha256 } from '@noble/hashes/sha2.js';

export const LIMITS = { config: 1024 * 1024, backup: 20 * 1024 * 1024, cert: 5 * 1024 * 1024, depth: 100, env: 5000 };
const keyOrders = new WeakMap();
export const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
export const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const byteSize = text => new TextEncoder().encode(text).length;
export const hash = value => Array.from(sha256(typeof value === 'string' ? new TextEncoder().encode(value) : value), b => b.toString(16).padStart(2, '0')).join('');
export const compare = (a, b) => {
  const aa = Array.from(a, x => x.codePointAt(0)), bb = Array.from(b, x => x.codePointAt(0));
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
};
const decimal = text => {
  let [m, e = '0'] = text.toLowerCase().split('e');
  const negative = m.startsWith('-'); m = m.replace(/^[+-]/, '');
  let exp = Number(e) - (m.includes('.') ? m.length - m.indexOf('.') - 1 : 0);
  m = m.replace('.', '').replace(/^0+/, '');
  if (!m) return '0';
  while (m.endsWith('0')) { m = m.slice(0, -1); exp++; }
  return `${negative ? '-' : ''}${m}e${exp}`;
};
function safeNumber(source, value) {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw Error('数字超出安全范围，请用字符串表示');
  if (source && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(source) && decimal(source) !== decimal(String(value))) throw Error('数字精度会丢失，请用字符串表示');
  return value;
}

// A strict JSON reader detects duplicate keys before they can be overwritten.
export function parseJSON(text, maxBytes = LIMITS.config) {
  if (byteSize(text) > maxBytes) throw Error(`输入超过 ${maxBytes / 1024 / 1024} MiB 限制`);
  let i = 0;
  const fail = message => { const before = text.slice(0, i).split('\n'); throw Error(`${message}（行 ${before.length}，列 ${before.at(-1).length + 1}）`); };
  const ws = () => { while (/[\x20\t\n\r]/.test(text[i] || '\0')) i++; };
  function str() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') { try { return JSON.parse(text.slice(start, i)); } catch { fail('无效的 JSON 字符串'); } }
    }
    fail('字符串未闭合');
  }
  function read(depth) {
    if (depth > LIMITS.depth) fail('嵌套深度超过 100');
    ws(); const c = text[i];
    if (c === '"') return str();
    if (c === '{') {
      i++; ws(); const result = Object.create(null), order = []; keyOrders.set(result, order);
      if (text[i] === '}') { i++; return result; }
      while (i < text.length) {
        ws(); if (text[i] !== '"') fail('对象键必须使用双引号');
        const key = str(); if (own(result, key)) fail(`重复键 ${JSON.stringify(key)}`);
        ws(); if (text[i++] !== ':') fail('缺少冒号');
        result[key] = read(depth + 1); order.push(key); ws();
        if (text[i] === '}') { i++; return result; }
        if (text[i++] !== ',') fail('缺少逗号或右花括号');
      }
      fail('对象未闭合');
    }
    if (c === '[') {
      i++; ws(); const result = [];
      if (text[i] === ']') { i++; return result; }
      while (i < text.length) {
        result.push(read(depth + 1)); ws();
        if (text[i] === ']') { i++; return result; }
        if (text[i++] !== ',') fail('缺少逗号或右方括号');
      }
      fail('数组未闭合');
    }
    for (const [literal, val] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(literal, i)) { i += literal.length; return val; }
    const match = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (match) { i += match[0].length; try { return safeNumber(match[0], Number(match[0])); } catch (e) { fail(e.message); } }
    fail('无效的 JSON 值');
  }
  const result = read(0); ws(); if (i !== text.length) fail('存在多余内容或非法数字'); return result;
}

export function serialize(value, sort = 'asc', indent = 2, level = 0) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const pad = n => ' '.repeat(n * indent), sep = indent ? ': ' : ':';
  let parts;
  if (Array.isArray(value)) parts = value.map(v => serialize(v, sort, indent, level + 1));
  else {
    let keys = keyOrders.get(value) || Object.keys(value);
    if (sort !== 'none') keys = [...keys].sort((a, b) => compare(a, b) * (sort === 'desc' ? -1 : 1));
    parts = keys.map(k => JSON.stringify(k) + sep + serialize(value[k], sort, indent, level + 1));
  }
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return !parts.length ? open + close : indent ? `${open}\n${pad(level + 1)}${parts.join(`,\n${pad(level + 1)}`)}\n${pad(level)}${close}` : open + parts.join(',') + close;
}

export function parseYAML(text) {
  if (byteSize(text) > LIMITS.config) throw Error('配置输入超过 1 MiB');
  const doc = parseDocument(text, { uniqueKeys: true, intAsBigInt: true, strict: true, prettyErrors: true });
  if (doc.errors.length || doc.warnings.length) throw Error((doc.errors[0] || doc.warnings[0]).message);
  function walk(node, depth = 0) {
    if (depth > LIMITS.depth) throw Error('嵌套深度超过 100');
    if (!node) return null;
    if (node.anchor || node.tag || isAlias(node)) throw Error('首版不支持 YAML 锚点、别名及显式标签');
    if (isMap(node)) {
      const out = Object.create(null), order = []; keyOrders.set(out, order);
      for (const { key, value } of node.items) {
        if (!isScalar(key) || typeof key.value !== 'string') throw Error('YAML 映射键必须为字符串');
        if (key.value === '<<') throw Error('首版不支持 YAML 合并键');
        if (key.anchor || key.tag) throw Error('键不支持锚点或标签');
        if (own(out, key.value)) throw Error(`重复键 ${key.value}`);
        out[key.value] = walk(value, depth + 1); order.push(key.value);
      }
      return out;
    }
    if (isSeq(node)) return node.items.map(v => walk(v, depth + 1));
    if (typeof node.value === 'bigint') {
      if (node.value > BigInt(Number.MAX_SAFE_INTEGER) || node.value < BigInt(Number.MIN_SAFE_INTEGER)) throw Error('数字超出安全范围，请用字符串表示');
      return Number(node.value);
    }
    if (typeof node.value === 'number') return safeNumber(node.source, node.value);
    return node.value;
  }
  return walk(doc.contents);
}

export function hasExpansion(value) {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '$') continue;
    if (value[i + 1] === '$') { i++; continue; }
    if (value[i + 1] === '(' && value.indexOf(')', i + 2) !== -1) return true;
  }
  return false;
}
function onlyKeys(value, allowed, path) {
  for (const k of Object.keys(value)) if (!allowed.includes(k)) throw Error(`${path}.${k}：不支持的字段`);
}
const sources = {
  secretKeyRef: ['name', 'key', 'optional'], configMapKeyRef: ['name', 'key', 'optional'],
  fieldRef: ['apiVersion', 'fieldPath'], resourceFieldRef: ['containerName', 'resource', 'divisor'],
};
export function validateEnv(input, coerce = false) {
  if (!Array.isArray(input)) throw Error('env 必须为数组');
  if (input.length > LIMITS.env) throw Error('env 超过 5,000 项');
  const seen = new Map(), warnings = [], duplicates = [];
  const data = input.map((row, i) => {
    const path = `env[${i}]`;
    if (!object(row)) throw Error(`${path} 必须为对象`);
    onlyKeys(row, ['name', 'value', 'valueFrom'], path);
    if (typeof row.name !== 'string' || !row.name || /[^\x20-\x7e]|=/.test(row.name)) throw Error(`${path}.name：名称须为非空可打印 ASCII，且不能包含 =`);
    if (seen.has(row.name)) duplicates.push(`${row.name}（第 ${seen.get(row.name) + 1}、${i + 1} 项）`);
    else seen.set(row.name, i);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name)) warnings.push(`${row.name}：请确认目标集群的名称兼容性`);
    if (own(row, 'value') && own(row, 'valueFrom')) throw Error(`${path}：value 与 valueFrom 不能同时出现`);
    if (own(row, 'valueFrom')) {
      const ref = row.valueFrom;
      if (!object(ref) || Object.keys(ref).length !== 1 || !own(sources, Object.keys(ref)[0])) throw Error(`${path}.valueFrom：必须指定唯一受支持的引用来源`);
      const kind = Object.keys(ref)[0], details = ref[kind];
      if (!object(details)) throw Error(`${path}.${kind} 必须为对象`);
      onlyKeys(details, sources[kind], `${path}.${kind}`);
      const required = kind.endsWith('KeyRef') ? ['name', 'key'] : [kind === 'fieldRef' ? 'fieldPath' : 'resource'];
      for (const field of required) if (typeof details[field] !== 'string' || !details[field]) throw Error(`${path}.${kind}.${field} 为必填字符串`);
      for (const [key, value] of Object.entries(details)) if (key === 'optional' ? typeof value !== 'boolean' : typeof value !== 'string' || !value) throw Error(`${path}.${kind}.${key} 类型不正确`);
      return { name: row.name, valueFrom: structuredClone(ref) };
    }
    let value = own(row, 'value') ? row.value : '';
    if (!own(row, 'value')) warnings.push(`${row.name}：已补全空字符串`);
    if (typeof value !== 'string') {
      if (coerce && ['number', 'boolean'].includes(typeof value)) { value = String(value); warnings.push(`${row.name}：基本类型已转为字符串`); }
      else throw Error(`${path}.value：必须是字符串；数字和布尔值需开启显式转换`);
    }
    return { name: row.name, value };
  });
  if (duplicates.length) throw Error(`env 重复名称：${duplicates.join('；')}`);
  return { data, warnings };
}

export function parseInput(text, format = 'auto', coerce = false) {
  if (!text.trim()) throw Error('请先输入配置内容');
  if (format === 'auto') {
    if (/^[\[{"\d-]|^(true|false|null)\b/.test(text.trim()) && !/^-(?:\s|$)/.test(text.trim())) {
      const data = parseJSON(text);
      if (Array.isArray(data) && data.length && data.every(row => object(row) && own(row, 'name'))) throw Error('检测到可能的 env 数组，请明确选择“env JSON 数组”或“普通 JSON”');
      return { kind: 'json', data, format: 'json', warnings: [] };
    }
    format = 'yaml';
  }
  if (format === 'json') return { kind: 'json', data: parseJSON(text), format, warnings: [] };
  let data = format === 'env-json' ? parseJSON(text) : parseYAML(text);
  if (object(data)) {
    if (Object.keys(data).length !== 1 || !own(data, 'env')) throw Error('请输入 env 数组或仅含 env 字段的片段；完整工作负载请先提取 env');
    data = data.env;
  }
  return { kind: 'k8s-env', ...validateEnv(data, coerce), format };
}

export function convert(text, { format = 'auto', target = 'yaml', sort = 'asc', coerce = false } = {}) {
  const parsed = parseInput(text, format, coerce), warnings = [...parsed.warnings];
  let data = parsed.data;
  if (target === 'json' && parsed.kind === 'json') return { text: serialize(data, sort), data, kind: 'json', warnings, format: 'json' };
  if (parsed.kind === 'json') {
    if (!object(data)) throw Error('只有 JSON 顶层对象可以转换为 env');
    const keys = keyOrders.get(data) || Object.keys(data);
    const validated = validateEnv(keys.map(name => ({ name, value: data[name] })), coerce);
    data = validated.data; warnings.push(...validated.warnings);
    if (data.some(row => typeof row.value === 'string' && hasExpansion(row.value))) throw Error('含变量展开的 JSON 对象缺少可靠执行顺序，请改用明确有序的 env 数组');
  }
  const dependent = data.some(row => typeof row.value === 'string' && hasExpansion(row.value));
  if (dependent) warnings.push('存在变量引用，已跳过自动排序并保留 env 原序');
  else if (sort !== 'none') data = [...data].sort((a, b) => compare(a.name, b.name) * (sort === 'desc' ? -1 : 1));
  if (target === 'json') {
    if (dependent || data.some(row => row.valueFrom)) throw Error('包含 valueFrom 或变量展开，不能转换为平面 JSON；请切换“env JSON 数组”');
    const flat = Object.create(null); for (const row of data) flat[row.name] = row.value;
    keyOrders.set(flat, data.map(row => row.name));
    return { text: serialize(flat, sort), data: flat, kind: 'json', warnings, format: 'json' };
  }
  const output = target === 'env-json' ? serialize(data, 'none') : yamlStringify(target === 'yaml-list' ? data : { env: data }, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 });
  return { text: output, data, kind: 'k8s-env', warnings, format: target === 'env-json' ? target : 'yaml' };
}

export const contentHash = (kind, data) => hash(serialize({ modelVersion: 1, kind, data }, 'asc', 0));
export const pointer = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
export const sensitiveName = key => /pass(word|wd)?|token|secret|credential|api[_-]?key|private[_-]?key/i.test(key);
export function sensitivePaths(data, kind, metadata = {}) {
  const paths = new Set();
  const marked = (key, path) => own(metadata, path) ? metadata[path] : sensitiveName(key);
  if (kind === 'k8s-env') data.forEach(row => { if (marked(row.name, row.name)) paths.add(row.name); });
  else {
    const walk = (v, path = '') => { if (v && typeof v === 'object') for (const [key, val] of Object.entries(v)) { const p = path + '/' + pointer(key); if (marked(key, p)) paths.add(p); else walk(val, p); } };
    walk(data);
  }
  return paths;
}
export function redact(data, kind, metadata = {}) {
  const result = structuredClone(data), paths = sensitivePaths(data, kind, metadata);
  if (kind === 'k8s-env') return result.map(row => paths.has(row.name) ? { name: row.name, value: '*** 已脱敏 ***' } : row);
  const walk = (v, path = '') => { if (v && typeof v === 'object') for (const key of Object.keys(v)) { const p = path + '/' + pointer(key); if (paths.has(p)) v[key] = '*** 已脱敏 ***'; else walk(v[key], p); } };
  walk(result); return result;
}
export function diff(left, right, kind, metadata = {}, reveal = false) {
  const rows = [], hidden = new Set([...sensitivePaths(left, kind, metadata), ...sensitivePaths(right, kind, metadata)]);
  const add = (path, type, before, after, masked = false) => rows.push({ path, type, before: masked && !reveal ? '••••（敏感内容）' : before, after: masked && !reveal ? '••••（敏感内容）' : after });
  if (kind === 'k8s-env') {
    const a = new Map(left.map((r, i) => [r.name, { r, i }])), b = new Map(right.map((r, i) => [r.name, { r, i }]));
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(key), y = b.get(key), masked = hidden.has(key);
      if (!x || !y) add(key, x ? '删除' : '新增', x?.r, y?.r, masked);
      else {
        if (serialize(x.r, 'asc', 0) !== serialize(y.r, 'asc', 0)) add(key, !!x.r.valueFrom !== !!y.r.valueFrom || (x.r.valueFrom && serialize(x.r.valueFrom, 'asc', 0) !== serialize(y.r.valueFrom, 'asc', 0)) ? '引用来源修改' : '值修改', x.r, y.r, masked);
        if (x.i !== y.i) add(key, '顺序调整', x.i + 1, y.i + 1);
      }
    }
  } else {
    const isHidden = path => [...hidden].some(p => path === p || path.startsWith(p + '/'));
    const walk = (a, b, path = '') => {
      if (serialize(a, 'asc', 0) === serialize(b, 'asc', 0)) return;
      if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b) && !isHidden(path)) {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], path + '/' + pointer(key));
      } else add(path || '/', a === undefined ? '新增' : b === undefined ? '删除' : '修改', a, b, isHidden(path) || [...hidden].some(p => p.startsWith(path + '/')));
    };
    walk(left, right);
  }
  return rows;
}
