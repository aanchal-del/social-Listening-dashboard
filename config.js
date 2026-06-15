// config.js — dashboard configuration.
//
// The dashboard is now served BY its own backend (see /server), so it talks to
// the API on the SAME ORIGIN. Leave N8N_BASE_URL unset for that (recommended):
// the app calls /webhook/analyze and /webhook/status relative to wherever it's hosted.
//
// Only set N8N_BASE_URL if you host the static page somewhere OTHER than the backend
// (then point it at the backend, e.g. 'http://localhost:3000'). The backend sends
// permissive CORS headers, so cross-origin works too.
//
// window.N8N_BASE_URL = 'http://localhost:3000';

// Brands shown in the Analyze picker. These must exist as rows in the backend's
// Google "Brand" sheet (the same sheet the old n8n workflow read).
window.N8N_BRANDS = ['Ebco', 'Hettich', 'Hafele', 'American Express'];

// YOUR brand (everything else in the list is treated as a competitor for benchmarking).
window.OWN_BRAND = 'Ebco';
