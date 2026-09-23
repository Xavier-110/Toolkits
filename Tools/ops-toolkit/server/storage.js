import {openDatabase,fail,transaction as sqliteTransaction} from './database.js';
import {normalizeWorkspaceState} from './workspace.js';
import {emptyState} from '../src/store.js';

export function validateConnection(input,{local=false}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'连接信息无效');
  if(!['sqlite','mysql','postgres','oracle'].includes(input.type))fail(400,'数据库类型无效');
  if(input.type==='sqlite'){if(!local) return {type:'sqlite'};if(typeof input.filename!=='string'||!input.filename)fail(400,'本地路径无效');return {type:'sqlite',filename:input.filename};}
  if(Object.keys(input).some(k=>!['type','host','port','database','serviceName','username','password','tls'].includes(k)))fail(400,'连接包含不支持的字段');
  const field=key=>{const value=input[key];if(typeof value!=='string'||!value.trim()||value.length>255||/[\x00-\x1f]/.test(value))fail(400,`数据库 ${key} 无效`);return value.trim();};
  const host=field('host');if(/[\/\\@?#\s]/.test(host))fail(400,'请填写主机名或IP，不填写连接URL');
  const port=Number(input.port||({mysql:3306,postgres:5432,oracle:1521}[input.type]));if(!Number.isInteger(port)||port<1||port>65535)fail(400,'数据库端口无效');
  if(typeof input.password!=='string'||input.password.length>4096)fail(400,'数据库密码无效');
  if(input.tls!==undefined&&typeof input.tls!=='boolean')fail(400,'TLS选项无效');
  const result={type:input.type,host,port,username:field('username'),password:input.password,tls:input.tls===true};
  if(input.type==='oracle'){result.serviceName=field('serviceName');if(!/^[a-zA-Z0-9_.-]+$/.test(result.serviceName))fail(400,'Oracle service name 无效');}
  else result.database=field('database');
  return result;
}
const userKeys=['id','username','passwordHash','role','enabled','mustChangePassword','createdAt'];
export class SqlStore {
  constructor(type,connection,{db=null,root=null,inTransaction=false}={}){this.type=type;this.connection=connection;this.db=db;this.root=root||this;this.inTransaction=inTransaction;this.queue=Promise.resolve();}
  q(name){return this.type==='mysql'?'`'+name+'`':'"'+name+'"';}
  table(name){return this.q(this.type==='sqlite'?name:'ops_toolkit_'+name);}
  placeholders(n){return Array.from({length:n},(_,i)=>this.type==='postgres'?`$${i+1}`:this.type==='oracle'?`:${i+1}`:'?').join(',');}
  async raw(sql,params=[]){
    if(!this.inTransaction){const previous=this.root.queue;let release;this.root.queue=new Promise(r=>{release=r;});await previous;try{return await this.perform(sql,params);}finally{release();}}
    return this.perform(sql,params);
  }
  async perform(sql,params=[]){
    try{
      if(this.type==='sqlite'){const statement=this.db.prepare(sql);return /^\s*(SELECT|PRAGMA)/i.test(sql)?statement.all(...params):statement.run(...params);}
      if(this.type==='mysql'){const [rows]=await this.connection.execute(sql,params);return rows;}
      if(this.type==='postgres'){const result=await this.connection.query(sql,params);return result.rows;}
      const oracledb=(await import('oracledb')).default;
      const result=await this.connection.execute(sql,params,{outFormat:oracledb.OUT_FORMAT_OBJECT,fetchInfo:{data:{type:oracledb.STRING}},autoCommit:!this.inTransaction});return result.rows||result;
    }catch(error){if(error.status)throw error;throw Object.assign(Error('数据库操作失败，请检查连接、表结构和权限'),{status:503,driverCode:String(error.code||'unknown').slice(0,40)});}
  }
  async getUser(id){return (await this.raw(`SELECT * FROM ${this.table('users')} WHERE ${this.q('id')}=${this.placeholders(1)}`,[id]))[0];}
  async findUser(username){return (await this.raw(`SELECT * FROM ${this.table('users')} WHERE LOWER(${this.q('username')})=LOWER(${this.placeholders(1)})`,[username]))[0];}
  async users(){return (await this.raw(`SELECT * FROM ${this.table('users')} ORDER BY ${this.q('createdAt')},${this.q('username')}`)).map(row=>Object.fromEntries(userKeys.map(k=>[k,row[k]])));}
  async insertUser(user){const keys=this.type==='sqlite'?userKeys:[...userKeys,'usernameKey'];const row={...user,enabled:user.enabled??1,mustChangePassword:user.mustChangePassword??1,usernameKey:user.username.toLowerCase()};await this.raw(`INSERT INTO ${this.table('users')} (${keys.map(k=>this.q(k)).join(',')}) VALUES (${this.placeholders(keys.length)})`,keys.map(k=>row[k]));}
  async updateUser(id,patch){const keys=Object.keys(patch);if(!keys.length||keys.some(k=>!['role','enabled','passwordHash','mustChangePassword'].includes(k)))fail(400,'用户更新字段无效');const slots=this.placeholders(keys.length+1).split(',');await this.raw(`UPDATE ${this.table('users')} SET ${keys.map((k,i)=>`${this.q(k)}=${slots[i]}`).join(',')} WHERE ${this.q('id')}=${slots.at(-1)}`,[...keys.map(k=>patch[k]),id]);}
  async getSession(digest){return (await this.raw(`SELECT * FROM ${this.table('sessions')} WHERE ${this.q('digest')}=${this.placeholders(1)}`,[digest]))[0];}
  async insertSession(row){const keys=['digest','userId','csrf','expiresAt'];await this.raw(`INSERT INTO ${this.table('sessions')} (${keys.map(k=>this.q(k)).join(',')}) VALUES (${this.placeholders(4)})`,keys.map(k=>row[k]));}
  async deleteSession(digest){await this.raw(`DELETE FROM ${this.table('sessions')} WHERE ${this.q('digest')}=${this.placeholders(1)}`,[digest]);}
  async deleteUserSessions(id){await this.raw(`DELETE FROM ${this.table('sessions')} WHERE ${this.q('userId')}=${this.placeholders(1)}`,[id]);}
  async clearSessions(){await this.raw(`DELETE FROM ${this.table('sessions')}`);}
  async expireSessions(now){await this.raw(`DELETE FROM ${this.table('sessions')} WHERE ${this.q('expiresAt')}<=${this.placeholders(1)}`,[now]);}
  async getWorkspace(){const row=(await this.raw(`SELECT ${this.q('data')} FROM ${this.table('workspace')} WHERE ${this.q('id')}=1`))[0];if(!row)fail(503,'数据库工作空间尚未初始化');return normalizeWorkspaceState(JSON.parse(row.data));}
  async setWorkspace(state){await this.raw(`UPDATE ${this.table('workspace')} SET ${this.q('data')}=${this.placeholders(1)} WHERE ${this.q('id')}=1`,[JSON.stringify(state)]);}
  async mutateWorkspace(mutate){
    if(this.type==='sqlite')return sqliteTransaction(this.db,()=>{const state=normalizeWorkspaceState(JSON.parse(this.db.prepare('SELECT data FROM workspace WHERE id=1').get().data));const result=mutate(state);state.revision++;this.db.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(state));return result;});
    return this.transaction(async tx=>{const state=await tx.getWorkspace(),result=mutate(state);state.revision++;await tx.setWorkspace(state);return result;});
  }
  async transaction(fn){
    if(this.inTransaction)return fn(this);
    // A store owns one connection; serializing transactions also prevents another
    // task from committing a transaction that it did not start.
    const previous=this.queue;let release;this.queue=new Promise(r=>{release=r;});await previous;
    const tx=new SqlStore(this.type,this.connection,{db:this.db,root:this,inTransaction:true});
    try{
      if(this.type==='sqlite')this.db.exec('BEGIN IMMEDIATE');else if(this.type==='mysql')await this.connection.beginTransaction();else if(this.type==='postgres')await this.connection.query('BEGIN');
      if(this.type!=='sqlite')await tx.raw(`SELECT ${this.q('id')} FROM ${this.table('workspace')} WHERE ${this.q('id')}=1 FOR UPDATE`);
      const result=await fn(tx);
      if(this.type==='sqlite')this.db.exec('COMMIT');else if(this.type==='postgres')await this.connection.query('COMMIT');else await this.connection.commit();return result;
    }catch(error){try{if(this.type==='sqlite')this.db.exec('ROLLBACK');else if(this.type==='postgres')await this.connection.query('ROLLBACK');else await this.connection.rollback();}catch{}throw error;}finally{release();}
  }
  async snapshot(){
    if(this.type==='sqlite'&&!this.inTransaction){await this.queue;return sqliteTransaction(this.db,()=>({users:this.db.prepare('SELECT * FROM users ORDER BY id').all(),workspace:normalizeWorkspaceState(JSON.parse(this.db.prepare('SELECT data FROM workspace WHERE id=1').get().data))}));}
    return this.transaction(async tx=>({users:await tx.users(),workspace:await tx.getWorkspace()}));
  }
  async close(){await this.queue;if(this.type==='sqlite')this.db.close();else if(this.type==='oracle')await this.connection.close();else await this.connection.end();}
}
async function initialize(store){
  const q=s=>store.q(s),t=s=>store.table(s),oracle=store.type==='oracle',text=oracle?'CLOB':store.type==='mysql'?'LONGTEXT':'TEXT',num=oracle?'NUMBER(20)':'BIGINT';
  const statements=[
    `CREATE TABLE ${t('users')} (${q('id')} VARCHAR(120) PRIMARY KEY,${q('username')} VARCHAR(64) NOT NULL,${q('usernameKey')} VARCHAR(64) NOT NULL UNIQUE,${q('passwordHash')} VARCHAR(255) NOT NULL,${q('role')} VARCHAR(16) NOT NULL,${q('enabled')} INTEGER NOT NULL,${q('mustChangePassword')} INTEGER NOT NULL,${q('createdAt')} VARCHAR(40) NOT NULL)`,
    `CREATE TABLE ${t('sessions')} (${q('digest')} VARCHAR(64) PRIMARY KEY,${q('userId')} VARCHAR(120) NOT NULL REFERENCES ${t('users')}(${q('id')}),${q('csrf')} VARCHAR(64) NOT NULL,${q('expiresAt')} ${num} NOT NULL)`,
    `CREATE TABLE ${t('workspace')} (${q('id')} INTEGER PRIMARY KEY,${q('data')} ${text} NOT NULL)`
  ];
  for(const statement of statements){
    // Query the existing table before DDL. A populated/foreign schema is never
    // dropped; incompatible columns will be rejected by the regular queries.
    const name=/CREATE TABLE (\S+)/.exec(statement)[1];let exists=false;
    try{await store.raw(`SELECT * FROM ${name} WHERE 1=0`);exists=true;}catch(error){if(!['ER_NO_SUCH_TABLE','42P01','ORA-00942'].includes(error.driverCode))throw error;}
    if(!exists)await store.raw(statement);
  }
  const rows=await store.raw(`SELECT ${q('id')} FROM ${t('workspace')}`);
  if(!rows.length)await store.raw(`INSERT INTO ${t('workspace')} (${q('id')},${q('data')}) VALUES (${store.placeholders(2)})`,[1,JSON.stringify(normalizeWorkspaceState(emptyState()))]);
  else if(rows.length!==1||Number(rows[0].id)!==1)fail(409,'目标工具箱表结构不兼容');
}
export async function openStore(input,{initializeTables=true,db}={}){
  const config=validateConnection(input,{local:true});
  if(config.type==='sqlite')return new SqlStore('sqlite',null,{db:db||openDatabase(config.filename)});
  let connection;
  try{
    if(config.type==='mysql'){const mysql=await import('mysql2/promise');connection=await mysql.createConnection({host:config.host,port:config.port,user:config.username,password:config.password,database:config.database,connectTimeout:10000,charset:'utf8mb4',ssl:config.tls?{rejectUnauthorized:true}:undefined});}
    else if(config.type==='postgres'){const {Client}=await import('pg');connection=new Client({host:config.host,port:config.port,user:config.username,password:config.password,database:config.database,connectionTimeoutMillis:10000,statement_timeout:30000,ssl:config.tls?{rejectUnauthorized:true}:undefined});await connection.connect();}
    else{const oracledb=(await import('oracledb')).default;connection=await oracledb.getConnection({user:config.username,password:config.password,connectString:`${config.tls?'tcps':'tcp'}://${config.host}:${config.port}/${config.serviceName}?connect_timeout=10`,...(config.tls?{sslServerDNMatch:true}:{})});connection.callTimeout=30000;}
    const store=new SqlStore(config.type,connection);await store.raw(config.type==='oracle'?'SELECT 1 FROM DUAL':'SELECT 1');if(initializeTables)await initialize(store);return store;
  }catch(error){try{if(config.type==='oracle')await connection?.close();else await connection?.end();}catch{}if(error.status)throw error;fail(503,'数据库连接失败，请检查地址、凭证、TLS和服务状态');}
}
