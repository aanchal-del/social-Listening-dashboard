// config.example.js — copy to config.js to customise the dashboard.
//
// The dashboard is served by its own backend (see /server) and talks to the API
// on the SAME ORIGIN by default — so you usually don't need to set anything here.
//
// Set N8N_BASE_URL ONLY if the static page is hosted separately from the backend.
// Point it at the backend's URL. The backend sends permissive CORS headers.
//
// window.N8N_BASE_URL = 'http://localhost:3000';

// Brands shown in the Analyze picker. Must match rows in the backend's Google "Brand" sheet.
window.N8N_BRANDS = ['Ebco', 'Hettich'];
