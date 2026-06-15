// Brand-mention monitoring — the Locobuzz-style "what are OTHERS saying about the brand"
// pipeline. Searches public posts across the platforms Scrape Creators lets us
// keyword-search (YouTube, Threads, TikTok), plus comments on our own posts.
// Each result is normalised into a uniform "mention" record the dashboard renders.
import { SCRAPECREATORS_API_KEY } from '../config.js';
import { fmtK } from './normalize.js';

const H = { 'x-api-key': SCRAPECREATORS_API_KEY };
const REACH_FACTOR = { youtube: 1.2, tiktok: 1.0, threads: 80, instagram: 90 };
const IMPR_FACTOR = 1.5;

async function scGet(url) {
  try {
    const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(120000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[mentions] ${url.split('?')[0]} → HTTP ${res.status} ${body.slice(0, 120)}`);
      return null;
    }
    return res.json().catch(() => null);
  } catch (e) {
    console.warn(`[mentions] ${url.split('?')[0]} failed: ${e.name}: ${e.message}`);
    return null;
  }
}

// Shared shape so the frontend can render mentions exactly like post cards.
function makeMention({ brand, platform, type = 'mention', author_name, author_handle,
  author_avatar = '', verified = false, followers = 0, text = '', url = '', thumb = '',
  likes = 0, comments = 0, shares = 0, views = 0, timestamp = '', display_date = '' }) {
  likes = Number(likes) || 0; comments = Number(comments) || 0;
  shares = Number(shares) || 0; views = Number(views) || 0;
  const engagement = likes + comments + shares;
  const rf = REACH_FACTOR[platform] || 80;
  const reach = platform === 'youtube' || platform === 'tiktok'
    ? Math.round(views * rf) : Math.round(engagement * rf + likes * 5);
  const impressions = Math.round(reach * IMPR_FACTOR);
  const denom = reach > 0 ? reach : (engagement > 0 ? engagement * 50 : 1);
  const engRate = Math.min(100, Number(((engagement / denom) * 100).toFixed(1)));
  if (!display_date && timestamp) {
    const dt = new Date(timestamp);
    if (!isNaN(dt)) display_date = dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return {
    brand, plateform: platform, type,
    author_name: String(author_name || author_handle || '').slice(0, 120),
    author_handle: String(author_handle || '').replace(/^@/, '').slice(0, 120),
    author_avatar: String(author_avatar || '').slice(0, 500),
    verified: !!verified,
    followers: Number(followers) || 0,
    post_text: String(text || '').slice(0, 800),
    post_url: String(url || '').slice(0, 500),
    thumb: String(thumb || '').slice(0, 500),
    likes, comments, shares, views,
    engagement, eng_rate: engRate,
    est_reach: fmtK(reach), est_impressions: fmtK(impressions),
    display_date, timestamps: String(timestamp || ''),
  };
}

// Unix seconds (or ms) → ISO, tolerant of strings.
function tsToISO(v) {
  if (!v) return '';
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const n = Number(v);
  if (!Number.isNaN(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  const d = new Date(v);
  return isNaN(d) ? '' : d.toISOString();
}

// ── YouTube keyword search (videos + shorts) ──
async function searchYouTube(brand, keyword) {
  const data = await scGet(`https://api.scrapecreators.com/v1/youtube/search?query=${encodeURIComponent(keyword)}`);
  if (!data) return [];
  const items = [...(data.videos || []), ...(data.shorts || [])];
  return items.filter(v => v && v.url).map(v => {
    const ch = v.channel || v.author || v.owner || {};
    const name = ch.title || ch.name || ch.handle || v.channelTitle || v.authorText ||
      (typeof v.author === 'string' ? v.author : '') || '';
    const handle = ch.handle || ch.canonicalBaseUrl || v.channelHandle || '';
    return makeMention({
      brand, platform: 'youtube',
      author_name: name, author_handle: handle,
      author_avatar: ch.thumbnail || ch.avatar || '',
      text: v.title, url: v.url, thumb: v.thumbnail,
      views: v.viewCountInt ?? v.viewCount ?? 0,
      display_date: v.publishedTimeText || '',
      timestamp: v.publishedTime || '',
    });
  });
}

// ── Threads keyword search ──
async function searchThreads(brand, keyword) {
  const data = await scGet(`https://api.scrapecreators.com/v1/threads/search?query=${encodeURIComponent(keyword)}`);
  if (!data) return [];
  const posts = data.posts || data.data || [];
  return posts.filter(Boolean).map(p => {
    const u = p.user || {};
    const text = p.caption?.text || p.text || p.body || '';
    const code = p.code || p.shortcode;
    const url = code ? `https://www.threads.net/@${u.username}/post/${code}` : (p.url || '');
    return makeMention({
      brand, platform: 'threads',
      author_name: u.full_name, author_handle: u.username, author_avatar: u.profile_pic_url,
      verified: u.is_verified, followers: u.follower_count,
      text, url,
      likes: p.like_count ?? p.likeCount ?? 0,
      comments: p.reply_count ?? p.direct_reply_count ?? 0,
      shares: p.reshare_count ?? p.repost_count ?? 0,
      timestamp: tsToISO(p.taken_at ?? p.taken_at_timestamp ?? p.timestamp),
    });
  });
}

// ── TikTok keyword search ──
async function searchTikTok(brand, keyword) {
  const data = await scGet(`https://api.scrapecreators.com/v1/tiktok/search/keyword?query=${encodeURIComponent(keyword)}`);
  if (!data) return [];
  const list = data.search_item_list || data.item_list || [];
  return list.map(it => {
    const a = it.aweme_info || it;
    const au = a.author || {};
    const st = a.statistics || {};
    const avatar = au.avatar_thumb?.url_list?.[0] || au.avatar_medium?.url_list?.[0] || '';
    const cover = a.video?.cover?.url_list?.[0] || a.video?.origin_cover?.url_list?.[0] || '';
    const id = a.aweme_id || a.id;
    const uid = au.unique_id || au.uid;
    const url = a.share_url || (id && uid ? `https://www.tiktok.com/@${uid}/video/${id}` : '');
    return makeMention({
      brand, platform: 'tiktok',
      author_name: au.nickname, author_handle: au.unique_id, author_avatar: avatar,
      verified: au.verification_type > 0 || au.custom_verify,
      followers: au.follower_count,
      text: a.desc || '', url, thumb: cover,
      likes: st.digg_count, comments: st.comment_count, shares: st.share_count, views: st.play_count,
      timestamp: tsToISO(a.create_time),
    });
  }).filter(m => m.post_url);
}

// ── Comments on the brand's own posts (commenter name + text) ──
// Paginated: follow the cursor until we hit `perPost` or run out of pages.
async function paginateComments(baseUrl, mapFn, perPost, maxPages = 3) {
  const out = [];
  let cursor = '', pages = 0;
  do {
    const url = baseUrl + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const data = await scGet(url);
    const list = data?.comments || data?.data || [];
    for (const c of list) out.push(mapFn(c));
    cursor = data?.cursor || data?.next_cursor || (data?.has_next_page ? data?.cursor : '') || '';
    pages++;
  } while (cursor && out.length < perPost && pages < maxPages);
  return out.slice(0, perPost);
}
function igComments(brand, post, perPost) {
  return paginateComments(
    `https://api.scrapecreators.com/v2/instagram/post/comments?url=${encodeURIComponent(post.post_url)}`,
    c => makeMention({
      brand, platform: 'instagram', type: 'comment',
      author_name: c.user?.full_name || c.user?.username, author_handle: c.user?.username,
      author_avatar: c.user?.profile_pic_url, verified: c.user?.is_verified,
      text: c.text, url: post.post_url, thumb: post.thumb,
      likes: c.comment_like_count ?? c.like_count ?? 0, timestamp: tsToISO(c.created_at),
    }), perPost);
}
function ytComments(brand, post, perPost) {
  return paginateComments(
    `https://api.scrapecreators.com/v1/youtube/video/comments?url=${encodeURIComponent(post.post_url)}`,
    c => makeMention({
      brand, platform: 'youtube', type: 'comment',
      author_name: c.author || c.authorText || c.author_name, author_handle: c.authorHandle || c.author,
      author_avatar: c.authorThumbnail || c.author_thumbnail || '',
      text: c.text || c.commentText || c.content, url: post.post_url, thumb: post.thumb,
      likes: c.likeCount ?? c.likes ?? 0, timestamp: c.publishedTime || c.published_time || '',
    }), perPost);
}
function fbComments(brand, post, perPost) {
  return paginateComments(
    `https://api.scrapecreators.com/v1/facebook/post/comments?url=${encodeURIComponent(post.post_url)}`,
    c => makeMention({
      brand, platform: 'facebook', type: 'comment',
      author_name: c.author?.name, author_handle: c.author?.name,
      author_avatar: c.author?.profile_picture || '',
      text: c.text, url: post.post_url, thumb: post.thumb,
      likes: c.reaction_count ?? 0, comments: c.reply_count ?? 0, timestamp: c.created_at || '',
    }), perPost);
}

// Fetch comments for the posts that have any, newest/most-commented first.
const COMMENT_FETCHERS = { instagram: igComments, youtube: ytComments, facebook: fbComments };
export async function collectComments(brand, posts, perPost = 100, maxPosts = 20) {
  const candidates = (posts || [])
    .filter(p => p.post_url && Number(p.comments) > 0 && COMMENT_FETCHERS[p.plateform])
    .sort((a, b) => Number(b.comments) - Number(a.comments))
    .slice(0, maxPosts);
  const tasks = candidates.map(p => COMMENT_FETCHERS[p.plateform](brand, p, perPost));
  const results = await Promise.allSettled(tasks);
  return results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
}

// True when a mention is actually the brand's OWN channel/account (so we exclude it —
// the user wants third-party people, not the brand posting about itself).
// Strip accents/diacritics so "Häfele" matches the brand "Hafele".
const deburr = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function isOwnAccount(m, ownHandles, brand) {
  const h = deburr(m.author_handle).replace(/^@/, '');
  if (h && ownHandles.has(h)) return true;
  const name = deburr(m.author_name);
  const words = deburr(brand).split(/\s+/).filter(Boolean);
  // e.g. "Ebco Solutions", "Hettich India", "Häfele Australia" → brand-owned channel.
  if (words.length && words.every(w => name.includes(w))) return true;
  return false;
}

// Collect THIRD-PARTY mentions for a brand (YouTube + Threads — TikTok intentionally
// excluded; not used in India). The brand's own channels are filtered out.
export async function collectMentions(brand, keywords, cap = 120, ownHandlesArr = []) {
  const kws = (keywords && keywords.length ? keywords : [brand]).filter(Boolean);
  const ownHandles = new Set(ownHandlesArr.map(x => String(x || '').toLowerCase().replace(/^@/, '')).filter(Boolean));
  const tasks = [];
  for (const kw of kws) {
    tasks.push(searchYouTube(brand, kw), searchThreads(brand, kw));
  }
  const results = await Promise.allSettled(tasks);
  const all = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  const seen = new Set();
  const deduped = [];
  for (const m of all) {
    // Must have a name, and must NOT be the brand's own account.
    if (!m.author_name && !m.author_handle) continue;
    if (isOwnAccount(m, ownHandles, brand)) continue;
    const key = m.post_url || (m.plateform + m.post_text.slice(0, 40));
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }
  return deduped.slice(0, cap);
}
