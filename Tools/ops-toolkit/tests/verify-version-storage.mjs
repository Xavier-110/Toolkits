import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
const fingerprint=()=>JSON.parse(execFileSync(process.execPath,['tests/verify-candidate.mjs','--fingerprint'],{encoding:'utf8',maxBuffer:1024*1024}).trim().replace(/^CANDIDATE_INPUT /,''));
const before=fingerprint();console.log('CANDIDATE_INPUT',JSON.stringify(before));
// One fail-fast entry point for Native checks. All services use temporary data.
const commands=[['--test','tests/*.test.mjs'],['build.mjs'],['tests/navigation-browser.mjs'],['tests/manual-online-browser.mjs'],['tests/version-management-browser.mjs'],['tests/environment-browser.mjs'],['tests/ui-boundaries.mjs'],['tests/browser.mjs']];
for(const args of commands){console.log('CHECK node '+args.join(' '));const result=spawnSync(process.execPath,args,{stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
const after=fingerprint();if(before.sourceSHA256!==after.sourceSHA256)throw Error('Candidate source changed during verification');console.log('CANDIDATE_VERIFIED',JSON.stringify(after));
console.log('PASS local candidate checks; real MySQL / PostgreSQL / Oracle require separate test:databases evidence');
