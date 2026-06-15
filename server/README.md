# Contextual Pulse — Backend

This backend replaces the old **n8n** workflow. It does everything n8n did, in one Node/Bun process:

1. Reads each brand's social handles from your Google **Brand** sheet.
2. Scrapes LinkedIn, Instagram, YouTube, Facebook and X/Twitter via the **Scrape Creators** API.
3. Normalises posts and writes them to the **Raw_Data** sheet.
4. Sends them to **NVIDIA NIM** (Llama 3.3 70B) for sentiment / intent / keyword analysis.
5. Writes the result to the **AI_Insights** sheet and serves it to the dashboard.

It also serves the dashboard (`../index.html`) itself, so the whole app runs from one URL.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/webhook/analyze` | `{ brands:[...], force:bool }` → `{ run_id, status, total }` |
| GET | `/webhook/status?run_id=…` | run progress + finished dashboards |
| GET | `/health` | config check |
| GET | `/` | the dashboard |

## Setup

1. **Install [Bun](https://bun.sh)** (already installed here at `~/.bun/bin/bun`).

2. **Install dependencies:**
   ```bash
   cd server
   bun install
   ```

3. **Create `.env`** from the template and fill in your keys:
   ```bash
   cp .env.example .env
   ```
   - `SCRAPECREATORS_API_KEY` — from https://scrapecreators.com
   - `NVIDIA_API_KEY` — from https://build.nvidia.com
   - `SPREADSHEET_ID` — already set to the existing sheet

4. **Google service account** (for the Brand / Raw_Data / AI_Insights sheets):
   - In Google Cloud, create a service account and download its JSON key.
   - Save it as `server/credentials/service-account.json` (or set `GOOGLE_CREDENTIALS_PATH`).
   - **Share the spreadsheet** with the service account's `client_email` (Editor).

5. **Run:**
   ```bash
   bun run start        # or: bun run dev   (auto-reload)
   ```
   Open **http://localhost:3000** — pick brands, click **Analyze**.

## Notes

- The `Brand` sheet must have columns: `Brand Name`, `LinkedIn_Handle`, `Instagram_Handle`, `YouTube_Handle`, `Facebook_Handle`, `Twitter_Handle`.
- Brands in the dashboard's Analyze picker come from `../config.js` (`window.N8N_BRANDS`) and must match rows in the Brand sheet.
- Run state is kept in memory; results are persisted to Google Sheets, so a finished run can still be re-read by `run_id` after a restart.
- Secrets (`.env`, `credentials/*.json`) are git-ignored.
