import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBackup } from '../server/legacy-backup.js';
import { legacyBackup } from './fixtures/legacy-backup.mjs';

test('historical backup validation preserves valid history and invalid draft recovery', () => {
  const backup = legacyBackup();
  backup.workspace.drafts[0].rawInput = '{unfinished';
  backup.workspace.recoveryDrafts.push({ ...backup.workspace.drafts[0], id: 'recovery-1' });
  const validated = validateBackup(JSON.stringify(backup));
  assert.equal(Object.getPrototypeOf(validated), null);
  assert.deepEqual(JSON.parse(JSON.stringify(validated)), backup);
});

test('historical backup validation rejects tampering, broken references and invalid metadata', () => {
  for (const edit of [
    b => { b.schemaVersion = 999; },
    b => { b.redacted = true; },
    b => { b.workspace.configs[0].latestVersionId = 'missing'; },
    b => { b.workspace.versions[0].normalizedContent.a = 2; },
    b => { b.workspace.versions[0].rawInput = '{"a":2}'; },
    b => { b.workspace.versions.push(structuredClone(b.workspace.versions[0])); },
    b => { b.workspace.drafts[0].configSetId = 'missing'; },
    b => { b.workspace.drafts[0].baseVersionId = 'missing'; },
    b => { b.workspace.drafts[0].rawInput = 'x'.repeat(1024 * 1024 + 1); },
    b => { b.workspace.environments[0].projectId = 'missing'; },
    b => { b.workspace.settings.expiryWarningDays = -1; },
  ]) {
    const backup = legacyBackup();
    edit(backup);
    assert.throws(() => validateBackup(JSON.stringify(backup)));
  }
});
