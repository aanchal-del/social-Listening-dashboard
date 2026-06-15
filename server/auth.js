// One-time Google OAuth sign-in for desktop-app credentials.
// Run:  bun run auth
// Opens a consent URL; after you approve, the refresh token is cached so the
// server can read/write your Google Sheet unattended from then on.
import { google } from 'googleapis';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadCredentials } from './lib/sheets.js';
import { GOOGLE_TOKEN_PATH, GOOGLE_SCOPES } from './config.js';

const PORT = 4117;
const REDIRECT = `http://localhost:${PORT}`;

const creds = loadCredentials();
const conf = creds.installed || creds.web;
if (!conf) {
  console.error('credentials.json is not an OAuth desktop/web client. If it is a service account, you do NOT need this step.');
  process.exit(1);
}

const oAuth = new google.auth.OAuth2(conf.client_id, conf.client_secret, REDIRECT);
const authUrl = oAuth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: GOOGLE_SCOPES,
});

console.log('\n  1) Open this URL in your browser and approve access:\n');
console.log('     ' + authUrl + '\n');
console.log(`  2) Waiting for the redirect on ${REDIRECT} …\n`);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (err) return new Response('Authorization failed: ' + err, { status: 400 });
    if (!code) return new Response('Waiting for Google redirect…');
    try {
      const { tokens } = await oAuth.getToken(code);
      const tokenPath = resolve(GOOGLE_TOKEN_PATH);
      mkdirSync(dirname(tokenPath), { recursive: true });
      writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
      console.log('  ✓ Saved token to ' + tokenPath);
      console.log('  You can close the browser tab. Starting the server now is safe.\n');
      setTimeout(() => process.exit(0), 300);
      return new Response('✓ Success! Authorization complete. You can close this tab and return to the terminal.', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    } catch (e) {
      console.error('  ✗ Token exchange failed:', e.message);
      return new Response('Token exchange failed: ' + e.message, { status: 500 });
    }
  },
});

void server;
