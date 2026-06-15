// Mirror of the n8n "Build AI Prompt" → "NVIDIA NIM" → "Parse AI Response" nodes.
// Takes normalised posts for one brand, asks NVIDIA NIM for the analysis,
// and builds the rich `dashboard` object the frontend expects.
import { NVIDIA_API_KEY, NVIDIA_MODEL, NVIDIA_URL } from '../config.js';

const today = () => new Date().toISOString().split('T')[0];

function buildPrompt(posts, brandName) {
  const trimmed = posts
    .filter(p => p.brand !== 'no_data')
    .slice(0, 25)
    .map((p, i) => ({
      id: i,
      platform: p.plateform,
      text: (p.post_text || '').substring(0, 240),
      likes: p.likes, comments: p.comments, shares: p.shares, views: p.views,
    }));

  const schema = `Return ONLY valid raw JSON (no markdown, no backticks, no commentary) with EXACTLY this shape:
{
  "sentiment_score": <number 0-100>,
  "summary": "<max 220 chars market overview>",
  "post_sentiments": [ { "id": <int>, "sentiment": "positive|negative|neutral", "intent": "Appreciation|Product Inquiry|General Discussion|Complaint|Feedback|Suggestion|Brand Promo|Support Request" } ],
  "keywords": [ { "name": "<context>", "count": <int>, "nss": <number -10..10> } ],
  "intents": [ { "name": "<intent>", "total": <int>, "pos": <int>, "neg": <int>, "neu": <int> } ],
  "cross_brands": [ { "name": "<brand>", "weight": <int 1-100> } ],
  "handles": [ { "name": "<@handle>", "weight": <int 1-100> } ],
  "products": [ { "name": "<product>", "weight": <int 1-100> } ],
  "product_sentiment": [ { "name": "<product>", "pos": <int 0-100>, "neg": <int 0-100> } ],
  "locations": [ { "name": "<place>", "pos": <int>, "neg": <int>, "neu": <int> } ]
}
Rules:
- post_sentiments MUST contain one entry per input post id.
- keywords: 8-13 items, the key contexts/themes across posts.
- intents: cover all 8 intent categories listed; set counts to 0 if absent.
- cross_brands/handles/products: extract real entities mentioned; weight = relative frequency.
- product_sentiment: pos+neg should sum to 100 per product.
- locations: places mentioned or implied (default India-centric if unclear).`;

  const promptText =
    `You are a social-media analytics engine. Analyze these posts for the brand "${brandName}".\n` +
    schema + `\nPosts JSON: ` + JSON.stringify(trimmed);

  return { promptText, postCount: trimmed.length };
}

async function callNvidia(promptText) {
  // neverError-equivalent: a timeout or network error must NOT fail the brand.
  // We return {} so buildDashboard still produces a dashboard from the scraped
  // posts (neutral-sentiment fallback) instead of throwing.
  try {
    const res = await fetch(NVIDIA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [
          { role: 'system', content: 'You are a precise analytics engine that returns only valid JSON.' },
          { role: 'user', content: promptText },
        ],
        temperature: 0.2,
        max_tokens: 8000,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(180000),
    });
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.warn(`[analyze] NVIDIA call failed (${e.name}: ${e.message}); using non-AI fallback.`);
    return {};
  }
}

// Tolerant JSON extraction (mirrors the salvageJSON helper in n8n).
function salvageJSON(s) {
  let cleaned = String(s).replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start >= 0) cleaned = cleaned.slice(start);
  try { return JSON.parse(cleaned); } catch {}
  let depth = 0, inStr = false, esc = false, lastSafe = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 1) lastSafe = i; }
  }
  if (lastSafe > 0) {
    const frag = cleaned.slice(0, lastSafe + 1).replace(/,\s*$/, '') + '}';
    try { return JSON.parse(frag); } catch {}
  }
  return null;
}

const PLT_COLOR = { instagram: '#eb7ea8', linkedin: '#5b8dee', facebook: '#5b9ded', youtube: '#f16060', twitter: '#5acce6' };

