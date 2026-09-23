// Each caller receives its own empty online workspace.
export function createWorkspaceState(revision=0){return {schemaVersion:4,versionTags:[],revision,dictionaries:{regions:[],environmentTypes:[],configNames:[]},bindings:[],configs:[],versions:[],legacy:[],recoveryDrafts:[],receipts:[],settings:{expiryWarningDays:30}};}
