import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openDatabase} from '../server/database.js';
import {Workspace} from '../server/workspace.js';

function fixture(t,seed=true){
  const db=openDatabase(':memory:');t.after(()=>db.close());
  for(const role of ['admin','operate','readonly'])db.prepare('INSERT INTO users VALUES (?,?,?,?,1,0,?)').run(role,role,'unused',role,'2026-09-22T00:00:00Z');
  const ws=new Workspace(db,()=>Date.parse('2026-09-22T08:00:00Z'));
  const run=(type,data={},rest={},actor='admin')=>ws.execute({id:actor},{type,data,...rest}).result;
  const add=(kind,code)=>run('dictionary',{kind,code,label:code}).id;
  const preview=target=>ws.environmentDeletePreview({id:'admin'},target);
  const remove=(target,deleteConfigs=false,p=preview(target))=>run('deleteEnvironment',{...target,deleteConfigs,expectedRevision:p.targetRevision,expectedWorkspaceRevision:p.workspaceRevision});
  const f={db,ws,run,add,preview,remove};if(!seed)return f;
  const regionId=add('regions','cn'),environmentTypeId=add('environmentTypes','prod'),configNameId=add('configNames','app');
  run('bindings',{regionId,environmentTypeId,configNameIds:[configNameId]});
  f.data={regionId,environmentTypeId,configNameId,jsonContent:'{"port":80}',fieldDescriptions:{'/port':'端口'},itemMetadata:{},description:'desc',tags:['ops'],note:'',requestId:'first'};
  f.save=(data=f.data)=>{const c=ws.read().configs.find(c=>c.regionId===data.regionId&&c.environmentTypeId===data.environmentTypeId&&c.configNameId===data.configNameId);return run('save',data,c?{id:c.id,expectedRevision:c.revision}:{});};
  return f;
}
const resign=p=>{delete p.digest;p.digest=createHash('sha256').update(JSON.stringify(p)).digest('hex');return p;};
const status=code=>e=>e.status===code;

for(const cascade of [false,true])test(`older schema3 without recoveryDrafts supports preview, export and ${cascade?'cascade':'keep'} deletion`,t=>{
  const {db,ws,save,preview,remove,data}=fixture(t);save();
  const stored=ws.read();delete stored.recoveryDrafts;
  const raw=JSON.stringify(stored);db.prepare('UPDATE workspace SET data=? WHERE id=1').run(raw);
  const target={targetType:'dictionary',kind:'regions',id:data.regionId};
  const p=preview(target);assert.equal(p.counts.recoveryDrafts,0);assert.equal(p.counts.configs,1);
  assert.deepEqual(ws.read(),{...stored,recoveryDrafts:[]});
  const binding=preview({targetType:'binding',id:stored.bindings[0].id});assert.equal(binding.counts.recoveryDrafts,0);
  const backup=ws.export({id:'admin'});assert.deepEqual(backup.recoveryDrafts,[]);assert.equal(backup.versions.length,1);
  assert.equal(db.prepare('SELECT data FROM workspace WHERE id=1').get().data,raw,'read and preview must not rewrite existing data');
  remove(target,cascade,p);const after=ws.read();assert.deepEqual(after.recoveryDrafts,[]);
  assert.deepEqual(after.configs,cascade?[]:stored.configs);assert.deepEqual(after.versions,cascade?[]:stored.versions);
  assert.deepEqual(after.legacy,stored.legacy);assert.equal(after.revision,stored.revision+1);
});

test('schema3 recovery data is preserved and malformed present data is not silently discarded',t=>{
  const {db,ws,save}=fixture(t);const result=save();
  const state=ws.read();state.recoveryDrafts=[{id:'recovery',configSetId:result.configId,rawInput:'unfinished',reason:'legacy',inputFormat:'json'}];
  db.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(state));assert.deepEqual(ws.read().recoveryDrafts,state.recoveryDrafts);
  for(const bad of [null,{},'invalid']){
    const raw=JSON.stringify({...state,recoveryDrafts:bad});db.prepare('UPDATE workspace SET data=? WHERE id=1').run(raw);
    assert.throws(()=>ws.read(),error=>error.status===400&&/recoveryDrafts/.test(error.message));
    assert.equal(db.prepare('SELECT data FROM workspace WHERE id=1').get().data,raw);
  }
});

