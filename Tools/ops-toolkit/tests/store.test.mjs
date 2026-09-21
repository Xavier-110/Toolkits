import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { Repository, addConfig, makeDraft, saveDraft, archiveVersion, restoreVersion, configVersions, shouldAutoArchive, exportBackup, exportShare, validateBackup, importBackup } from '../src/store.js';

async function fixture() {
  const repo = new Repository(indexedDB, crypto.randomUUID()); await repo.open();
  const id = await repo.mutate(s => addConfig(s, { project: 'Test', environment: 'dev', name: 'app', type: 'json' }, makeDraft('{"A":"one","PASSWORD":"sensitive"}', 'json')));
  return { repo, id };
}
test('draft survives repository reopen including invalid content', async () => {
  const { repo, id } = await fixture(); await repo.mutate(s => saveDraft(s, id, makeDraft('{invalid', 'json')));
  const reopened = new Repository(indexedDB, repo.name); await reopened.open();
  assert.equal(reopened.state.drafts[0].rawInput, '{invalid'); assert.notEqual(reopened.state.drafts[0].validationState, 'valid'); assert.equal(reopened.state.versions.length, 1);
});
test('only changed valid content is archived', async () => {
  const { repo, id } = await fixture();
  await repo.mutate(s => saveDraft(s, id, makeDraft('{ "PASSWORD": "sensitive", "A": "one" }', 'json')));
  assert.equal(await repo.mutate(s => archiveVersion(s, id)), null);
  await repo.mutate(s => saveDraft(s, id, makeDraft('{invalid', 'json')));
  await assert.rejects(repo.mutate(s => archiveVersion(s, id)));
  assert.equal(repo.state.versions.length, 1);
});
test('auto archive waits for 2s idle and 60s since last version independently of typing', async () => {
  const { repo, id } = await fixture(), initial = Date.parse(repo.state.versions[0].createdAt);
  await repo.mutate(s => saveDraft(s, id, makeDraft('{"A":"two"}', 'json')));
  assert.equal(shouldAutoArchive(repo.state, id, initial + 59000, initial + 60000), false);
  assert.equal(shouldAutoArchive(repo.state, id, initial + 5000, initial + 59999), false);
  assert.equal(shouldAutoArchive(repo.state, id, initial + 5000, initial + 60001), true);
  await repo.mutate(s => archiveVersion(s, id, 'auto'));
  assert.equal(repo.state.versions.length, 2);
});
test('v5 restoring v2 creates v6 and preserves invalid draft', async () => {
  const { repo, id } = await fixture();
  for (let i = 2; i <= 5; i++) await repo.mutate(s => { saveDraft(s, id, makeDraft(JSON.stringify({ A: String(i) }), 'json')); archiveVersion(s, id); });
  const v2 = repo.state.versions.find(v => v.versionNumber === 2);
  await repo.mutate(s => saveDraft(s, id, makeDraft('{unfinished', 'json')));
  const restored = await repo.mutate(s => restoreVersion(s, id, v2.id));
  assert.equal(restored.versionNumber, 6); assert.equal(restored.restoredFromVersionId, v2.id);
  assert.equal(repo.state.recoveryDrafts[0].rawInput, '{unfinished'); assert.equal(repo.state.versions.length, 6);
  assert.equal(restored.contentHash, v2.contentHash);
});
test('concurrent tabs cannot silently overwrite drafts or versions', async () => {
  const { repo, id } = await fixture(), other = new Repository(indexedDB, repo.name); await other.open();
  await repo.mutate(s => saveDraft(s, id, makeDraft('{"A":"tab1"}', 'json')));
  await assert.rejects(other.mutate(s => saveDraft(s, id, makeDraft('{"A":"tab2"}', 'json'))), /其他标签页/);
  await other.reload(); assert.equal(other.state.drafts[0].rawInput, '{"A":"tab1"}');
});
test('thrown mutation is atomic and never changes committed state', async () => {
  const { repo, id } = await fixture(), before = JSON.stringify(repo.state);
  await assert.rejects(repo.mutate(s => { saveDraft(s, id, makeDraft('{}', 'json')); throw Error('simulated storage failure'); }), /simulated/);
  assert.equal(JSON.stringify(repo.state), before); await repo.reload(); assert.equal(JSON.stringify(repo.state), before);
});
test('backup validates and imports all versions, associations and recovery drafts as copies', async () => {
  const { repo, id } = await fixture();
  await repo.mutate(s => { saveDraft(s, id, makeDraft('{"A":"two"}', 'json')); archiveVersion(s, id); saveDraft(s, id, makeDraft('invalid', 'json')); restoreVersion(s, id, s.versions[0].id); });
  const backup = validateBackup(JSON.stringify(exportBackup(repo.state)));
  const next = new Repository(indexedDB, crypto.randomUUID()); await next.open();
  assert.equal(await next.mutate(s => importBackup(s, backup)), 1);
  assert.notEqual(next.state.configs[0].id, id);
  assert.equal(next.state.versions.length, 3); assert.equal(next.state.recoveryDrafts[0].rawInput, 'invalid');
  assert.equal(next.state.versions[2].restoredFromVersionId, next.state.versions[0].id);
  validateBackup(JSON.stringify(exportBackup(next.state)));
});
test('malformed, tampered, redacted and future-version backups are rejected', async () => {
  const { repo } = await fixture();
  const b = exportBackup(repo.state);
  for (const edit of [x => x.schemaVersion = 999, x => x.workspace.configs[0].latestVersionId = 'missing', x => x.workspace.versions[0].normalizedContent.A = 'tampered', x => x.workspace.versions.push(x.workspace.versions[0]), x => x.workspace.versions[0].rawInput = '{"A":"changed"}', x => x.workspace.drafts[0].configSetId = 'missing']) {
    const changed = structuredClone(b); edit(changed); assert.throws(() => validateBackup(JSON.stringify(changed)));
  }
  assert.throws(() => validateBackup(JSON.stringify(exportShare(repo.state))), /脱敏/);
  assert.ok(!JSON.stringify(exportShare(repo.state)).includes('sensitive'));
});
test('same-name imports can be skipped and copies stay independent', async () => {
  const { repo } = await fixture(), backup = validateBackup(JSON.stringify(exportBackup(repo.state)));
  assert.equal(await repo.mutate(s => importBackup(s, backup, true)), 0);
  assert.equal(await repo.mutate(s => importBackup(s, backup)), 1);
  assert.equal(repo.state.projects[1].name, 'Test（导入 1）');
  assert.notEqual(repo.state.configs[0].id, repo.state.configs[1].id);
});
test('storage unavailable fails explicitly', async () => {
  const repo = new Repository(null); await assert.rejects(repo.open(), /临时模式/); await assert.rejects(repo.mutate(s => s.configs.push({})), /持久化不可用/);
});
test('oversized drafts remain outside committed storage and original data stays intact', async () => {
  const { repo, id } = await fixture(), before = repo.state.drafts[0].rawInput;
  await assert.rejects(repo.mutate(s => saveDraft(s, id, makeDraft('x'.repeat(1024 * 1024 + 1), 'json'))), /1 MiB/);
  assert.equal(repo.state.drafts[0].rawInput, before);
});
test('copied configuration retains explicit sensitive metadata in its first snapshot', async () => {
  const { repo, id } = await fixture();
  const newId = await repo.mutate(s => addConfig(s, { project: 'Test', environment: 'prod', name: 'copy', type: 'json', sourceConfigId: id, itemMetadata: { '/A': true } }, makeDraft('{"A":"custom-sensitive"}', 'json')));
  assert.equal(repo.state.configs.find(c => c.id === newId).itemMetadata['/A'], true);
  assert.equal(configVersions(repo.state, newId)[0].itemMetadata['/A'], true);
  assert.ok(!JSON.stringify(exportShare(repo.state, newId)).includes('custom-sensitive'));
});
test('incompatible stored schema is rejected without deleting or replacing data', async () => {
  const { repo } = await fixture();
  const future = structuredClone(repo.state); future.schemaVersion = 99;
  await new Promise((resolve, reject) => { const tx = repo.db.transaction('workspace', 'readwrite'); tx.objectStore('workspace').put(future, 'state'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  const newRepo = new Repository(indexedDB, repo.name); await assert.rejects(newRepo.open(), /不兼容/);
  const stored = await new Promise((resolve, reject) => { const r = repo.db.transaction('workspace').objectStore('workspace').get('state'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  assert.deepEqual(stored, future); assert.equal(newRepo.persistent, false);
});
