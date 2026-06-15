// Scrape Creators calls — replaces the per-platform HTTP + Tag nodes from n8n.
// Each function returns an array of "tagged" post objects (with _source/_brand/etc.),
// exactly the shape the normaliser expects.
import { SCRAPECREATORS_API_KEY, SCRAPE_ENDPOINTS } from '../config.js';

async function scrapeCreators(platform, handle) {
  if (!handle) return null;
  const { url, query } = SCRAPE_ENDPOINTS[platform](handle);
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${url}?${qs}`, {
    headers: { 'x-api-key': SCRAPECREATORS_API_KEY },
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) {
    // Mirror n8n "continueRegularOutput": don't throw, return null so the brand still finishes.
    const body = await res.text().catch(() => '');
    console.warn(`[scrape] ${platform} ${handle} → HTTP ${res.status} ${body.slice(0, 200)}`);
    return null;
  }
  return res.json().catch(() => null);
}

// ── LinkedIn ──
export async function linkedin(brand, handle) {
  const data = await scrapeCreators('linkedin', handle);
  const posts = Array.isArray(data?.posts) ? data.posts : [];
  if (!posts.length) return [{ _source: 'linkedin', _brand: brand, _handle: handle, _empty: true }];
  return posts.map(p => ({ ...p, _source: 'linkedin', _brand: brand, _handle: handle }));
}

// ── Instagram ──
export async function instagram(brand, handle) {
  const data = await scrapeCreators('instagram', handle);
  let posts = [];
  if (Array.isArray(data?.posts)) posts = data.posts;
  else if (data?.data?.user?.edge_owner_to_timeline_media?.edges) posts = data.data.user.edge_owner_to_timeline_media.edges.map(e => e.node);
  else if (Array.isArray(data?.data)) posts = data.data;
  else if (Array.isArray(data?.items)) posts = data.items;
  if (!posts.length) return [{ _source: 'instagram', _brand: brand, _handle: handle, _empty: true }];
  return posts.map(p => {
    let captionText = '';
    if (typeof p.caption === 'string') captionText = p.caption;
    else if (p.caption && typeof p.caption === 'object') captionText = p.caption.text || '';
    else if (p.edge_media_to_caption?.edges?.[0]?.node?.text) captionText = p.edge_media_to_caption.edges[0].node.text;
    const likes = p.like_count ?? p.likes ?? p.likeCount ?? p.edge_liked_by?.count ?? 0;
    const comments = p.comment_count ?? p.comments ?? p.commentCount ?? p.edge_media_to_comment?.count ?? 0;
    let timestamp = '';
    if (p.taken_at) timestamp = new Date(p.taken_at * 1000).toISOString();
    else if (p.taken_at_timestamp) timestamp = new Date(p.taken_at_timestamp * 1000).toISOString();
    else if (p.timestamp) timestamp = p.timestamp;
    const thumb = p.display_url || p.thumbnail_url || p.image_versions2?.candidates?.[0]?.url || p.image_versions?.items?.[0]?.url || '';
    return { ...p, _caption: captionText, _likes: likes, _comments: comments, _timestamp: timestamp, _thumb: thumb, _source: 'instagram', _brand: brand, _handle: handle };
  });
}

// ── YouTube ──
export async function youtube(brand, handle) {
  const data = await scrapeCreators('youtube', handle);
  let posts = [];
  if (Array.isArray(data?.videos)) posts = data.videos;
  else if (Array.isArray(data?.data)) posts = data.data;
  else if (Array.isArray(data?.items)) posts = data.items;
  else if (data && typeof data === 'object') posts = [data];
  if (!posts.length) return [{ _source: 'youtube', _brand: brand, _handle: handle, _empty: true }];
  return posts.map(p => {
    const thumb = p.thumbnail || p.thumbnails?.high?.url || p.thumbnails?.[0]?.url || '';
    const views = p.viewCount ?? p.views ?? p.view_count ?? p.statistics?.viewCount ?? 0;
    const likes = p.likeCount ?? p.likes ?? p.statistics?.likeCount ?? 0;
    const comments = p.commentCount ?? p.comments ?? p.statistics?.commentCount ?? 0;
    const timestamp = p.publishedAt || p.publishTime || p.uploadDate || '';
    return { ...p, _likes: likes, _comments: comments, _views: views, _thumb: thumb, _timestamp: timestamp, _source: 'youtube', _brand: brand, _handle: handle };
  });
}

// ── Facebook ──
export async function facebook(brand, handle) {
  const data = await scrapeCreators('facebook', handle);
  let posts = [];
  if (Array.isArray(data?.posts)) posts = data.posts;
  else if (Array.isArray(data?.data)) posts = data.data;
  else if (Array.isArray(data?.items)) posts = data.items;
  if (!posts.length) return [{ _source: 'facebook', _brand: brand, _handle: handle, _empty: true }];
  return posts.map(p => ({
    ...p,
    _likes: p.reactionCount ?? p.like_count ?? 0,
    _comments: p.commentCount ?? p.comment_count ?? 0,
    _shares: p.shareCount ?? p.share_count ?? 0,
    _views: p.videoViewCount ?? p.view_count ?? 0,
    _thumb: p.imageUrl || p.thumbnailUrl || p.image || '',
    _timestamp: p.publishTime ? new Date(p.publishTime * 1000).toISOString() : (p.timestamp || ''),
    _source: 'facebook', _brand: brand, _handle: handle,
  }));
}

// ── Twitter / X ──
export async function twitter(brand, handle) {
  const data = await scrapeCreators('twitter', handle);
  let posts = [];
  if (Array.isArray(data?.tweets)) posts = data.tweets;
  else if (Array.isArray(data?.data)) posts = data.data;
  else if (Array.isArray(data?.items)) posts = data.items;
  if (!posts.length) return [{ _source: 'twitter', _brand: brand, _handle: handle, _empty: true }];
  return posts.map(p => ({
    ...p,
    _likes: p.favorite_count ?? 0,
    _comments: p.reply_count ?? 0,
    _shares: p.retweet_count ?? 0,
    _views: Number(p.view_count ?? 0),
    _timestamp: p.created_at ? new Date(p.created_at).toISOString() : '',
    _url: p.id ? `https://twitter.com/i/web/status/${p.id}` : (p.url || ''),
    _text: p.full_text || p.text || '',
    _thumb: p.media?.[0]?.media_url_https || p.entities?.media?.[0]?.media_url_https || '',
    _source: 'twitter', _brand: brand, _handle: handle,
  }));
}

// Scrape all five platforms for one brand row, in parallel.
export async function scrapeAllPlatforms(brandRow) {
  const brand = brandRow['Brand Name'];
  const tasks = [
    linkedin(brand, brandRow.LinkedIn_Handle),
    instagram(brand, brandRow.Instagram_Handle),
    youtube(brand, brandRow.YouTube_Handle),
    facebook(brand, brandRow.Facebook_Handle),
    twitter(brand, brandRow.Twitter_Handle),
  ];
  const results = await Promise.allSettled(tasks);
  return results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
}
