import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJSON, toggleFormat, detectFormat, fieldRows, jsonFieldLocations, validateDescriptions, descriptionIssues, snapshotHash, maskConfiguration } from '../src/config-model.js';

test('strict normalization and reversible YAML', () => {
  const input = '{"env":[{"name":"A","valueFrom":{"fieldRef":{"fieldPath":"metadata.name"}}}]}';
  const first = normalizeJSON(input);
  assert.equal(first.kind, 'k8s-env');
  const yaml = toggleFormat(input);
  assert.equal(yaml.format, 'yaml');
  assert.deepEqual(toggleFormat(yaml.text).data, first.data);
  assert.throws(() => toggleFormat('{"a":1,"a":2}'));
  assert.throws(() => toggleFormat('{"a":1,}'));
  assert.throws(() => toggleFormat('{"a":9007199254740993}'));
  assert.throws(() => toggleFormat(''));
  assert.throws(() => toggleFormat('9007199254740993'));
  assert.throws(() => toggleFormat('1.0000000000000001'));
  assert.throws(() => toggleFormat('true garbage'));
  assert.throws(() => detectFormat('// comment\ntrue'));
  assert.throws(() => detectFormat('/* comment */\n42'));
  assert.throws(() => detectFormat('[/*comment*/42]'));
  assert.throws(() => detectFormat('[1,//comment\n2]'));
  assert.throws(() => detectFormat('{a: /*comment*/42}'));
  for (const invalid of ['[01]', '[+1]', '[.5]', '[0x10]', '[true garbage]', '"\\x41"', '["\\x41"]']) assert.throws(() => detectFormat(invalid), invalid);
  for (const invalid of ['[[01]]', '[[+1]]', '[[.5]]', '[[true garbage]]', '01', '+1', '.5', '0x10']) assert.throws(() => detectFormat(invalid), invalid);
  assert.equal(detectFormat("['\\x41']").format, 'yaml');
  assert.equal(detectFormat("literal: '\\x41'").format, 'yaml');
  assert.equal(detectFormat('{foo: bar}').format, 'yaml');
  assert.equal(detectFormat('{url: "https://example/x", text: "/*literal*/"}').format, 'yaml');
  assert.equal(detectFormat('{foo: bar}').format, 'yaml');
  assert.equal(detectFormat('[foo, bar]').format, 'yaml');
  assert.throws(() => detectFormat('[1,2,]'));
  assert.equal(detectFormat('{foo: "# literal"}').hasComments, false);
  assert.equal(detectFormat('foo: bar # real').hasComments, true);
  assert.equal(normalizeJSON('{"env":[]}').kind, 'k8s-env');
  assert.throws(() => normalizeJSON('{"env":[{"name":"x","foo":1}]}'));
});

test('flow classification validates every scalar and preserves unambiguous YAML', () => {
  const invalid = ['01', '+1', '.5', '0x10', 'true garbage', 'false garbage', 'null garbage', '1e', '1.', '"\\x41"'];
  for (const token of invalid) {
    for (const input of [`[${token}]`, `[{},${token}]`, `[[],${token}]`, `[{},[],[${token}]]`, `[{}, {"nested":${token}}]`]) {
      assert.throws(() => detectFormat(input), input);
    }
  }
  for (const input of ['"foo": bar', '"foo": 123', '"foo":\n  nested: true']) {
    const detected = detectFormat(input);assert.equal(detected.format, 'yaml');assert.deepEqual(toggleFormat(input).data, detected.data);
  }
  for (const input of ['"foo" # note', '123 # note', 'true # note']) { assert.equal(detectFormat(input).format, 'yaml');assert.equal(detectFormat(input).hasComments, true); }
  for (const input of ['[{}, foo, 1]', '[[], {foo: bar}]', '{foo: "literal ,] and \\\"key\\\": text"}', "['it''s literal ,]', '\\x41']", '{url: https://example.test/x}']) assert.equal(detectFormat(input).format, 'yaml', input);
});

