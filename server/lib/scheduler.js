// Weekly auto-run: re-fetches every brand once a week and stores it (mentions
// accumulate, so history is kept). The dashboard auto-loads the latest on open.
// No external cron / n8n needed — this runs inside the long-lived backend process.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readBrands } from './sheets.js';
import { createRun, startWork } from './runs.js';

const env = process.env;
export const WEEKLY_AUTORUN = (env.WEEKLY_AUTORUN ?? 'true') !== 'false';
const EVERY_DAYS = Number(env.WEEKLY_RUN_DAYS || 7);
const WINDOW_MS = EVERY_DAYS * 24 * 60 * 60 * 1000;
const CHECK_MS = 6 * 60 * 60 * 1000; // re-check every 6 hours
const STAMP = resolve('./credentials/.last_weekly_run');

function lastRunMs() {
  try { return existsSync(STAMP) ? new Date(readFileSync(STAMP, 'utf8').trim()).getTime() : 0; }
  catch { return 0; }
}
function markRun() {
  try { writeFileSync(STAMP, new Date().toISOString()); } catch {}
}

async function maybeRun() {
  if (Date.now() - lastRunMs() < WINDOW_MS) return; // not due yet
  let brands = [];
  try { brands = (await readBrands()).map(r => r['Brand Name']).filter(Boolean); }
  catch (e) { console.warn('[scheduler] could not read Brand sheet:', e.message); return; }
  if (!brands.length) return;
  console.log(`[scheduler] weekly auto-run starting for: ${brands.join(', ')}`);
  markRun(); // stamp first so a restart mid-run doesn't double-trigger
  const { run_id } = createRun(brands);
  startWork(run_id, brands, true); // force = always fetch fresh weekly data (accumulates)
}

export function startScheduler() {
  if (!WEEKLY_AUTORUN) { console.log('  Weekly auto-run: OFF (set WEEKLY_AUTORUN=true to enable)'); return; }
  // First time only: stamp "now" so we don't fire an immediate scrape on enable —
  // the next auto-run will be ~EVERY_DAYS from now (data is already current).
  if (!existsSync(STAMP)) markRun();
  setInterval(() => { maybeRun().catch(e => console.warn('[scheduler] error:', e.message)); }, CHECK_MS);
  const next = new Date(lastRunMs() + WINDOW_MS).toLocaleString('en-GB');
  console.log(`  Weekly auto-run: ON (every ${EVERY_DAYS}d, next ≈ ${next})`);
}
