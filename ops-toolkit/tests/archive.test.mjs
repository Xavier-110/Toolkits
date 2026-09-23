import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeArchive, decodeArchive } from '../src/archive.js';

test('small JSON archive round trips', () => {
  const backup = { schemaVersion: 3, configs: [{ id: 'x' }] };
  assert.deepEqual(decodeArchive(encodeArchive(backup).bytes), backup);
});

test('large archive uses ZIP and rejects corruption', () => {
  const backup = { schemaVersion: 3, configs: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, jsonContent: 'x'.repeat(100) })) };
  const result = encodeArchive(backup, 1024);
  assert.equal(result.type, 'application/zip');
  assert.deepEqual(decodeArchive(result.bytes), backup);
  const corrupt = result.bytes.slice(); corrupt[100] ^= 1;
  assert.throws(() => decodeArchive(corrupt));
  assert.throws(() => decodeArchive(result.bytes.slice(0, -100)));
});

test('Unicode survives chunk boundaries and manifest records export counts', () => {
  const backup = { schemaVersion: 3, exportKind: 'versions', counts: { configs: 20, versions: 0 }, configs: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, jsonContent: '汉😀'.repeat(20) })) };
  const result = encodeArchive(backup, 513);
  assert.deepEqual(decodeArchive(result.bytes), backup);
  const text = new TextDecoder().decode(result.bytes);
  assert.match(text, /"records"/);
  assert.match(text, /"counts"/);
});

test('real archive over 20 MiB has JSON record shards', () => {
  const backup = { schemaVersion: 4, exportKind: 'configs', versionTags:[{id:'tag-1',configSetId:'config-0',versionId:'v1',name:'release'}],versions:[{id:'v1',configSetId:'config-0'}], configs: Array.from({ length: 22 }, (_, i) => ({ id: `config-${i}`, jsonContent: 'x'.repeat(1000000) })) };
  const encoded = encodeArchive(backup);
  assert.equal(encoded.type, 'application/zip');
  assert.deepEqual(decodeArchive(encoded.bytes), backup);
});

test('archive preserves schema3 top-level field order around record arrays', () => {
  const backup = { schemaVersion: 3, scope: { regionId: 'r1', environmentTypeId: 'e1' }, configs: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, value: 'x'.repeat(100) })), versions: [{ id: 'v1' }], counts: { configs: 20, versions: 1 }, digest: 'original' };
  assert.deepEqual(decodeArchive(encodeArchive(backup, 512).bytes), backup);
  assert.match(new TextDecoder().decode(encodeArchive(backup, 512).bytes), /"scope":\{"regionId":"r1","environmentTypeId":"e1"\}/);
});

test('archive rejects a scope edit even with repaired ZIP CRC', () => {
  const backup = { schemaVersion: 3, scope: { regionId: 'r1' }, configs: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, value: 'x'.repeat(100) })) };
  const bytes = encodeArchive(backup, 512).bytes.slice();
  const manifestLength = bytes[18] | bytes[19] << 8 | bytes[20] << 16 | bytes[21] << 24;
  const nameLength = bytes[26] | bytes[27] << 8;
  const at = 30 + nameLength;
  const before = new TextDecoder().decode(bytes.slice(at, at + manifestLength));
  const after = before.replace('"regionId":"r1"', '"regionId":"r2"');
  assert.notEqual(after, before); bytes.set(new TextEncoder().encode(after), at);
  let crc = -1; for (const byte of bytes.slice(at, at + manifestLength)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? crc >>> 1 ^ 0xedb88320 : crc >>> 1; } crc = (crc ^ -1) >>> 0;
  const view = new DataView(bytes.buffer); view.setUint32(14, crc, true);
  for (let i = at + manifestLength; i < bytes.length - 4; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 16, crc, true); break; }
  assert.throws(() => decodeArchive(bytes), /归档内容损坏/);
});

test('large recovery drafts and nested legacy history are record sharded', () => {
  const legacy = { id: 'legacy-1', schemaVersion: 2, sourceConfigId: 'old-1', versions: Array.from({ length: 20 }, (_, i) => ({ id: `v${i}`, rawInput: '汉😀'.repeat(40) })), drafts: [{ id: 'd1', rawInput: 'draft' }], recoveryDrafts: [] };
  const backup = { schemaVersion: 3, exportKind: 'legacy', recoveryDrafts: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, rawInput: 'x'.repeat(200) })), legacy: [legacy], counts: { legacy: 1, recoveryDrafts: 5 }, digest: 'placeholder' };
  assert.deepEqual(decodeArchive(encodeArchive(backup, 512).bytes), backup);
});

test('single legacy row above 20 MiB splits nested versions', () => {
  const backup = { schemaVersion: 3, exportKind: 'legacy', legacy: [{ id: 'legacy-large', versions: Array.from({ length: 22 }, (_, i) => ({ id: `v${i}`, rawInput: 'x'.repeat(1000000) })), drafts: [], recoveryDrafts: [] }], counts: { legacy: 1 } };
  const archive = encodeArchive(backup);
  assert.equal(archive.type, 'application/zip');
  assert.deepEqual(decodeArchive(archive.bytes), backup);
});
