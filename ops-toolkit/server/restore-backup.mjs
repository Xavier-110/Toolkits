import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openStore} from './storage.js';
import {restoreSystemBackup,validateSystemBackup} from './backups.js';
const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--file'||args[2]!=='--target')throw Error('停服后使用：node server/restore-backup.mjs --file 系统备份.json --target 新数据库.sqlite');
const pkg=validateSystemBackup(JSON.parse(await readFile(resolve(args[1]),'utf8'))),store=await openStore({type:'sqlite',filename:resolve(args[3])});
try{const counts=await restoreSystemBackup(pkg,store);console.log('系统备份已恢复到空目标；旧会话失效，定时任务已暂停。',counts);}finally{await store.close();}
