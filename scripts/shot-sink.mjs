// Tiny local sink: receives {name, dataUrl} PNGs from the in-page capture helper and
// writes them to docs/manual/<name>.png. Run with: node scripts/shot-sink.mjs
import http from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'manual');
mkdirSync(outDir, { recursive: true });

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return; }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const { name, dataUrl } = JSON.parse(body);
      const safe = String(name).replace(/[^a-z0-9_-]/gi, '_');
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const file = path.join(outDir, safe + '.png');
      writeFileSync(file, Buffer.from(b64, 'base64'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, file, bytes: b64.length }));
      console.log('wrote', file);
    } catch (e) {
      res.writeHead(400); res.end('err: ' + e.message);
    }
  });
});
server.listen(7799, () => console.log('shot-sink on http://localhost:7799'));
