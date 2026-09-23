import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { resolve } from 'node:path';
import { openManagedStorage } from './storage-manager.js';
if(process.argv.length>2)throw Error('请交互输入用户名和密码，不接受命令行密码参数');
if(!process.stdin.isTTY)throw Error('请在交互终端运行管理员初始化');
let muted=false;
const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
const rl=createInterface({input:process.stdin,output,terminal:true});
const manager=await openManagedStorage(resolve(process.env.OPS_TOOLKIT_DB || 'data/ops-toolkit.sqlite'));
try {
  if((await manager.store.users()).length)throw Error('管理员已初始化，无需重复创建');
  const username=await rl.question('管理员用户名：');
  process.stdout.write('初始密码（12～128 字符，输入隐藏）：');muted=true;
  const password=await rl.question('');muted=false;process.stdout.write('\n');
  await manager.services.auth.bootstrap(username,password);console.log('管理员已创建，首次登录需要修改密码。');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{muted=false;rl.close();await manager.close();}
