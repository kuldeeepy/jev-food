// Local dev server: serves public/ and runs the /api/match function Vercel hosts in production.
// Key comes from AI_GATEWAY_API_KEY, or a .env.local beside this file. Never commit that file.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { match } from './api/match.js';
import DISHES from './api/dishes.json' with { type: 'json' };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 8099;

const envFile = process.env.ENV_FILE ?? join(ROOT, '..', '.env.local');
if (!process.env.AI_GATEWAY_API_KEY && existsSync(envFile)) {
  const found = readFileSync(envFile, 'utf8').match(/^\s*AI_GATEWAY_API_KEY\s*=\s*["']?([^"'\s]+)/m);
  if (found) process.env.AI_GATEWAY_API_KEY = found[1];
}

const KEY = process.env.AI_GATEWAY_API_KEY;
console.log(KEY ? `Jev enabled (key ${KEY.slice(0, 7)}…)` : 'No AI_GATEWAY_API_KEY — using offline rules');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function api(req, res) {
  if (!KEY) return json(res, 503, { error: 'no_key', fallback: true });
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { query } = JSON.parse(body);
    const started = Date.now();
    const out = await match(query, DISHES, KEY);
    const hits = Object.values(out.scores).filter(s => s >= out.threshold).length;
    console.log(`jev "${query}" → ${hits}/${Object.keys(out.scores).length} in ${Date.now() - started}ms $${out.cost ?? '?'}`);
    json(res, 200, out);
  } catch (err) {
    console.error('jev failed:', err.message);
    json(res, 502, { error: String(err.message), fallback: true });
  }
}

async function serve(req, res) {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, path.endsWith('/') ? join(path, 'index.html') : path);
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

createServer((req, res) =>
  req.url === '/api/match' && req.method === 'POST' ? api(req, res) : serve(req, res)
).listen(PORT, () => console.log(`http://localhost:${PORT}`));
