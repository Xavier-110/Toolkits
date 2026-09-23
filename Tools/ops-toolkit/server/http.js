import {StorageManager} from './storage-manager.js';
import {BackupManager} from './backups.js';
import {compareSnapshots} from '../src/comparison.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fail } from './database.js';
import { decodeArchive } from '../src/archive.js';

async function body(req, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415,'请求必须使用 JSON');
  if (Number(req.headers['content-length'])>limit) {req.resume();fail(413,'请求内容过大');}
  const chunks=[];let size=0;
  for await(const chunk of req) {size+=chunk.length;if(size>limit)fail(413,'请求内容过大');chunks.push(chunk);}
  try {const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data;}
  catch {fail(400,'JSON 请求格式错误');}
}
async function archiveBody(req) {
  if(!/^(application\/json|application\/zip)(?:\s*;|$)/i.test(req.headers['content-type']||''))fail(415,'导入文件必须为 JSON 或 ZIP');
  const limit=1024*1024*1024+1024*1024;
  if(Number(req.headers['content-length'])>limit){req.resume();fail(413,'归档过大');}
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)fail(413,'归档过大');chunks.push(chunk);}
  try{return decodeArchive(Buffer.concat(chunks));}catch{fail(400,'归档损坏或格式无效');}
}
export function createService({dbPath, origin, clock=Date.now,manager=StorageManager.local(dbPath,{clock}),schedule=true}) {
  const attempts=new Map(),backups=new BackupManager(manager,{clock});if(schedule)backups.start();
  const fixedOrigin=origin ? new URL(origin).origin : null;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    let release=null;
    try {
      const expected=fixedOrigin || `http://127.0.0.1:${server.address().port}`;
      if(req.headers.host!==new URL(expected).host)fail(403,'服务地址不匹配');
      const url=new URL(req.url,expected),method=req.method;
      if(method==='GET'&&['/','/ops_toolkit_online.html'].includes(url.pathname)) {
        const html=await readFile(new URL('../../ops_toolkit_online.html',import.meta.url));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;
      }
      if(!url.pathname.startsWith('/api/'))fail(404,'页面不存在');
      if(!['GET','POST','PATCH'].includes(method))fail(405,'请求方法不支持');
      release=manager.enter();const {auth,workspace}=manager.services;
      const write=method!=='GET';
      if(write && req.headers.origin!==expected)fail(403,'请求来源不受信任');
      const token=/(?:^|;\s*)ops_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const cookie=(value,age)=>`ops_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${expected.startsWith('https:')?'; Secure':''}`;
      if(url.pathname==='/api/login'&&method==='POST') {
        const data=await body(req,16*1024), ip=req.socket.remoteAddress;
        const keys=[`ip:${ip}`,`user:${String(data.username || '').slice(0,64).toLowerCase()}`];
        for(const [key,entry] of attempts)if(entry.until<=clock())attempts.delete(key);
        if(attempts.size>10000)fail(429,'登录请求过多，请稍后再试');
        for(const key of keys) {const limit=key.startsWith('ip:')?50:10,entry=attempts.get(key);if(entry?.count>=limit)fail(429,'登录尝试过多，请 15 分钟后再试');}
        for(const key of keys) {const entry=attempts.get(key)||{count:0,until:clock()+15*60*1000};entry.count++;attempts.set(key,entry);}
        const result=await auth.login(data.username,data.password);attempts.delete(keys[1]);
        res.setHeader('Set-Cookie',cookie(result.token,8*60*60));send(200,{user:result.user,csrf:result.csrf});return;
      }
      const session=await auth.session(token);
      if(write&&req.headers['x-csrf-token']!==session.csrf)fail(403,'请求验证失败，请刷新后重试');
      if(url.pathname==='/api/me'&&method==='GET') {send(200,session);return;}
      if(url.pathname==='/api/logout'&&method==='POST') {await auth.logout(token);res.setHeader('Set-Cookie',cookie('',0));send(200,{ok:true});return;}
      if(url.pathname==='/api/password'&&method==='POST') {
        const data=await body(req,16*1024);await auth.changePassword(token,data.oldPassword,data.password);
        res.setHeader('Set-Cookie',cookie('',0));send(200,{ok:true});return;
      }
      const user=await auth.requireUser(session.user.id);
      if(url.pathname==='/api/workspace'&&method==='GET') {const state=await workspace.read();if(user.role!=='admin')delete state.management;send(200,state);return;}
      if(url.pathname==='/api/environment-delete-preview'&&method==='GET') {send(200,await workspace.environmentDeletePreview(user,{targetType:url.searchParams.get('targetType'),id:url.searchParams.get('id'),...(url.searchParams.get('kind')?{kind:url.searchParams.get('kind')}:{})}));return;}
      if(url.pathname==='/api/storage-summary'&&method==='GET'){send(200,manager.summary());return;}
      if(url.pathname.startsWith('/api/admin/')){
        await auth.requireUser(user.id,'admin');
        if(url.pathname==='/api/admin/storage'&&method==='GET'){send(200,manager.summary(true));return;}
        if(url.pathname==='/api/admin/storage/test'&&method==='POST'){send(200,await manager.testConnection(await body(req,16*1024)));return;}
        if(url.pathname==='/api/admin/storage/migrate'&&method==='POST'){const data=await body(req,32*1024);await auth.session(token);const result=await manager.migrate(user.id,data,{requestActive:true});res.setHeader('Set-Cookie',cookie('',0));send(200,result);return;}
        if(url.pathname==='/api/admin/storage/cancel'&&method==='POST'){const data=await body(req,16*1024);await auth.session(token);send(200,await manager.cancelMigration(user.id,data,{requestActive:true}));return;}
        if(url.pathname==='/api/admin/backup-schedule'&&method==='PATCH'){const data=await body(req,16*1024);await auth.session(token);await auth.requireUser(user.id,'admin');send(200,await backups.configure(data));return;}
        if(url.pathname==='/api/admin/backups'&&method==='GET'){send(200,await backups.list());return;}
        if(url.pathname==='/api/admin/backups'&&method==='POST'){await body(req,16*1024);await auth.session(token);await auth.requireUser(user.id,'admin');send(200,await backups.create({username:user.username}));return;}
        const backupMatch=/^\/api\/admin\/backups\/([a-f0-9-]{36})\/download$/.exec(url.pathname);
        if(backupMatch&&method==='GET'){const bytes=await backups.download(backupMatch[1]);res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':'attachment; filename="ops-system-'+backupMatch[1]+'.json"'});res.end(bytes);return;}
        fail(404,'管理接口不存在');
      }
      if(['/api/compare','/api/compare-report'].includes(url.pathname)&&method==='POST'){
        if(url.pathname==='/api/compare-report')await auth.requireUser(user.id,'write');
        const data=await body(req,16*1024);await auth.session(token);
        if(Object.keys(data).some(k=>!['leftVersionId','rightVersionId','leftTag','rightTag','reveal'].includes(k))||data.reveal!==undefined&&typeof data.reveal!=='boolean')fail(400,'比较参数无效');
        const state=await workspace.read();const resolve=side=>{const version=state.versions.find(v=>v.id===data[side+'VersionId']);if(!version)fail(404,'比较版本不存在');const tag=data[side+'Tag'];if(tag&&!state.versionTags.some(t=>t.name===tag&&t.versionId===version.id))fail(409,'tag 已变化，请重新比较');return {...version,tag:tag||null};};
        const left=resolve('left'),right=resolve('right');const identity=v=>{const c=state.configs.find(c=>c.id===v.configSetId);return Object.fromEntries([['regions','regionId'],['environmentTypes','environmentTypeId'],['configNames','configNameId']].map(([kind,key])=>[kind,state.dictionaries[kind].find(d=>d.id===c[key])?.label||c[key]]));};
        send(200,compareSnapshots(left,right,{reveal:data.reveal===true,generatedBy:user.username,generatedAt:new Date(clock()).toISOString(),leftIdentity:identity(left),rightIdentity:identity(right)}));return;
      }
      if(url.pathname==='/api/commands'&&method==='POST') {await auth.requireUser(user.id,'write');const data=await body(req,22*1024*1024);await auth.session(token);send(200,await workspace.execute(user,data));return;}
      if(url.pathname==='/api/import-archive'&&method==='POST') {await auth.requireUser(user.id,'admin');let copyMappings=[];try{if(url.searchParams.has('copyMappings'))copyMappings=JSON.parse(url.searchParams.get('copyMappings'));if(!Array.isArray(copyMappings))throw Error();}catch{fail(400,'副本映射参数无效');}const backup=await archiveBody(req);await auth.session(token);send(200,await workspace.execute(user,{type:'import',data:{backup,skipConflicts:url.searchParams.get('skipConflicts')==='true',importSettings:url.searchParams.get('importSettings')==='true',copyMappings}}));return;}
      if(url.pathname==='/api/backup'&&method==='GET') {send(200,await workspace.backup(user,url.searchParams.get('id')||'',url.searchParams.get('redacted')==='true'));return;}
      if(url.pathname==='/api/export'&&method==='GET') {send(200,await workspace.export(user,{kind:url.searchParams.get('kind')||'versions',regionId:url.searchParams.get('regionId')||'',environmentTypeId:url.searchParams.get('environmentTypeId')||'',redacted:url.searchParams.get('redacted')==='true'}));return;}
      if(url.pathname==='/api/legacy-export'&&method==='GET') {send(200,await workspace.legacyExport(user));return;}
      if(url.pathname==='/api/users'&&method==='GET') {send(200,await auth.list(user.id));return;}
      if(url.pathname==='/api/users'&&method==='POST') {
        await auth.requireUser(user.id,'admin');const data=await body(req,16*1024);await auth.session(token);send(201,await auth.createUser(user.id,data,currentAuth=>(currentAuth||auth).session(token)));return;
      }
      const match=/^\/api\/users\/([a-f0-9-]{36})$/.exec(url.pathname);
      if(match&&method==='PATCH') {await auth.requireUser(user.id,'admin');const data=await body(req,16*1024);await auth.session(token);send(200,await auth.updateUser(user.id,match[1],data,currentAuth=>(currentAuth||auth).session(token)));return;}
      fail(404,'接口不存在');
    } catch(error) {
      const status=error.status || (error.code==='ENOENT'?503:400);
      if(!res.headersSent)send(status,{error:error.status?error.message:error.code==='ENOENT'?'请先执行 npm run build':error.code?.startsWith('SQLITE')?'数据存储失败':error.message || '请求处理失败'});
      else res.end();
    }finally{release?.();}
  });
  server.requestTimeout=5*60*1000;
  return {server,manager,backups,get auth(){return manager.services.auth;},get workspace(){return manager.services.workspace;},async close(){await backups.stop();await new Promise(r=>server.close(r));await manager.close();}};
}
