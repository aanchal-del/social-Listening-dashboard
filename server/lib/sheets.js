// Google Sheets access — replaces the n8n Google Sheets nodes.
// Reads the Brand list, appends Raw_Data, and upserts AI_Insights rows.
import { google } from 'googleapis';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SPREADSHEET_ID, SHEET_BRANDS, SHEET_RAW, SHEET_INSIGHTS, SHEET_MENTIONS,
  GOOGLE_CREDENTIALS_PATH, GOOGLE_TOKEN_PATH, GOOGLE_SCOPES,
} from '../config.js';

let _sheets = null;

export function loadCredentials() {
  // Either an inline JSON env or a file path.
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  const p = resolve(GOOGLE_CREDENTIALS_PATH);
  if (!existsSync(p)) {
    throw new Error(`Google credentials not found at ${p}. Set GOOGLE_CREDENTIALS_PATH or GOOGLE_SERVICE_ACCOUNT_JSON.`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

// Build an OAuth2 client from an installed/web desktop-app credentials file.
export function makeOAuthClient(creds) {
  const conf = creds.installed || creds.web;
  if (!conf) throw new Error('Not an OAuth client credentials file (missing "installed"/"web").');
  // Desktop clients use loopback redirects; we pick a fixed local port for the consent flow.
  const redirect = (conf.redirect_uris && conf.redirect_uris[0]) || 'http://localhost';
  return new google.auth.OAuth2(conf.client_id, conf.client_secret, redirect);
}

// Returns a ready-to-use auth client, choosing the right kind from the file shape.
function getAuth() {
  const creds = loadCredentials();
  if (creds.type === 'service_account' || creds.client_email) {
    return new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: GOOGLE_SCOPES });
  }
  if (creds.installed || creds.web) {
    const oAuth = makeOAuthClient(creds);
    const tokenPath = resolve(GOOGLE_TOKEN_PATH);
    if (!existsSync(tokenPath)) {
      throw new Error(`OAuth token not found at ${tokenPath}. Run "bun run auth" once to sign in.`);
    }
    oAuth.setCredentials(JSON.parse(readFileSync(tokenPath, 'utf8')));
    return oAuth;
  }
  throw new Error('Unrecognised Google credentials file format.');
}

function getClient() {
  if (_sheets) return _sheets;
  _sheets = google.sheets({ version: 'v4', auth: getAuth() });
  return _sheets;
}

// True when we have everything needed to actually call Sheets.
export function sheetsConfigured() {
  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return true;
    if (!existsSync(resolve(GOOGLE_CREDENTIALS_PATH))) return false;
    const creds = loadCredentials();
    if (creds.type === 'service_account' || creds.client_email) return true;
    // OAuth client also needs the cached token.
    return existsSync(resolve(GOOGLE_TOKEN_PATH));
  } catch { return false; }
}

// Read every row of a tab as objects keyed by the header row.
async function readObjects(sheetName) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return { header: rows[0] || [], objects: [] };
  const header = rows[0].map(h => String(h).trim());
  const objects = rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] != null ? r[i] : ''; });
    return o;
  });
  return { header, objects };
}

// ── Brand list (handles per brand) ──
export async function readBrands(requested = []) {
  const { objects } = await readObjects(SHEET_BRANDS);
  const wanted = requested.map(b => String(b).trim().toLowerCase()).filter(Boolean);
  let rows = objects.filter(r => String(r['Brand Name'] || '').trim());
  if (wanted.length) {
    rows = rows.filter(r => wanted.includes(String(r['Brand Name']).trim().toLowerCase()));
  }
  return rows.map(cleanHandles);
}

// Mirror of the n8n "Clean Handles" node.
function bare(v) {
  return String(v || '').trim().replace(/^@+/, '').replace(/\s+/g, '');
}
function slug(v) {
  let s = String(v || '').trim();
  const m = s.match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (m) s = m[1];
  return s.toLowerCase().replace(/\s+/g, '-').replace(/^@+/, '');
}
function cleanHandles(r) {
  return {
    ...r,
    'Brand Name': (r['Brand Name'] || '').trim(),
    LinkedIn_Handle: slug(r['LinkedIn_Handle']),
    Instagram_Handle: bare(r['Instagram_Handle']),
    YouTube_Handle: bare(r['YouTube_Handle']),
    Facebook_Handle: bare(r['Facebook_Handle']),
    Twitter_Handle: bare(r['Twitter_Handle']),
  };
}

