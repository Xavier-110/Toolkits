import http from 'node:http';
import { readFile } from 'node:fs/promises';
const html = new URL('../ops_toolkit.html', import.meta.url);
const port = Number(process.env.OPS_TOOLKIT_PORT || 4173);
http.createServer(async (req, res) => {
  if (!['/', '/ops_toolkit.html'].includes(req.url?.split('?')[0])) { res.writeHead(404); res.end('Not found'); return; }
  try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(await readFile(html)); }
  catch { res.writeHead(500); res.end('Run npm run build first.'); }
}).listen(port, '127.0.0.1', () => console.log(`Ops Toolkit: http://127.0.0.1:${port}/`));
