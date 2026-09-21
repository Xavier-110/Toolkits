import { resolve } from 'node:path';
import { createService } from './http.js';
const port=Number(process.env.OPS_TOOLKIT_PORT || 4173), host=process.env.OPS_TOOLKIT_HOST || '127.0.0.1';
const origin=process.env.OPS_TOOLKIT_ORIGIN || `http://127.0.0.1:${port}`;
if(new URL(origin).protocol!=='https:' && !['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname))throw Error('非本机部署必须配置 HTTPS 的 OPS_TOOLKIT_ORIGIN');
const service=createService({dbPath:resolve(process.env.OPS_TOOLKIT_DB || 'data/ops-toolkit.sqlite'),origin});
service.server.listen(port,host,()=>console.log(`在线运维工具箱：${origin}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>service.close().then(()=>process.exit(0)));