// Ensure a header row exists and includes every key; return the (possibly extended) header.
async function ensureHeader(sheetName, keys) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!1:1`,
  });
  let header = ((res.data.values && res.data.values[0]) || []).map(h => String(h).trim());
  const missing = keys.filter(k => !header.includes(k));
  if (!header.length) {
    header = keys.slice();
  } else if (missing.length) {
    header = [...header, ...missing]; // append new columns, keep existing order
  } else {
    return header;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!1:1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header] },
  });
  return header;
}

// Append objects to a tab, aligning each to the existing header.
export async function appendRows(sheetName, objects) {
  if (!objects.length) return;
  const keys = [...new Set(objects.flatMap(o => Object.keys(o)))];
  const header = await ensureHeader(sheetName, keys);
  const values = objects.map(o => header.map(h => {
    const v = o[h];
    return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
  }));
  const sheets = getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

// Append or update one row, matching on the given key columns (run_id + brand).
export async function upsertRow(sheetName, obj, matchKeys = ['run_id', 'brand']) {
  const keys = Object.keys(obj);
  const header = await ensureHeader(sheetName, keys);
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${sheetName}`,
  });
  const rows = res.data.values || [];
  const colIdx = {};
  header.forEach((h, i) => { colIdx[h] = i; });

  const rowValues = header.map(h => {
    const v = obj[h];
    return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
  });

  // Find a data row whose match keys all equal obj's.
  let foundRow = -1;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const match = matchKeys.every(k => String(r[colIdx[k]] ?? '') === String(obj[k] ?? ''));
    if (match) { foundRow = i; break; }
  }

  if (foundRow >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A${foundRow + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [rowValues] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowValues] },
    });
  }
}

// ── Mentions history (rows-based — one row per mention, no 50KB cell cap) ──
const MENTION_NUM = ['verified', 'followers', 'likes', 'comments', 'shares', 'views', 'engagement', 'eng_rate'];
// Create a sheet/tab if it doesn't exist yet.
async function ensureSheet(name) {
  const sheets = getClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties.title' });
  const exists = (meta.data.sheets || []).some(s => s.properties.title === name);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: name } } }] },
    });
  }
}
export async function appendMentions(rows) {
  if (!rows || !rows.length) return;
  await ensureSheet(SHEET_MENTIONS);
  await appendRows(SHEET_MENTIONS, rows);
}
export async function readMentions(brand) {
  let objects = [];
  try { objects = (await readObjects(SHEET_MENTIONS)).objects; } catch { return []; }
  const want = String(brand).trim().toLowerCase();
  return objects
    .filter(r => String(r.brand || '').trim().toLowerCase() === want)
    .map(r => {
      const m = { ...r };
      MENTION_NUM.forEach(k => { if (m[k] !== undefined && m[k] !== '') m[k] = Number(m[k]) || 0; });
      m.verified = m.verified === true || m.verified === 1 || m.verified === '1' || m.verified === 'true';
      return m;
    });
}
export async function readMentionKeys(brand) {
  const rows = await readMentions(brand);
  return new Set(rows.map(r => r.dedup_key).filter(Boolean));
}

// Read previously-stored insights for a run (used as a fallback after restart).
export async function readInsights(runId) {
  const { objects } = await readObjects(SHEET_INSIGHTS);
  return objects.filter(r => String(r.run_id || '') === String(runId));
}

// Parse a date cell to epoch ms, tolerating both ISO strings ("2026-06-04")
// and Google Sheets serial numbers (days since 1899-12-30) returned by
// UNFORMATTED_VALUE for date-typed cells.
export function sheetDateToMs(v) {
  if (v == null || v === '') return NaN;
  const serial = ms => Date.UTC(1899, 11, 30) + Math.round(ms * 86400000);
  if (typeof v === 'number') return serial(v);
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return serial(parseFloat(s)); // bare number => serial date
  return Date.parse(s);
}

// Most recent successful ('done') insight row for a brand, or null.
// Used to enforce the weekly re-scrape limit (no duplicate dates / wasted credits).
export async function getLatestDoneInsight(brand) {
  const { objects } = await readObjects(SHEET_INSIGHTS);
  const want = String(brand).trim().toLowerCase();
  let best = null, bestT = -Infinity;
  for (const r of objects) {
    if (String(r.brand || '').trim().toLowerCase() !== want) continue;
    if (String(r.status || '').toLowerCase() !== 'done') continue;
    const t = sheetDateToMs(r.run_date);
    if (Number.isNaN(t)) continue;
    // run_date is day-granular; on ties prefer the LATER row (>=) so the most
    // recent run of the day (which has the freshest mentions) wins.
    if (t >= bestT) { bestT = t; best = r; }
  }
  return best;
}
