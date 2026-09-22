import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repo=path.resolve(root,'../..');
const digest=value=>createHash('sha256').update(value).digest('hex');
function files(dir){return readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(x=>x.isDirectory()?files(path.join(dir,x.name)):[path.join(dir,x.name)]);}
export function fingerprint(){
  const sources=[...files('src'),...files('server'),...files('tests'),'package.json','package-lock.json','build.mjs','README.md'].sort();
  const hashes=Object.fromEntries(sources.map(file=>[file.replaceAll('\\','/'),digest(readFileSync(path.join(root,file)))]));
  const git=(...args)=>execFileSync('git',['-c',`safe.directory=${repo.replaceAll('\\','/')}`,'-c','core.safecrlf=false',...args],{cwd:repo,encoding:'utf8',maxBuffer:64*1024*1024}).trim();
  const artifacts=Object.fromEntries(['../ops_toolkit.html','../ops_toolkit_online.html','THIRD_PARTY_LICENSES.txt'].map(file=>[file,digest(readFileSync(path.join(root,file)))]));
  return {root,node:process.version,machine:os.hostname(),platform:`${os.platform()} ${os.release()}`,gitBase:git('rev-parse','HEAD'),trackedDiffSHA256:digest(git('diff','--binary','HEAD','--','Tools')),sourceSHA256:digest(JSON.stringify(hashes)),files:hashes,artifacts};
}
const before=fingerprint();console.log('CANDIDATE_INPUT',JSON.stringify(before));
if(!process.argv.includes('--fingerprint')){
  const commands=[['build.mjs'],['--test',...files('tests').filter(x=>x.endsWith('.test.mjs'))],['tests/browser.mjs'],['tests/manual-online-browser.mjs'],['tests/ui-boundaries.mjs'],['tests/environment-browser.mjs'],['tests/performance.mjs']];
  for(const args of commands){console.log('CHECK',JSON.stringify({command:process.execPath,args,cwd:root}));execFileSync(process.execPath,args,{cwd:root,stdio:'inherit',timeout:180000});}
  const after=fingerprint();if(before.sourceSHA256!==after.sourceSHA256)throw Error('Source changed while checks were running');
  for(const target of [repo,path.resolve(repo,'../Design-doc')]){execFileSync('git',['-c',`safe.directory=${target.replaceAll('\\','/')}`,'diff','--check'],{cwd:target,stdio:'inherit'});console.log('DIFF_CHECK_PASSED',target);}
  console.log('CANDIDATE_VERIFIED',JSON.stringify(after));
}