test('batch bindings reject missing, empty and malformed identities without changes',t=>{
  const {run,ws,data}=fixture(t),before=ws.read(),batch={regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameIds:[data.configNameId]};
  for(const patch of [{configNameIds:[]},{configNameIds:[null]},{regionId:''},{unexpected:true}])assert.throws(()=>run('bindings',{...batch,...patch}),status(400));
  assert.deepEqual(ws.read(),before);
});

test('batch create and restore preserve config history and do not enable disabled existing combinations',t=>{
  const f=fixture(t),{run,ws,add,data,save}=f,second=add('configNames','second');save();
  const batch={regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameIds:[data.configNameId,second,second]};
  const identity={regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameId:data.configNameId};
  run('binding',{...identity,enabled:false,expectedRevision:0});
  assert.deepEqual(run('bindings',batch),{created:1,restored:0,existing:1});
  assert.equal(ws.read().bindings[0].enabled,false);assert.equal(ws.read().versions.length,1);
  const before=ws.read();assert.throws(()=>run('bindings',{...batch,configNameIds:[add('configNames','third'),'missing']}),status(409));
  assert.deepEqual(ws.read().bindings,before.bindings);
  const target={targetType:'binding',id:ws.read().bindings[0].id};f.remove(target);
  assert.throws(()=>run('binding',{...identity,enabled:true,expectedRevision:2}),status(409));
  const history=ws.read().versions;assert.deepEqual(run('bindings',batch),{created:0,restored:1,existing:1});
  assert.equal(ws.read().bindings[0].id,target.id);assert.equal(ws.read().bindings[0].deletedAt,undefined);assert.deepEqual(ws.read().versions,history);
  assert.deepEqual(run('bindings',batch),{created:0,restored:0,existing:2});
  run('dictionary',{kind:'configNames',id:second,enabled:false,expectedRevision:0});
  const state=ws.read();assert.throws(()=>run('bindings',batch),status(409));assert.deepEqual(ws.read(),state);
});

for(const kind of ['regions','environmentTypes','configNames','binding'])for(const cascade of [false,true])test(`${kind} delete ${cascade?'cascade':'keep'} has exact scope including archives, recovery, receipts`,t=>{
  const f=fixture(t),{ws,run,add,data,save}=f,first=save();
  save({...data,jsonContent:'{"port":81}',requestId:'second'});
  const otherRegion=add('regions','eu'),otherType=add('environmentTypes','test'),otherName=add('configNames','copy');
  run('bindings',{regionId:otherRegion,environmentTypeId:otherType,configNameIds:[otherName]});
  const copy=save({...data,regionId:otherRegion,environmentTypeId:otherType,configNameId:otherName,sourceConfigId:first.configId,requestId:'copy'});
  const s=ws.read();s.recoveryDrafts.push({id:'recover',configSetId:first.configId,rawInput:'broken',reason:'old draft',inputFormat:'json'});s.legacy.push({id:'unmapped-marker'});ws.write(s);
  run('archive',{}, {id:first.configId,expectedRevision:s.configs[0].revision});
  const target=kind==='binding'?{targetType:'binding',id:s.bindings[0].id}:{targetType:'dictionary',kind,id:data[{regions:'regionId',environmentTypes:'environmentTypeId',configNames:'configNameId'}[kind]]};
  const before=ws.read(),p=f.preview(target);assert.deepEqual(p.counts,{bindings:1,configs:1,versions:2,recoveryDrafts:1,archived:1});assert.deepEqual(ws.read(),before,'preview is read only');
  f.remove(target,cascade,p);const after=ws.read();
  assert.deepEqual(after.configs.find(x=>x.id===copy.configId),before.configs.find(x=>x.id===copy.configId));assert.deepEqual(after.legacy,before.legacy);
  if(cascade){assert.equal(after.configs.length,1);assert.equal(after.versions.length,1);assert.equal(after.recoveryDrafts.length,0);assert.equal(after.receipts.length,1);assert.equal(after.bindings.length,1);assert.throws(()=>run('save',data),status(409));assert.equal(ws.read().configs.length,1);}
  else{
    assert.deepEqual(after.configs,before.configs);assert.deepEqual(after.versions,before.versions);assert.deepEqual(after.recoveryDrafts,before.recoveryDrafts);assert.equal(after.bindings[0].enabled,false);assert.equal(after.bindings[0].deletedByUsername,'admin');
    assert.throws(()=>save({...data,requestId:'third'}),status(409));
    if(kind!=='binding'){const row=after.dictionaries[kind].find(x=>x.id===target.id);assert.equal(row.enabled,false);assert.equal(row.deletedByUserId,'admin');assert.throws(()=>add(kind,row.code),e=>e.status===409&&/新编码/.test(e.message));}
    const pkg=ws.export({id:'admin'},{regionId:data.regionId});assert.equal(pkg.configs.length,1);assert.equal(pkg.versions.length,2);assert.equal(pkg.bindings[0].enabled,false);
    const restored=fixture(t,false);restored.run('import',{backup:pkg});assert.equal(restored.ws.read().bindings[0].deletedAt,after.bindings[0].deletedAt);assert.equal(restored.ws.read().configs[0].id,first.configId);assert.throws(()=>restored.run('save',{...data,requestId:'restore-edit'},{id:first.configId,expectedRevision:after.configs[0].revision}),status(409));
  }
});

