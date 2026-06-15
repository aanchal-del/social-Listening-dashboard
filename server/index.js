// Bun HTTP server: serves the dashboard (../index.html + assets) and the API.
// API paths match what the frontend already calls, so no JS rewrite is needed:
//   POST /webhook/analyze   { brands:[...], force:bool }  -> { run_id, status, total }
//   GET  /webhook/status?run_id=...                       -> { run_id, finished, total, done, errored, brands:[...] }
import { join, normalize } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { PORT, checkConfig, SHEET_BRANDS } from './config.js';
import { createRun, startWork, getStatus } from './lib/runs.js';
import { sheetsConfigured, readBrands, appendRows } from './lib/sheets.js';
import { startScheduler } from './lib/scheduler.js';
import { fetchNews } from './lib/news.js';

const ROOT = join(import.meta.dir, '..'); // dashboard lives one level up (the repo root)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Serve a static file from the repo root, safely (no path traversal).
function serveStatic(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = normalize(join(ROOT, rel));
  if (!full.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  const ext = full.slice(full.lastIndexOf('.'));
  return new Response(Bun.file(full), {
    headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' },
  });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // allow long scrape/AI calls
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // ── API ──
    if (pathname === '/webhook/analyze' && req.method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      const brands = (body.brands || []).map(b => String(b).trim()).filter(Boolean);
      if (!brands.length) return json({ error: 'no brands provided' }, 400);
      const force = body.force === true;
      const { run_id, total } = createRun(brands);
      startWork(run_id, brands, force); // fire and forget
      return json({ run_id, status: 'queued', total });
    }

    if (pathname === '/webhook/status' && req.method === 'GET') {
      const run_id = url.searchParams.get('run_id') || '';
      const status = await getStatus(run_id);
      return json(status);
    }

    if (pathname === '/health') {
      return json({ ok: true, sheets: sheetsConfigured(), missing: checkConfig() });
    }

    // ── News / PR (Google News RSS) ──
    if (pathname === '/news' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      if (!q) return json({ error: 'q required' }, 400);
      try { return json({ query: q, articles: await fetchNews(q) }); }
      catch (e) { return json({ error: e.message }, 500); }
    }

    // ── Boards (= brand rows in the Brand sheet) ──
    if (pathname === '/brands' && req.method === 'GET') {
      try { return json({ boards: await readBrands() }); }
      catch (e) { return json({ error: e.message }, 500); }
    }
    if (pathname === '/brands' && req.method === 'POST') {
      let b = {};
      try { b = await req.json(); } catch {}
      const name = String(b.name || b.brand || '').trim();
      if (!name) return json({ error: 'board name required' }, 400);
      const row = {
        'Brand Name': name,
        LinkedIn_Handle: b.linkedin || '', Instagram_Handle: b.instagram || '',
        YouTube_Handle: b.youtube || '', Facebook_Handle: b.facebook || '',
        Twitter_Handle: b.twitter || '', Keywords: b.keywords || '',
        Exclusions: b.exclusions || '', Description: b.description || '',
        Platforms: b.platforms || '', Own: b.own ? 'yes' : '',
      };
      try { await appendRows(SHEET_BRANDS, [row]); return json({ ok: true, board: name }); }
      catch (e) { return json({ error: e.message }, 500); }
    }

    // Image proxy — fetches remote thumbnails/avatars server-side to bypass the
    // browser's CORS / hotlink-referrer blocks (Instagram, Facebook, YouTube CDNs).
    if (pathname === '/img' && req.method === 'GET') {
      const u = url.searchParams.get('url');
      if (!u || !/^https?:\/\//.test(u)) return new Response('bad url', { status: 400, headers: CORS });
      try {
        const r = await fetch(u, {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*' },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) return new Response('', { status: 204, headers: CORS });
        return new Response(r.body, {
          headers: {
            'Content-Type': r.headers.get('content-type') || 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
            ...CORS,
          },
        });
      } catch {
        return new Response('', { status: 204, headers: CORS });
      }
    }

    // ── Static dashboard ──
    if (req.method === 'GET') {
      const file = serveStatic(pathname);
      if (file) return file;
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
});

const missing = checkConfig();
console.log(`\n  Contextual Pulse backend running → http://localhost:${server.port}`);
console.log(`  Dashboard:  http://localhost:${server.port}/`);
console.log(`  Google Sheets configured: ${sheetsConfigured() ? 'yes' : 'NO (set GOOGLE_CREDENTIALS_PATH)'}`);
if (missing.length) console.log(`  ⚠  Missing keys: ${missing.join(', ')} — set them in server/.env`);
startScheduler(); // weekly auto-run
console.log('');