test('sensitive paths and env names are masked on a clone', () => {
  const data = { password: { token: 'secret' }, env: [{ name: 'API_KEY', value: 'abc' }, { name: 'NORMAL', value: 'ok' }] };
  const masked = maskConfiguration(data);
  assert.equal(masked.password, '••••');
  assert.equal(masked.env[0].value, 'abc');
  assert.equal(maskConfiguration({ env: data.env }).env[0].value, '••••');
  assert.equal(data.env[0].value, 'abc');
  assert.deepEqual(maskConfiguration(data, {}, true), data);
  assert.equal(maskConfiguration([{ name: 'API_KEY', value: 'abc' }], { '!API_KEY': true })[0].value, 'abc');
  assert.equal(maskConfiguration({ a: 1 }, { '/': true }), '••••');
});

test('JSON field locations point to values and stable env names', () => {
  const input = '{"a/b":{"~x":[1,true]},"env":[{"name":"TOKEN","value":"abc"}]}';
  const spans = jsonFieldLocations(input);
  const text = path => input.slice(spans.get(path).start, spans.get(path).end);
  assert.equal(text('/a~1b/~0x/1'), 'true');
  assert.equal(text('/env/0/value'), '"abc"');
  const envInput = '{"env":[{"name":"TOKEN","value":"abc"}]}';
  const envSpan = jsonFieldLocations(envInput).get('env:TOKEN');
  assert.equal(envInput.slice(envSpan.start, envSpan.end), '"abc"');
  assert.equal(text(''), input);
});

test('field description locations cover each complete key/value pair without the root braces',()=>{
  const input='{"host": "localhost", "port": 8080, "nested": {"a/b": true}, "": null}';
  const spans=jsonFieldLocations(input);
  const pair=path=>{const span=spans.get(path);return input.slice(span.pairStart,span.pairEnd);};
  assert.equal(pair('/host'),'"host": "localhost"');assert.equal(pair('/port'),'"port": 8080');
  assert.equal(pair('/nested/a~1b'),'"a/b": true');assert.equal(pair('/'),'"": null');
  assert.equal(spans.get('').pairStart,undefined);
});

test('nested business env arrays use full JSON Pointer keys', () => {
  const data = { one: { env: [{ name: 'X', value: 'one' }] }, two: { env: [{ name: 'X', value: 'two' }] } };
  const rows = fieldRows(data), keys = rows.map(row => row.key);
  assert(keys.includes('/one/env/0/value'));
  assert(keys.includes('/two/env/0/value'));
  assert(!keys.includes('env:X'));
  const descriptions = validateDescriptions(data, { '/one/env/0/value': 'one', '/two/env/0/value': 'two' });
  assert.equal(Object.keys(descriptions).length, 2);
  assert.deepEqual(descriptionIssues(data, { ...data, one: { env: [] } }, descriptions), ['/one/env/0/value']);
  const input = JSON.stringify(data), spans = jsonFieldLocations(input);
  assert.equal(input.slice(spans.get('/two/env/0/value').start, spans.get('/two/env/0/value').end), '"two"');
  assert(!spans.has('env:X'));
  assert.deepEqual(maskConfiguration(data, { '/one/env/0/value': true }), { one: { env: [{ name: 'X', value: '••••' }] }, two: { env: [{ name: 'X', value: 'two' }] } });
});

test('descriptions use stable env names and flag changed arrays', () => {
  const data = { env: [{ name: 'A', value: 'x' }], arr: ['a', 'b'], 'a/b': null };
  const keys = fieldRows(data).map(row => row.key);
  assert(keys.includes('/env/0/value'));
  assert(keys.includes('/a~1b'));
  const map = validateDescriptions(data, { '/env/0/value': 'help', '/arr/0': 'first' });
  assert.deepEqual(descriptionIssues(data, { ...data, arr: ['b', 'a'] }, map), ['/arr/0']);
  assert.throws(() => validateDescriptions(data, { '/missing': 'x' }));
  assert.equal(validateDescriptions({ env: data.env }, { 'env:A': '<b>x</b>' })['env:A'], '<b>x</b>');
  assert.equal(normalizeJSON('{"env":[],"other":1}').kind, 'json');
  assert.equal(normalizeJSON('[{"name":"x","other":1}]').kind, 'json');
});

test('snapshot hash ignores object order but includes descriptions', () => {
  const a = { jsonContent: '{"a":1,"b":2}', fieldDescriptions: {}, itemMetadata: {}, description: '', tags: [] };
  assert.equal(snapshotHash(a), snapshotHash({ ...a, jsonContent: '{"b":2,"a":1}' }));
  assert.notEqual(snapshotHash(a), snapshotHash({ ...a, fieldDescriptions: { '/a': 'help' } }));
});