test('delete requires explicit choice and both revisions, and enforces role at preview and commit',t=>{
  const {ws,run,data,save,preview,remove}=fixture(t);save();const target={targetType:'dictionary',kind:'regions',id:data.regionId},p=preview(target);
  for(const role of ['operate','readonly']){
    assert.throws(()=>ws.environmentDeletePreview({id:role},target),status(403));
    assert.throws(()=>run('deleteEnvironment',{...target,deleteConfigs:true,expectedRevision:p.targetRevision,expectedWorkspaceRevision:p.workspaceRevision},{},role),status(403));
    assert.throws(()=>run('bindings',{regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameIds:[data.configNameId]},{},role),status(403));
  }
  const before=ws.read();
  for(const patch of [{deleteConfigs:undefined},{expectedRevision:-1},{expectedWorkspaceRevision:-1}])assert.throws(()=>run('deleteEnvironment',{...target,deleteConfigs:true,expectedRevision:p.targetRevision,expectedWorkspaceRevision:p.workspaceRevision,...patch}));
  assert.throws(()=>run('dictionary',{kind:'regions',id:data.regionId,remove:true,expectedRevision:0}),status(400));assert.deepEqual(ws.read(),before);
  save({...data,jsonContent:'{"port":90}',requestId:'concurrent'});const current=ws.read();assert.throws(()=>remove(target,true,p),status(409));assert.deepEqual(ws.read(),current);assert.equal(preview(target).counts.versions,2);
  remove(target,true);assert.equal(ws.read().configs.length,0);
});

test('deleted dictionaries remove all combinations but retain only referenced identities',t=>{
  const {ws,run,add,data,save,remove}=fixture(t);save();const n=add('configNames','unused');run('bindings',{regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameIds:[n]});
  remove({targetType:'dictionary',kind:'regions',id:data.regionId});assert.equal(ws.read().bindings.length,1);assert.ok(ws.read().bindings[0].deletedAt);
  assert.throws(()=>run('bindings',{regionId:data.regionId,environmentTypeId:data.environmentTypeId,configNameIds:[n]}),status(409));
  const noRefs=add('regions','unused');remove({targetType:'dictionary',kind:'regions',id:noRefs});assert.ok(!ws.read().dictionaries.regions.some(x=>x.id===noRefs));
});

test('schema3 tombstones round trip, reject malformed markers, and older imports cannot reactivate local deletion',t=>{
  const f=fixture(t),{ws,run,data,save}=f;save();const old=ws.export({id:'admin'});
  f.remove({targetType:'dictionary',kind:'regions',id:data.regionId});const deleted=ws.export({id:'admin'});
  run('import',{backup:old,skipConflicts:true});assert.ok(ws.read().dictionaries.regions[0].deletedAt);assert.ok(ws.read().bindings[0].deletedAt);
  for(const location of ['dictionary','binding'])for(const patch of [{enabled:true},{deletedAt:'bad'},{deletedByUsername:null}]){
    const pkg=structuredClone(deleted);Object.assign(location==='dictionary'?pkg.dictionaries.regions[0]:pkg.bindings[0],patch);const dest=fixture(t,false);assert.throws(()=>dest.run('import',{backup:resign(pkg)}),status(400));assert.equal(dest.ws.read().configs.length,0);
  }
});
