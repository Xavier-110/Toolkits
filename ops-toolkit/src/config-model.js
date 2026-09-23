import { stringify as yamlStringify, parseDocument, isMap, isSeq, isScalar } from 'yaml';
import { parseJSON, parseYAML, serialize, hash, pointer, own, validateEnv, sensitiveName, compare, hasExpansion } from './core.js';

function jsonLikeScalar(text) {
  const trimmed = text.trimStart();
  return /^(?:[-+]?(?:\d|\.\d)|true\b|false\b|null\b|"|\{\s*")/.test(trimmed);
}
function outsideQuotes(text) {
  let result = '';
  let quote = '', escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      result += ' ';
      if (escaped) escaped = false;
      else if (quote === '"' && ch === '\\') escaped = true;
      else if (quote === "'" && ch === "'" && text[i + 1] === "'") { result += ' '; i++; }
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") { quote = ch; result += 's'; }
    else result += ch;
  }
  return result;
}
function jsonErrorMustWin(text) {
  const trimmed = text.trim();
  if (/^\/\//.test(trimmed) || /^\/\*/.test(trimmed)) return true;
  const doc = parseDocument(text, { uniqueKeys: true, intAsBigInt: true, strict: true });
  // A block mapping may start with a quoted key. Its complete syntax, rather
  // than its first character, identifies it as YAML.
  const root = doc.contents;
  if ((isMap(root) || isSeq(root)) && !root.flow) return false;
  if (doc.errors.length || doc.warnings.length) return false; // parseYAML reports these.
  const invalidJSON = source => { try { parseJSON(source); return false; } catch { return true; } };
  if (isScalar(root)) return (root.type === 'QUOTE_DOUBLE' || root.type === 'PLAIN' && jsonLikeScalar(trimmed)) && invalidJSON(text.slice(root.range[0], root.range[1]));
  const syntax = outsideQuotes(trimmed);
  if (/\/\*|(^|[\s\[,{])\/\//.test(syntax) || /,\s*[}\]]/.test(syntax)) return true;
  function invalid(node, depth = 0) {
    if (depth > 100) return true;
    if (!node) return false;
    if (isMap(node)) {
      // Quoted-key flow objects also form JSON syntax; do not reinterpret an
      // invalid JSON value, duplicate key or missing value as valid YAML.
      if (node.flow && node.items.every(pair => pair.key?.type === 'QUOTE_DOUBLE') && invalidJSON(text.slice(node.range[0], node.range[1]))) return true;
      return node.items.some(pair => invalid(pair.key, depth + 1) || invalid(pair.value, depth + 1));
    }
    if (isSeq(node)) return node.items.some(item => !item || invalid(item, depth + 1));
    if (!isScalar(node)) return false;
    const source = text.slice(node.range[0], node.range[1]);
    return (node.type === 'QUOTE_DOUBLE' || node.type === 'PLAIN' && (typeof node.value !== 'string' || jsonLikeScalar(source))) && invalidJSON(source);
  }
  return invalid(root);
}
const envArray = data => Array.isArray(data) && data.length > 0 && data.every(x => x && typeof x === 'object' && !Array.isArray(x) && typeof x.name === 'string' && Object.keys(x).every(k => ['name', 'value', 'valueFrom'].includes(k)));
const isEnv = data => envArray(data) || data && !Array.isArray(data) && typeof data === 'object' && Object.keys(data).length === 1 && Array.isArray(data.env);
function checked(data) { if (isEnv(data)) validateEnv(Array.isArray(data) ? data : data.env); return data; }
export function normalizeJSON(text) {
  const data = checked(parseJSON(text));
  return { data, jsonContent: serialize(data, 'asc'), kind: isEnv(data) ? 'k8s-env' : 'json' };
}
export function detectFormat(text) {
  if (!text.trim()) throw Error('请先输入配置内容');
  let data, format, warnings = [];
  try { data = checked(parseJSON(text)); format = 'json'; }
  catch (error) {
    if (jsonErrorMustWin(text)) throw error;
    data = checked(parseYAML(text)); format = 'yaml';
  }
  if (isEnv(data)) {
    const entries = Array.isArray(data) ? data : data.env;
    warnings.push(...validateEnv(entries).warnings.filter(message => !message.includes('已补全空字符串')));
    if (entries.some(row => !own(row, 'value') && !own(row, 'valueFrom'))) warnings.push('缺省 value 按空字符串理解，结构保持原样');
  }
  let hasComments = false;
  if (format === 'yaml') {
    const doc = parseDocument(text);
    const visit = node => {
      if (!node) return;
      if (node.comment || node.commentBefore) hasComments = true;
      if (isMap(node)) node.items.forEach(pair => { visit(pair.key); visit(pair.value); });
      else if (isSeq(node)) node.items.forEach(visit);
    };
    hasComments = !!(doc.comment || doc.commentBefore); visit(doc.contents);
  }
  return { format, data, hasComments, warnings };
}
export function toggleFormat(text) {
  const detected = detectFormat(text);
  const format = detected.format === 'json' ? 'yaml' : 'json';
  return { ...detected, format, text: format === 'json' ? serialize(detected.data, 'asc') : yamlStringify(detected.data, { lineWidth: 0 }) };
}
function simpleEnvironment(data) {
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).length !== 1 || !Array.isArray(data.env)) throw Error('YAML 环境变量需要 env: 下的 name/value 列表');
  const result=Object.create(null);
  for (const row of data.env) {
    if (!row || typeof row!=='object' || Array.isArray(row) || Object.keys(row).some(k=>!['name','value'].includes(k)) || typeof row.value!=='string') throw Error('简单 env 仅支持 name 和字符串 value，不支持缺省值或 valueFrom');
    validateEnv([row]);
    if(own(result,row.name))throw Error(`重复环境变量：${row.name}`);
    result[row.name]=row.value;
  }
  return result;
}
export function conversionJSON(text,sort='asc') {
  const detected=detectFormat(text);
  const data=detected.data && !Array.isArray(detected.data) && typeof detected.data==='object' && own(detected.data,'env') ? simpleEnvironment(detected.data) : detected.data;
  const confirmations=sort!=='none'&&data&&typeof data==='object'&&Object.values(data).some(value=>typeof value==='string'&&hasExpansion(value))?['变量展开可能依赖原始顺序，排序后请检查 $(...) 引用。']:[];
  return {...detected,format:'json',data,text:serialize(data,sort),confirmations};
}
export function environmentConversion(text,sort='asc') {
  if(!['asc','desc','none'].includes(sort))throw Error('排序方式无效');
  const detected=detectFormat(text),confirmations=[];
  let data=detected.data;
  if(detected.format==='yaml') {
    if(data && typeof data==='object' && !Array.isArray(data) && own(data,'env'))data=simpleEnvironment(data);
    if(!data || typeof data!=='object' || Array.isArray(data) || Object.values(data).some(v=>typeof v!=='string'))throw Error('YAML 需要简单 env 或字符串键值对象');
    if(sort!=='none'&&Object.values(data).some(v=>typeof v==='string'&&hasExpansion(v)))confirmations.push('排序可能改变环境变量展开结果，可取消并选择保持原序。');
    return {...detected,data,format:'json',text:serialize(data,sort),confirmations};
  }
  if(!data || typeof data!=='object' || Array.isArray(data))throw Error('转换 env 需要变量名作 key 的 JSON 对象');
  let keys=Object.keys(data);if(sort!=='none')keys.sort((a,b)=>compare(a,b)*(sort==='desc'?-1:1));
  if(keys.length>5000)throw Error('环境变量不能超过5000项');
  let coerced=false;
  const env=keys.map(name=>{
    const value=data[name];
    if(value===null || !['string','boolean','number'].includes(typeof value))throw Error(`字段 ${name} 不是简单环境变量，不能转换 null、对象或数组`);
    if(typeof value!=='string')coerced=true;
    return {name,value:String(value)};
  });
  validateEnv(env);
  if(coerced)confirmations.push('数字和布尔值将转换为环境变量字符串，转回 JSON 后保留字符串类型。');
  if(sort!=='none'&&Object.values(data).some(v=>typeof v==='string'&&hasExpansion(v)))confirmations.push('排序可能改变环境变量展开结果，可取消并选择保持原序。');
  return {...detected,data:{env},format:'yaml',text:yamlStringify({env},{lineWidth:0}),confirmations};
}
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
export function fieldRows(data) {
  const rows = [];
  const walk = (value, path, name) => {
    rows.push({ key: path, path, name, value, type: typeOf(value) });
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}/${i}`, String(i)));
    else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) {
      if (path === '' && isEnv(data) && key === 'env' && Array.isArray(v)) {
        rows.push({ key: `${path}/env`, path: `${path}/env`, name: key, value: v, type: 'array' });
        v.forEach(row => rows.push({ key: `env:${row.name}`, path: `env:${row.name}`, name: row.name, value: own(row, 'valueFrom') ? row.valueFrom : row.value, type: own(row, 'valueFrom') ? 'reference' : 'string' }));
      } else walk(v, `${path}/${pointer(key)}`, key);
    }
  };
  if (isEnv(data) && Array.isArray(data)) data.forEach(row => rows.push({ key: `env:${row.name}`, path: `env:${row.name}`, name: row.name, value: own(row, 'valueFrom') ? row.valueFrom : row.value, type: own(row, 'valueFrom') ? 'reference' : 'string' }));
  else walk(data, '', '$');
  return rows;
}
export function jsonFieldLocations(text) {
  const data = parseJSON(text), locations = new Map(); let at = 0;
  const ws = () => { while (/\s/.test(text[at] || '') && at < text.length) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') break;
    }
    return JSON.parse(text.slice(start, at));
  };
  const read = path => {
    ws(); const start = at, ch = text[at];
    if (ch === '{') {
      at++; ws();
      while (text[at] !== '}') {
        const pairStart = at, key = string(); ws(); at++; // colon
        const fieldPath = `${path}/${pointer(key)}`;
        read(fieldPath);
        Object.assign(locations.get(fieldPath), { pairStart, pairEnd: at });
        ws();
        if (text[at] === ',') { at++; ws(); } else break;
      }
      at++;
    } else if (ch === '[') {
      at++; ws(); let index = 0;
      while (text[at] !== ']') {
        read(`${path}/${index++}`); ws();
        if (text[at] === ',') { at++; ws(); } else break;
      }
      at++;
    } else if (ch === '"') string();
    else while (at < text.length && !/[\s,\]}]/.test(text[at])) at++;
    locations.set(path, { start, end: at });
  };
  read('');
  const env = Array.isArray(data) && isEnv(data) ? { rows: data, prefix: '' } : data && !Array.isArray(data) && isEnv(data) ? { rows: data.env, prefix: '/env' } : null;
  if (env) env.rows.forEach((row, i) => {
    const suffix = own(row, 'valueFrom') ? 'valueFrom' : own(row, 'value') ? 'value' : 'name';
    const span = locations.get(`${env.prefix}/${i}/${suffix}`);
    const entry = locations.get(`${env.prefix}/${i}`);
    if (span) locations.set(`env:${row.name}`, { ...span, pairStart: entry.start + 1, pairEnd: entry.end - 1 });
  });
  return locations;
}
export function validateDescriptions(data, map = {}) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw Error('字段说明必须为对象');
  const valid = new Set(fieldRows(data).map(row => row.key)), result = Object.create(null);
  for (const [key, value] of Object.entries(map)) {
    if (!valid.has(key)) throw Error(`无效字段说明路径：${key}`);
    if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw Error(`字段说明必须为纯文本且不超过 2000 字符：${key}`);
    result[key] = value;
  }
  return result;
}
export function descriptionIssues(oldData, newData, map = {}) {
  const before = new Map(fieldRows(oldData).map(row => [row.key, row]));
  const after = new Map(fieldRows(newData).map(row => [row.key, row]));
  return Object.keys(map).filter(key => {
    if (!after.has(key)) return true;
    if (!before.has(key)) return true;
    if (key.startsWith('env:')) return false;
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) if (/^\d+$/.test(parts[i])) {
      const parent = parts.slice(0, i).join('/');
      if (serialize(before.get(parent)?.value, 'asc', 0) !== serialize(after.get(parent)?.value, 'asc', 0)) return true;
    }
    return false;
  });
}
export function snapshotHash(payload) {
  const content = typeof payload.jsonContent === 'string' ? normalizeJSON(payload.jsonContent).data : payload.data;
  return hash(serialize({ modelVersion: 1, content, fieldDescriptions: payload.fieldDescriptions || {}, itemMetadata: payload.itemMetadata || {}, description: payload.description || '', tags: payload.tags || [] }, 'asc', 0));
}
export function sensitiveField(name,key,itemMetadata={}) {
    const aliases = key.startsWith('env:') ? [key, key.slice(4)] : [key];
    for (const alias of aliases) {
      if (own(itemMetadata, `!${alias}`)) return false;
      if (own(itemMetadata, alias)) return !!itemMetadata[alias];
    }
    return sensitiveName(name);
}
export function maskConfiguration(data, itemMetadata = {}, reveal = false) {
  const copy = structuredClone(data);
  if (reveal) return copy;
  const marked=(name,key)=>sensitiveField(name,key,itemMetadata);
  const maskEnv = rows => rows.forEach(row => { if (marked(row.name, `env:${row.name}`)) { if (own(row, 'value')) row.value = '••••'; if (own(row, 'valueFrom')) row.valueFrom = '••••'; } });
  if (Array.isArray(copy) && isEnv(copy)) { maskEnv(copy); return copy; }
  if (marked('$', '/') && own(itemMetadata, '/')) return '••••';
  const walk = (value, path = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (path === '' && isEnv(data) && key === 'env' && Array.isArray(child)) { maskEnv(child); continue; }
      const childPath = `${path}/${pointer(key)}`;
      if (marked(key, childPath)) value[key] = '••••'; else walk(child, childPath);
    }
  };
  walk(copy); return copy;
}
