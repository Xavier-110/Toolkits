import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ApiRepository } from '../src/api.js';
import { createWorkspaceState } from '../src/workspace-state.js';

test('online initial state and session reset discard data without sharing mutable defaults', () => {
  const repo = new ApiRepository();
  const initial = createWorkspaceState();
  assert.deepEqual(repo.state, initial);
  repo.state.configs.push({ id: 'private' });
  repo.state.dictionaries.regions.push({ id: 'region' });
  repo.user = { id: 'user' };
  repo.csrf = 'token';
  repo.persistent = true;
  repo.clear();
  assert.deepEqual(repo.state, initial);
  assert.equal(repo.user, null);
  assert.equal(repo.csrf, '');
  assert.equal(repo.persistent, false);
  assert.deepEqual(createWorkspaceState(), initial);
});

const root = fileURLToPath(new URL('..', import.meta.url));
test('retired offline entry points and dependencies cannot return', () => {
  for (const file of ['../ops_toolkit.html', 'src/app.js', 'src/index.html', 'src/store.js', 'serve.mjs', 'tests/browser.mjs', 'tests/store.test.mjs']) {
    assert.equal(existsSync(path.join(root, file)), false, file);
  }
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.serve, undefined);
  assert.equal(pkg.devDependencies['fake-indexeddb'], undefined);
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/fake-indexeddb'], undefined);
  function check(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) check(file);
      else if (entry.name.endsWith('.js')) {
        assert.doesNotMatch(readFileSync(file, 'utf8'), /(?:from\s*['"][^'"]*\/store\.js['"]|\bindexedDB\b|\bshouldAutoArchive\b)/, file);
      }
    }
  }
  check(path.join(root, 'src'));
  check(path.join(root, 'server'));
});
