// Central config — reads from environment (Bun auto-loads .env).
const env = process.env;

export const PORT = Number(env.PORT || 3000);

// Re-scrape cadence: a brand scraped successfully within this many days is reused
// instead of scraped again (no duplicate dates / no wasted credits). "Force refresh"
// in the UI overrides this. Default = weekly.
export const RESCRAPE_MIN_DAYS = Number(env.RESCRAPE_MIN_DAYS || 7);

export const SCRAPECREATORS_API_KEY = env.SCRAPECREATORS_API_KEY || '';

export const NVIDIA_API_KEY = env.NVIDIA_API_KEY || '';
export const NVIDIA_MODEL = env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';
// Tolerate a base URL without the /chat/completions path.
function fullNvidiaUrl(u) {
  u = (u || 'https://integrate.api.nvidia.com/v1/chat/completions').replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(u)) u += '/chat/completions';
  return u;
}
export const NVIDIA_URL = fullNvidiaUrl(env.NVIDIA_URL);

export const SPREADSHEET_ID = env.SPREADSHEET_ID || '1ZIR6LbydR_JZR-o06ifp37GeYaOr6hu0gaibQ2C6lO4';
export const SHEET_BRANDS = env.SHEET_BRANDS || 'Brand';
export const SHEET_RAW = env.SHEET_RAW || 'Raw_Data';
export const SHEET_INSIGHTS = env.SHEET_INSIGHTS || 'AI_Insights';
export const SHEET_MENTIONS = env.SHEET_MENTIONS || 'Mentions'; // rows-based mention history (no 50KB cell cap)

export const GOOGLE_CREDENTIALS_PATH = env.GOOGLE_CREDENTIALS_PATH || './credentials/service-account.json';
export const GOOGLE_TOKEN_PATH = env.GOOGLE_TOKEN_PATH || './credentials/token.json';
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// Scrape Creators endpoints (same as the n8n workflow).
export const SCRAPE_ENDPOINTS = {
  linkedin: handle => ({
    url: 'https://api.scrapecreators.com/v1/linkedin/company/posts',
    query: { url: `https://linkedin.com/company/${handle}` },
  }),
  instagram: handle => ({
    url: 'https://api.scrapecreators.com/v2/instagram/user/posts',
    query: { handle },
  }),
  youtube: handle => ({
    url: 'https://api.scrapecreators.com/v1/youtube/channel-videos',
    query: { handle },
  }),
  facebook: handle => ({
    url: 'https://api.scrapecreators.com/v1/facebook/profile/posts',
    query: { url: `https://www.facebook.com/${handle}` },
  }),
  twitter: handle => ({
    url: 'https://api.scrapecreators.com/v1/twitter/user-tweets',
    query: { handle, trim: 'true' },
  }),
};

// Warn loudly at boot if something critical is missing.
export function checkConfig() {
  const missing = [];
  if (!SCRAPECREATORS_API_KEY) missing.push('SCRAPECREATORS_API_KEY');
  if (!NVIDIA_API_KEY) missing.push('NVIDIA_API_KEY');
  return missing;
}
