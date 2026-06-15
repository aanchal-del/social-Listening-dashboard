# Deployment Guide — Social Listening Dashboard (Contextual Pulse)

This guide is for the IT/server admin deploying the dashboard onto the internal server
so it works at **`https://192.168.1.112/social-listen/index.html`** (replacing the old n8n setup).

---

## 1. What this app is (read first)

It has **two parts** — both must be deployed:

1. **Frontend** — a static page (`index.html` + `config.js`) served by nginx at `/social-listen/`.
2. **Backend** — a small **Bun** service in the `server/` folder. It does all the work:
   scrapes social data (Scrape Creators), runs AI sentiment (NVIDIA), and reads/writes a
   Google Sheet. It listens on **port 3000** and exposes:
   - `POST /webhook/analyze`  — start an analysis
   - `GET  /webhook/status`   — poll for results
   - `GET  /health`           — health check

The frontend calls `/webhook/analyze` and `/webhook/status` on the **same origin**, so nginx
must proxy those two paths to the backend (this is what the old n8n used to do).

```
Browser ──► nginx (443 on 192.168.1.112)
              ├─ /social-listen/      ──► static files (index.html, config.js)
              └─ /webhook/...         ──► http://127.0.0.1:3000  (the Bun backend)
```

---

## 2. Files in this folder

| Path | What it is | Sensitive? |
|------|------------|-----------|
| `index.html` | the dashboard page | no |
| `config.js` | dashboard config (leave as-is for same-origin) | no |
| `server/` | the backend service (Bun) | — |
| `server/.env` | **API keys** (Scrape Creators, NVIDIA) + settings | 🔒 **secret** |
| `credentials.json` | Google OAuth client file | 🔒 **secret** |
| `server/credentials/token.json` | saved Google access token (so no browser login is needed) | 🔒 **secret** |

> ⚠️ The 🔒 files are secrets. Keep them out of any public web directory and don't commit
> them to a public repo. Without them the backend cannot reach Scrape Creators / NVIDIA / Google.

---

## 3. Prerequisites on the server

- **Bun** runtime (Node is not required):
  ```bash
  curl -fsSL https://bun.sh/install | bash
  # then restart the shell, or: source ~/.bashrc
  bun --version
  ```
- **Outbound internet access** from the server to:
  - `api.scrapecreators.com`
  - `integrate.api.nvidia.com`
  - `*.googleapis.com`
- nginx already running and terminating TLS on 443 (it already serves `/social-listen/`).

---

## 4. Deploy the backend

```bash
# pick a location, e.g.:
sudo mkdir -p /opt/social-listen
# copy the whole project here (including server/, credentials.json, server/.env,
# and server/credentials/token.json)
cd /opt/social-listen/server

bun install          # install dependencies
bun run start        # quick test — should print "backend running → http://localhost:3000"
```

Open a second terminal and verify:
```bash
curl http://127.0.0.1:3000/health
# expect: {"ok":true,"sheets":true,"missing":[]}
```
If `sheets` is `false` or `missing` lists keys, check section 7 (Troubleshooting).

Stop the test (`Ctrl+C`) and set it up as an always-on service so it survives reboots:

**`/etc/systemd/system/social-listen.service`**
```ini
[Unit]
Description=Social Listening Backend (Bun)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/social-listen/server
ExecStart=/root/.bun/bin/bun run index.js
Restart=always
RestartSec=5
# adjust User and the bun path to match your install (run `which bun`)

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now social-listen
sudo systemctl status social-listen      # should be "active (running)"
```

---

## 5. Serve the frontend + proxy the API (nginx)

1. **Static files:** put `index.html` and `config.js` in the directory nginx serves for
   `/social-listen/` (replace the existing old files there).

2. **Proxy the two API paths** to the backend. In the server block for `192.168.1.112`,
   add (replacing whatever pointed at n8n):

   ```nginx
   location /webhook/ {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_read_timeout 600s;     # scrapes/AI can take a few minutes
       proxy_send_timeout 600s;
   }
   ```

3. Reload nginx:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

4. **Turn off the old n8n** (so nothing else answers `/webhook/...`).

> `config.js` is set for **same-origin** (no `N8N_BASE_URL`), which is correct for this setup —
> the page and the API are both on `https://192.168.1.112`. Leave it as-is.

---

## 6. Google Sheet access

The backend reads/writes this spreadsheet:
`https://docs.google.com/spreadsheets/d/1ZIR6LbydR_JZR-o06ifp37GeYaOr6hu0gaibQ2C6lO4`

- The saved token (`server/credentials/token.json`) belongs to **`aanchal@infectious.in`** —
  keep the sheet **shared with that account (Editor)**.
- (Optional, cleaner for a server) Swap to a **Google service account**: put its JSON key on the
  box, set `GOOGLE_CREDENTIALS_PATH` in `server/.env` to point at it, and share the sheet with the
  service-account email. The backend auto-detects either credential type — no code change needed.

---

## 7. Verify it end to end

1. Backend health: `curl http://127.0.0.1:3000/health` → `{"ok":true,"sheets":true,...}`
2. Open **`https://192.168.1.112/social-listen/index.html`** in a browser.
3. It should auto-load the brands and show data. Pick a brand → **Analyze** → results appear.
4. Quick API check through nginx:
   ```bash
   curl -k "https://192.168.1.112/webhook/status?run_id=test"
   # expect JSON like: {"run_id":"test","finished":false,...}
   ```

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `health` shows `sheets:false` | `credentials.json` / `token.json` missing or sheet not shared with `aanchal@infectious.in`. Check `GOOGLE_CREDENTIALS_PATH` in `server/.env`. |
| `missing` lists `SCRAPECREATORS_API_KEY` / `NVIDIA_API_KEY` | `server/.env` wasn't copied or keys are blank. |
| Dashboard loads but Analyze does nothing | nginx isn't proxying `/webhook/` to `127.0.0.1:3000`, or the service isn't running (`systemctl status social-listen`). |
| "out of credits" in results | top up the Scrape Creators account. |
| Analyze times out | increase nginx `proxy_read_timeout` (scrape + AI can take a few minutes). |

---

## 9. Notes / good to know

- **Re-scrape cadence:** each brand is re-fetched at most **once per 7 days** (cached otherwise),
  so repeated clicks cost no credits. "Force refresh" in the UI overrides this.
- **Costs:** Scrape Creators charges credits per fetch (~30–170 credits per brand depending on
  comment volume). NVIDIA and Google Sheets are on their own keys/quota.
- **Ports:** only `3000` is used internally by the backend; it never needs to be exposed publicly —
  nginx is the only thing the browser talks to.
- **To change the port:** edit `PORT` in `server/.env` and update the nginx `proxy_pass` to match.
