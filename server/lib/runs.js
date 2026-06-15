// Run lifecycle + background worker — replaces the n8n Trigger/Status/Worker split.
// A run is created synchronously (so /analyze can return a run_id immediately),
// then brands are processed in the background. /status reads in-memory state.
import { readBrands, appendRows, upsertRow, readInsights, getLatestDoneInsight, sheetDateToMs, sheetsConfigured, appendMentions, readMentions, readMentionKeys } from './sheets.js';
import { scrapeAllPlatforms } from './scrapers.js';
import { normalizePosts } from './normalize.js';
import { analyzeBrand, classifyTexts } from './analyze.js';
import { collectMentions, collectComments } from './mentions.js';
import { SHEET_RAW, SHEET_INSIGHTS, RESCRAPE_MIN_DAYS } from '../config.js';

// Build the brand-mention feed (third-party posts + comments), classify sentiment,
// attach to the dashboard, and return a compact array for persistence.
async function buildMentions(brand, brandRow, normalizedPosts, dashboard, priorMentions = []) {
  // Widen coverage: brand name + hashtag + handle + any comma-separated "Keywords" column.
  const extra = String(brandRow.Keywords || brandRow.keywords || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const handle = String(brandRow.Instagram_Handle || brandRow.YouTube_Handle || '').replace(/^@/, '');
  const keywords = [...new Set([
    brand,
    '#' + brand.toLowerCase().replace(/\s+/g, ''),
    ...(handle ? [handle] : []),
    ...extra,
  ].filter(Boolean))];

  const ownHandles = [
    brandRow.Instagram_Handle, brandRow.YouTube_Handle, brandRow.LinkedIn_Handle,
    brandRow.Facebook_Handle, brandRow.Twitter_Handle,
  ];
  let mentions = [];
  try { mentions = await collectMentions(brand, keywords, 120, ownHandles); }
  catch (e) { console.warn(`[runs] mention search failed for ${brand}:`, e.message); }

  let comments = [];
  try { comments = await collectComments(brand, normalizedPosts.filter(p => p.brand !== 'no_data')); }
  catch (e) { console.warn(`[runs] comment fetch failed for ${brand}:`, e.message); }

  const fresh = [...mentions, ...comments];

  // Classify sentiment/intent for the freshly-fetched items only.
  if (fresh.length) {
    const verdicts = await classifyTexts(fresh.map((m, i) => ({ id: i, text: m.post_text })));
    fresh.forEach((m, i) => { const v = verdicts[i] || {}; m.sentiment = v.sentiment || 'neutral'; m.intent = v.intent || 'General Discussion'; });
  }

  // Rows-based accumulation (no 50KB cell cap): merge with everything already stored in the
  // Mentions sheet, append only the NEW ones as rows, keep the FULL set in memory for this run.
  const keyOf = m => m.type === 'comment'
    ? `${brand}|${m.post_url}|${m.author_handle}|${String(m.post_text || '').slice(0, 50)}`
    : `${brand}|${m.post_url || (m.plateform + '|' + String(m.post_text || '').slice(0, 50))}`;
  let prior = [];
  if (sheetsConfigured()) { try { prior = await readMentions(brand); } catch (e) { console.warn('[runs] readMentions failed:', e.message); } }
  const seen = new Set(prior.map(m => m.dedup_key).filter(Boolean));
  const run_date = new Date().toISOString().split('T')[0];
  const all = prior.slice();
  const newRows = [];
  for (const m of fresh) {
    const k = keyOf(m);
    if (seen.has(k)) continue;
    seen.add(k); m.dedup_key = k; m.brand = brand; all.push(m);
    newRows.push({
      brand, run_date, dedup_key: k, plateform: m.plateform, type: m.type,
      author_name: m.author_name, author_handle: m.author_handle, author_avatar: m.author_avatar,
      verified: m.verified ? 1 : 0, followers: m.followers || 0,
      post_text: String(m.post_text || '').slice(0, 800), post_url: m.post_url,
      likes: m.likes || 0, comments: m.comments || 0, shares: m.shares || 0, views: m.views || 0,
      engagement: m.engagement || 0, eng_rate: m.eng_rate || 0, est_reach: m.est_reach || '0', est_impressions: m.est_impressions || '0',
      display_date: m.display_date || '', timestamps: m.timestamps || '', sentiment: m.sentiment || 'neutral', intent: m.intent || 'General Discussion',
    });
  }
  if (newRows.length && sheetsConfigured()) { try { await appendMentions(newRows); } catch (e) { console.warn('[runs] appendMentions failed:', e.message); } }
  console.log(`[runs] ${brand}: ${prior.length} stored + ${newRows.length} new = ${all.length} mentions (rows-based)`);

  dashboard.mentions = all;
  dashboard.mention_totals = tally(all);
  return all;
}

function emptyTotals() { return { total: 0, pos: 0, neg: 0, neu: 0, posPct: 0, negPct: 0, neuPct: 0, unique: 0 }; }
function tally(items) {
  let pos = 0, neg = 0, neu = 0;
  items.forEach(m => { if (m.sentiment === 'positive') pos++; else if (m.sentiment === 'negative') neg++; else neu++; });
  const total = items.length;
  const pct = n => (total ? Number(((n / total) * 100).toFixed(2)) : 0);
  const unique = new Set(items.map(m => m.author_handle).filter(Boolean)).size;
  return { total, pos, neg, neu, posPct: pct(pos), negPct: pct(neg), neuPct: pct(neu), unique };
}

// Serialize mentions to fit a Google Sheets cell (~50k limit), trimming if needed.
function mentionsToJSON(mentions) {
  // Drop the long thumbnail URL from the stored copy to fit more mentions in the cell
  // (the live run keeps full thumbs; cached cards just fall back to a platform gradient).
  const compact = mentions.map(m => ({
    plateform: m.plateform, type: m.type,
    author_name: m.author_name, author_handle: m.author_handle, author_avatar: m.author_avatar,
    verified: m.verified, followers: m.followers,
    post_text: String(m.post_text || '').slice(0, 180), post_url: m.post_url,
    likes: m.likes, comments: m.comments, shares: m.shares, views: m.views,
    engagement: m.engagement, eng_rate: m.eng_rate, est_reach: m.est_reach, est_impressions: m.est_impressions,
    display_date: m.display_date, timestamps: m.timestamps,
    sentiment: m.sentiment, intent: m.intent,
  }));
  let arr = compact;
  let json = JSON.stringify(arr);
  while (json.length > 49000 && arr.length > 1) {
    arr = arr.slice(0, Math.floor(arr.length * 0.8)); // drop lowest-priority tail
    json = JSON.stringify(arr);
  }
  return json;
}

// Whole-days elapsed since a sheet date cell (00:00-aligned), or Infinity if unparseable.
function daysSince(dateVal) {
  const t = sheetDateToMs(dateVal);
  if (Number.isNaN(t)) return Infinity;
  const a = new Date(t); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

// runId -> { run_id, run_date, brands: { [brand]: { status, dashboard, error } } }
const RUNS = new Map();

function newRunId() {
  return 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createRun(brands) {
  const run_id = newRunId();
  const run_date = new Date().toISOString().split('T')[0];
  const state = { run_id, run_date, brands: {} };
  brands.forEach(b => { state.brands[b] = { status: 'queued', dashboard: null, error: null }; });
  RUNS.set(run_id, state);
  return { run_id, total: brands.length };
}

// Process one brand end to end. Errors are captured, never thrown.
async function processBrand(state, brandRow, force = false) {
  const brand = brandRow['Brand Name'];
  try {
    // Weekly dedup: reuse a recent successful run instead of re-scraping (saves credits,
    // avoids duplicate dates). "Force refresh" bypasses this.
    if (!force && sheetsConfigured()) {
      let prev = null;
      try { prev = await getLatestDoneInsight(brand); } catch (e) { console.warn('[runs] dedup lookup failed:', e.message); }
      if (prev) {
        const age = daysSince(prev.run_date);
        if (age < RESCRAPE_MIN_DAYS) {
          let dash = null;
          try { dash = prev.dashboard_json ? JSON.parse(prev.dashboard_json) : null; } catch {}
          // Re-attach the FULL mentions history from the rows-based Mentions sheet (no cap).
          // Fall back to the legacy mentions_json for brands not yet re-run/migrated.
          if (dash) {
            let rows = [];
            try { rows = await readMentions(brand); } catch {}
            if (rows.length) dash.mentions = rows;
            else { try { dash.mentions = prev.mentions_json ? JSON.parse(prev.mentions_json) : (dash.mentions || []); } catch { dash.mentions = dash.mentions || []; } }
            dash.mention_totals = tally(dash.mentions || []);
          }
          console.log(`[runs] "${brand}" scraped ${age}d ago (< ${RESCRAPE_MIN_DAYS}d) — reusing cached result, not scraping.`);
          state.brands[brand] = {
            status: 'done',
            dashboard: dash,
            error: null,
            cached: true,
            last_run_date: prev.run_date,
          };
          return;
        }
      }
    }

    const tagged = await scrapeAllPlatforms(brandRow);
    const normalized = normalizePosts(tagged);

    // Persist raw posts (skip the no_data placeholder).
    const realRows = normalized.filter(p => p.brand !== 'no_data');
    if (realRows.length && sheetsConfigured()) {
      try { await appendRows(SHEET_RAW, realRows); }
      catch (e) { console.warn('[runs] Raw_Data write failed:', e.message); }
    }

    const { dashboard, flatRow } = await analyzeBrand(brand, normalized, state.run_id);

    // Brand-mention monitoring → accumulates in the rows-based Mentions sheet (no cell cap).
    const mentions = await buildMentions(brand, brandRow, normalized, dashboard);
    flatRow.mentions_count = mentions.length;
    flatRow.mentions_json = ''; // mentions now live in the Mentions sheet, not this cell

    if (sheetsConfigured()) {
      try { await upsertRow(SHEET_INSIGHTS, flatRow, ['run_id', 'brand']); }
      catch (e) { console.warn('[runs] AI_Insights write failed:', e.message); }
    }

    state.brands[brand] = {
      status: flatRow.status === 'done' ? 'done' : 'error',
      dashboard,
      error: flatRow.status === 'done' ? null : 'no posts found',
    };
  } catch (e) {
    console.error(`[runs] brand "${brand}" failed:`, e);
    state.brands[brand] = { status: 'error', dashboard: null, error: e.message };
  }
}

// Kick off the background work for a run. Resolves immediately.
export async function startWork(run_id, requestedBrands, force = false) {
  const state = RUNS.get(run_id);
  if (!state) return;

  // Look up handles from the Brand sheet.
  let brandRows = [];
  try {
    brandRows = await readBrands(requestedBrands);
  } catch (e) {
    console.error('[runs] could not read Brand sheet:', e.message);
    requestedBrands.forEach(b => { state.brands[b] = { status: 'error', dashboard: null, error: 'Brand sheet read failed: ' + e.message }; });
    return;
  }

  // Any requested brand with no matching sheet row → mark error.
  const foundNames = new Set(brandRows.map(r => r['Brand Name'].toLowerCase()));
  requestedBrands.forEach(b => {
    if (!foundNames.has(b.toLowerCase())) {
      state.brands[b] = { status: 'error', dashboard: null, error: 'Brand not found in sheet' };
    }
  });

  // Process brands sequentially to stay within API rate limits.
  (async () => {
    for (const row of brandRows) {
      await processBrand(state, row, force);
    }
  })().catch(e => console.error('[runs] worker crashed:', e));
}

// Build the /status payload the frontend expects.
export async function getStatus(run_id) {
  let state = RUNS.get(run_id);

  // Fallback: not in memory (e.g. after a restart) → reconstruct from the sheet.
  if (!state && sheetsConfigured()) {
    try {
      const rows = await readInsights(run_id);
      if (rows.length) {
        state = { run_id, brands: {} };
        rows.forEach(r => {
          let dash = null;
          try { dash = r.dashboard_json ? JSON.parse(r.dashboard_json) : null; } catch {}
          state.brands[r.brand] = { status: String(r.status || 'done').toLowerCase(), dashboard: dash, error: null };
        });
      }
    } catch (e) { console.warn('[runs] status fallback failed:', e.message); }
  }

  if (!state) {
    return { run_id, finished: false, total: 0, done: 0, errored: 0, brands: [] };
  }

  const entries = Object.entries(state.brands);
  const total = entries.length;
  const done = entries.filter(([, v]) => v.status === 'done').length;
  const errored = entries.filter(([, v]) => v.status === 'error').length;

  return {
    run_id,
    finished: total > 0 && (done + errored) >= total,
    total, done, errored,
    brands: entries.map(([brand, v]) => ({
      brand,
      status: v.status,
      dashboard: v.status === 'done' ? v.dashboard : null,
    })),
  };
}
