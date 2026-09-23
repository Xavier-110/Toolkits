// Fixed historical schema, independent of the retired application implementation.
export function legacyWorkspace({ project = 'P', environment = 'E', name = 'N', description = '' } = {}) {
  const createdAt = '2026-09-21T00:00:00.000Z';
  return {
    schemaVersion: 1, revision: 0,
    projects: [{ id: 'project-1', name: project, createdAt }],
    environments: [{ id: 'environment-1', projectId: 'project-1', name: environment }],
    configs: [{ id: 'config-1', projectId: 'project-1', environmentId: 'environment-1', name,
      type: 'json', description, tags: [], itemMetadata: {}, sourceConfigId: null,
      createdAt, updatedAt: createdAt, archivedAt: null, latestVersionId: 'version-1', nextVersionNumber: 2, revision: 2 }],
    versions: [{ id: 'version-1', configSetId: 'config-1', versionNumber: 1, modelVersion: 1,
      rawInput: '{"a":1}', inputFormat: 'json', options: {}, normalizedContent: { a: 1 },
      contentHash: '34a0e483523cecb4654bd5260de4de0f8e8a8f02b4265e158851b6b53f7172c0', itemMetadata: {}, source: 'create', note: '', createdAt, restoredFromVersionId: null }],
    drafts: [{ configSetId: 'config-1', rawInput: '{"a":1}', inputFormat: 'json', options: {},
      validationState: 'valid', updatedAt: createdAt, baseVersionId: 'version-1', revision: 1 }],
    recoveryDrafts: [], settings: { theme: 'dark', sort: 'asc', autoArchiveEnabled: true, expiryWarningDays: 30 }
  };
}

export function legacyBackup(workspace = legacyWorkspace(), schemaVersion = 1) {
  return { schemaVersion, toolVersion: '1.0.0', exportedAt: '2026-09-21T00:00:00.000Z', redacted: false, workspace: structuredClone(workspace) };
}
