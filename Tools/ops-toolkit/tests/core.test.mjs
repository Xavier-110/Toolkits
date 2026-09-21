import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, parseInput, parseJSON, parseYAML, serialize, hasExpansion, compare, contentHash, diff, redact } from '../src/core.js';

test('JSON → YAML → JSON preserves strings including escapes and empty values', () => {
  const original = { PORT: '8080', DEBUG: 'false', EMPTY: '', Z: '  001  ', A: '中文😀\n"\\:#' };
  const yaml = convert(JSON.stringify(original), { format: 'json', target: 'yaml' });
  const back = convert(yaml.text, { format: 'yaml', target: 'json' });
  assert.deepEqual(JSON.parse(back.text), original);
  assert.match(yaml.text, /value: "false"/);
});
test('duplicate JSON keys are rejected including escaped equivalents', () => {
  assert.throws(() => parseJSON('{"a":1,"\\u0061":2}'), /重复键/);
  assert.throws(() => parseJSON('{"x":{"b":1,"b":2}}'), /重复键/);
});
test('strict JSON syntax rejects unsupported extensions', () => {
  for (const text of ['{"a":1,}', '[1,]', '01', 'NaN', '// hi\n{}', 'true false', '{a:1}', '"\n"']) assert.throws(() => parseJSON(text), undefined, text);
});
test('numbers that would lose precision are rejected', () => {
  for (const text of ['9007199254740993', '1e100', '1e999', '1e-999', '0.1234567890123456789']) assert.throws(() => parseJSON(text), /数字/);
  assert.equal(parseJSON('1.250e-1'), 0.125);
  assert.throws(() => parseYAML('- name: A\n  value: 9007199254740993'), /安全范围/);
});
test('YAML duplicates and unsupported constructs fail', () => {
  for (const text of ['a: 1\na: 2', 'a: &a hi\nb: *a', 'a: !custom hi', 'a: !!str 1', 'a: 1\n---\nb: 2', 'a:\n  <<: {}']) assert.throws(() => parseYAML(text), undefined, text);
  assert.equal(parseYAML('- name: A\n  value: |\n    line1\n    line2\n')[0].value, 'line1\nline2\n');
});
test('env names and source fields are validated without dropping data', () => {
  for (const raw of ['[{"name":"A"},{"name":"A"}]', '[{"name":"A","value":"x","valueFrom":{}}]', '[{"name":"A","unknown":1}]', '[{"name":"A=B","value":"x"}]', '[{"name":"","value":"x"}]']) assert.throws(() => parseInput(raw, 'env-json'));
  const missing = parseInput('[{"name":"A"}]', 'env-json'); assert.equal(missing.data[0].value, ''); assert.equal(missing.warnings.length, 1);
});
test('all four valueFrom sources round trip and cannot flatten', () => {
  const refs = [ { secretKeyRef: { name: 'secret', key: 'password', optional: true } }, { configMapKeyRef: { name: 'config', key: 'port' } }, { fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.name' } }, { resourceFieldRef: { resource: 'limits.cpu', divisor: '1m' } } ];
  const original = refs.map((valueFrom, i) => ({ name: `REF_${i}`, valueFrom }));
  const yaml = convert(JSON.stringify(original), { format: 'env-json', target: 'yaml', sort: 'none' });
  const json = convert(yaml.text, { format: 'yaml', target: 'env-json', sort: 'none' });
  assert.deepEqual(JSON.parse(json.text), original);
  assert.throws(() => convert(yaml.text, { format: 'yaml', target: 'json' }), /不能转换/);
  assert.throws(() => parseInput('[{"name":"A","valueFrom":{"secretKeyRef":{"name":"s"}}}]', 'env-json'), /key/);
});
test('number/boolean coercion is explicit, nested values and null stay invalid', () => {
  assert.throws(() => convert('{"PORT":8080}', { format: 'json' }), /字符串/);
  const result = convert('{"PORT":8080,"DEBUG":false}', { format: 'json', target: 'env-json', coerce: true });
  assert.equal(result.data[0].value, 'false');
  for (const val of ['null', '{}', '[]']) assert.throws(() => convert(`{"A":${val}}`, { format: 'json', coerce: true }));
});
test('deterministic code point sorting includes integer keys, nested keys and preserves arrays', () => {
  const raw = '{"2":"two","10":"ten","KEY_2":{},"KEY_10":{"z":1,"a":2},"list":[3,1,2]}';
  const out = convert(raw, { format: 'json', target: 'json' }).text;
  assert.ok(out.indexOf('"10"') < out.indexOf('"2"'));
  assert.ok(out.indexOf('KEY_10') < out.indexOf('KEY_2'));
  assert.deepEqual(JSON.parse(out).list, [3, 1, 2]);
  assert.equal(convert(out, { format: 'json', target: 'json' }).text, out);
  assert.ok(compare('\uE000', '😀') < 0);
  assert.equal(serialize(parseJSON('{"2":0,"1":0}'), 'none', 0), '{"2":0,"1":0}');
});
test('expansion detection follows paired dollar escapes', () => {
  for (const [text, expected] of [['$(A)', true], ['$$(A)', false], ['$$$(A)', true], ['$$$$(A)', false], ['x$(A)${B}', true], ['$(unclosed', false], ['${A}', false]]) assert.equal(hasExpansion(text), expected, text);
});
test('dependency order is preserved even for unresolved forward references', () => {
  const raw = '[{"name":"Z","value":"$(A)"},{"name":"A","value":"later"}]';
  const result = convert(raw, { format: 'env-json', target: 'env-json' });
  assert.equal(result.data[0].name, 'Z'); assert.match(result.warnings.join(), /跳过/);
  assert.throws(() => convert(raw, { format: 'env-json', target: 'json' }), /不能转换/);
  assert.throws(() => convert('{"A":"$(B)"}', { format: 'json' }), /执行顺序/);
});
test('prototype-like names and scripts stay inert data', () => {
  const result = convert('{"__proto__":"<script>alert(1)</script>","constructor":"safe"}', { format: 'json', target: 'yaml' });
  const back = convert(result.text, { format: 'yaml', target: 'json' });
  assert.equal(JSON.parse(back.text).__proto__, '<script>alert(1)</script>'); assert.equal({}.polluted, undefined);
});
test('size, depth and count limits reject oversized input', () => {
  assert.throws(() => parseJSON('"' + 'x'.repeat(1024 * 1024) + '"'), /超过/);
  assert.throws(() => parseJSON('['.repeat(102) + '0' + ']'.repeat(102)), /深度/);
  assert.throws(() => parseInput(JSON.stringify(Array.from({ length: 5001 }, (_, i) => ({ name: `K_${i}` }))), 'env-json'), /5,000/);
});
test('auto detection requests explicit handling of ambiguous env arrays', () => {
  assert.throws(() => parseInput('[{"name":"A","value":"x"}]'), /明确选择/);
  assert.equal(parseInput('env:\n  - name: A\n    value: "x"').kind, 'k8s-env');
});
test('canonical hashes ignore formatting and object order but preserve arrays and types', () => {
  assert.equal(contentHash('json', { a: 1, b: 2 }), contentHash('json', { b: 2, a: 1 }));
  assert.notEqual(contentHash('json', [1, 2]), contentHash('json', [2, 1]));
  assert.notEqual(contentHash('json', 1), contentHash('json', '1'));
});
test('semantic diff captures order, source changes and masks sensitive values', () => {
  const a = [{ name: 'PASSWORD', value: 'old-value' }, { name: 'A', value: '1' }], b = [{ name: 'A', value: '1' }, { name: 'PASSWORD', valueFrom: { secretKeyRef: { name: 's', key: 'x' } } }];
  const result = diff(a, b, 'k8s-env');
  assert.ok(result.some(r => r.type === '引用来源修改')); assert.equal(result.filter(r => r.type === '顺序调整').length, 2);
  assert.ok(!JSON.stringify(result).includes('old-value'));
  assert.equal(redact({ db: { password: 'secret' }, public: 'safe' }, 'json').db.password, '*** 已脱敏 ***');
});
test('JSON diff masks sensitive descendants when an entire parent is added or changes type', () => {
  const data = { database: { password: 'do-not-disclose', public: 'hello' } };
  for (const rows of [diff({}, data, 'json'), diff(data, {}, 'json'), diff(data, { database: 'disabled' }, 'json')]) assert.ok(!JSON.stringify(rows).includes('do-not-disclose'));
  assert.ok(JSON.stringify(diff({}, data, 'json', {}, true)).includes('do-not-disclose'));
});