// Build the final dashboard object + a flat row for the AI_Insights sheet.
function buildDashboard(aiRaw, brandName, posts, runId) {
  let resp = salvageJSON(aiRaw) || {};
  ['post_sentiments', 'keywords', 'intents', 'cross_brands', 'handles', 'products', 'product_sentiment', 'locations']
    .forEach(k => { if (!Array.isArray(resp[k])) resp[k] = []; });
  if (typeof resp.sentiment_score !== 'number') resp.sentiment_score = 50;
  if (typeof resp.summary !== 'string') resp.summary = '';

  const realPosts = posts.filter(p => p.brand !== 'no_data');
  const sentMap = {};
  resp.post_sentiments.forEach(s => { sentMap[s.id] = s; });

  const enrichedPosts = realPosts.map((p, i) => ({
    ...p,
    name: p.handle ? String(p.handle).replace(/^@/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : (p.brand || ''),
    color: PLT_COLOR[p.plateform] || '#4b52d4',
    sentiment: sentMap[i]?.sentiment || 'neutral',
    intent: sentMap[i]?.intent || 'General Discussion',
  }));

  let pos = 0, neg = 0, neu = 0;
  enrichedPosts.forEach(p => { if (p.sentiment === 'positive') pos++; else if (p.sentiment === 'negative') neg++; else neu++; });
  const total = enrichedPosts.length || 0;
  const pct = n => (total ? Number(((n / total) * 100).toFixed(2)) : 0);

  const totalLikes = enrichedPosts.reduce((s, p) => s + (Number(p.likes) || 0), 0);
  const totalComments = enrichedPosts.reduce((s, p) => s + (Number(p.comments) || 0), 0);
  const totalShares = enrichedPosts.reduce((s, p) => s + (Number(p.shares) || 0), 0);
  const totalViews = enrichedPosts.reduce((s, p) => s + (Number(p.views) || 0), 0);
  const totalEng = totalLikes + totalComments + totalShares;

  const sovMap = {};
  enrichedPosts.forEach(p => { sovMap[p.plateform] = (sovMap[p.plateform] || 0) + 1; });
  const sov = Object.entries(sovMap).map(([name, count]) => ({ name, count, pct: total ? Number(((count / total) * 100).toFixed(1)) : 0 }));

  const sb = {};
  enrichedPosts.forEach(p => {
    if (!sb[p.plateform]) sb[p.plateform] = { pos: 0, neg: 0, neu: 0 };
    if (p.sentiment === 'positive') sb[p.plateform].pos++;
    else if (p.sentiment === 'negative') sb[p.plateform].neg++;
    else sb[p.plateform].neu++;
  });

  const trend = {};
  enrichedPosts.forEach(p => {
    const d = new Date(p.timestamps);
    if (isNaN(d)) return;
    const key = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    if (!trend[p.plateform]) trend[p.plateform] = {};
    trend[p.plateform][key] = (trend[p.plateform][key] || 0) + 1;
  });

  const uniqueUsers = new Set(enrichedPosts.map(p => p.handle)).size;

  const dashboard = {
    brand: brandName,
    run_date: today(),
    totals: { total, pos, neg, neu, posPct: pct(pos), negPct: pct(neg), neuPct: pct(neu), unique: uniqueUsers },
    sentiment_score: resp.sentiment_score ?? 50,
    market_overview: resp.summary || '',
    platform_sov: sov,
    sentiment_breakdown: sb,
    trend,
    intents: resp.intents || [],
    keywords: resp.keywords || [],
    cross_brands: resp.cross_brands || [],
    handles: resp.handles || [],
    products: resp.products || [],
    product_sentiment: resp.product_sentiment || [],
    locations: resp.locations || [],
    posts: enrichedPosts,
  };

  const flatRow = {
    brand: brandName,
    run_date: dashboard.run_date,
    run_id: runId || '',
    status: total > 0 ? 'done' : 'error',
    sentiment_score: dashboard.sentiment_score,
    sentiment_category: pos >= neg && pos >= neu ? 'Positive' : (neg >= pos && neg >= neu ? 'Negative' : 'Neutral'),
    market_overview: dashboard.market_overview,
    keyword: (resp.keywords || []).map(k => k.name).slice(0, 8).join(', '),
    total_posts: total,
    total_likes: totalLikes,
    total_comments: totalComments,
    total_shares: totalShares,
    total_views: totalViews,
    total_engagement: totalEng,
    average_engagement: total > 0 ? (totalEng / total).toFixed(2) : '0',
    positive: pos, negative: neg, neutral: neu,
    unique_users: uniqueUsers,
    dashboard_json: '',
  };

  const compactPosts = enrichedPosts.map(p => ({
    brand: p.brand, handle: p.handle, plateform: p.plateform,
    post_url: p.post_url,
    post_text: String(p.post_text || '').substring(0, 200),
    likes: p.likes, comments: p.comments, shares: p.shares, views: p.views,
    engagement: p.engagement, eng_rate: p.eng_rate,
    est_reach: p.est_reach, est_impressions: p.est_impressions,
    display_date: p.display_date, timestamps: p.timestamps,
    name: p.name, color: p.color,
    sentiment: p.sentiment, intent: p.intent,
  }));
  const compactDashboard = { ...dashboard, posts: compactPosts };
  let djson = JSON.stringify(compactDashboard);
  if (djson.length > 49000) {
    djson = JSON.stringify({ ...compactDashboard, posts: [], _note: 'posts omitted: exceeded cell size' });
  }
  flatRow.dashboard_json = djson;

  return { dashboard, flatRow };
}

// Classify an array of { id, text } into sentiment + intent, in batches.
// Used for third-party mentions and comments (the brand's own posts are
// classified inside the main analysis prompt). NVIDIA failures degrade to neutral.
export async function classifyTexts(items, batchSize = 40) {
  const out = {};
  const valid = items.filter(it => it && String(it.text || '').trim());
  // Split into batches and classify them in PARALLEL (each NVIDIA call is independent),
  // so total time is ~one call instead of the sum of all batches.
  const batches = [];
  for (let i = 0; i < valid.length; i += batchSize) batches.push(valid.slice(i, i + batchSize));
  const classifyBatch = async batch => {
    const prompt =
      'Classify each item by sentiment and intent. Return ONLY raw JSON: ' +
      '{"results":[{"id":<int>,"sentiment":"positive|negative|neutral","intent":"Appreciation|Product Inquiry|General Discussion|Complaint|Feedback|Suggestion|Brand Promo|Support Request"}]}.\n' +
      'One result per input id. Items: ' +
      JSON.stringify(batch.map(b => ({ id: b.id, text: String(b.text).slice(0, 200) })));
    const resp = await callNvidia(prompt);
    const raw = resp?.choices?.[0]?.message?.content ?? resp?.content ?? '';
    const parsed = salvageJSON(raw) || {};
    return Array.isArray(parsed.results) ? parsed.results : [];
  };
  const settled = await Promise.allSettled(batches.map(classifyBatch));
  settled.forEach(s => {
    if (s.status !== 'fulfilled') return;
    s.value.forEach(r => {
      if (r && r.id != null) out[r.id] = { sentiment: r.sentiment || 'neutral', intent: r.intent || 'General Discussion' };
    });
  });
  // Fill any gaps with neutral so every item has a verdict.
  valid.forEach(it => { if (!out[it.id]) out[it.id] = { sentiment: 'neutral', intent: 'General Discussion' }; });
  return out;
}

// Full analysis for one brand.
export async function analyzeBrand(brandName, normalizedPosts, runId) {
  const { promptText } = buildPrompt(normalizedPosts, brandName);
  const aiResponse = await callNvidia(promptText);
  const raw = aiResponse?.choices?.[0]?.message?.content ?? aiResponse?.content ?? '';
  return buildDashboard(raw, brandName, normalizedPosts, runId);
}
