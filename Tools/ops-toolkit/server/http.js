import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { openDatabase, fail } from './database.js';
import { Auth } from './auth.js';
import { Workspace } from './workspace.js';

async function body(req, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415,'请求必须使用 JSON');
  if (Number(req.headers['content-length'])>limit) {req.resume();fail(413,'请求内容过大');}
  const chunks=[];let size=0;
  for await(const chunk of req) {size+=chunk.length;if(size>limit)fail(413,'请求内容过大');chunks.push(chunk);}
  try {const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data;}
  catch {fail(400,'JSON 请求格式错误');}
}
export function createService({dbPath, origin, clock=Date.now}) {
  const db=openDatabase(dbPath),auth=new Auth(db,clock),workspace=new Workspace(db,clock), attempts=new Map();
  const fixedOrigin=origin ? new URL(origin).origin : null;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try {
      const expected=fixedOrigin || `http://127.0.0.1:${server.address().port}`;
      if(req.headers.host!==new URL(expected).host)fail(403,'服务地址不匹配');
      const url=new URL(req.url,expected),method=req.method;
      if(method==='GET'&&['/','/ops_toolkit_online.html'].includes(url.pathname)) {
        const html=await readFile(new URL('../../ops_toolkit_online.html',import.meta.url));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;
      }
      if(!url.pathname.startsWith('/api/'))fail(404,'页面不存在');
      if(!['GET','POST','PATCH'].includes(method))fail(405,'请求方法不支持');
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
      const session=auth.session(token);
      if(write&&req.headers['x-csrf-token']!==session.csrf)fail(403,'请求验证失败，请刷新后重试');
      if(url.pathname==='/api/me'&&method==='GET') {send(200,session);return;}
      if(url.pathname==='/api/logout'&&method==='POST') {auth.logout(token);res.setHeader('Set-Cookie',cookie('',0));send(200,{ok:true});return;}
      if(url.pathname==='/api/password'&&method==='POST') {
        const data=await body(req,16*1024);await auth.changePassword(token,data.oldPassword,data.password);
        res.setHeader('Set-Cookie',cookie('',0));send(200,{ok:true});return;
      }
      const user=auth.requireUser(session.user.id);
      if(url.pathname==='/api/workspace'&&method==='GET') {send(200,workspace.read());return;}
      if(url.pathname==='/api/commands'&&method==='POST') {auth.requireUser(user.id,'write');const data=await body(req,22*1024*1024);auth.session(token);send(200,workspace.execute(user,data));return;}
      if(url.pathname==='/api/backup'&&method==='GET') {send(200,workspace.backup(user,url.searchParams.get('id')||'',url.searchParams.get('redacted')==='true'));return;}
      if(url.pathname==='/api/users'&&method==='GET') {send(200,auth.list(user.id));return;}
      if(url.pathname==='/api/users'&&method==='POST') {
        auth.requireUser(user.id,'admin');const data=await body(req,16*1024);auth.session(token);send(201,await auth.createUser(user.id,data,()=>auth.session(token)));return;
      }
      const match=/^\/api\/users\/([a-f0-9-]{36})$/.exec(url.pathname);
      if(match&&method==='PATCH') {auth.requireUser(user.id,'admin');const data=await body(req,16*1024);auth.session(token);send(200,await auth.updateUser(user.id,match[1],data,()=>auth.session(token)));return;}
      fail(404,'接口不存在');
    } catch(error) {
      const status=error.status || (error.code==='ENOENT'?503:400);
      if(!res.headersSent)send(status,{error:error.status?error.message:error.code==='ENOENT'?'请先执行 npm run build':error.code?.startsWith('SQLITE')?'数据存储失败':error.message || '请求处理失败'});
      else res.end();
    }
  });
  server.requestTimeout=30000;
  const timer=setInterval(()=>{try{workspace.tick();}catch{console.error('自动归档失败，请检查数据目录及服务日志');}},1000);timer.unref();
  return {server,auth,workspace,async close(){clearInterval(timer);await new Promise(r=>server.close(r));db.close();}};
}
