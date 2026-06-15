// Mirror of the n8n "Normalise Fields" node: turn raw tagged posts into a
// uniform shape with derived reach/impressions/engagement-rate estimates.

const REACH_FACTOR = { instagram: 90, linkedin: 60, facebook: 70, youtube: 1.2, twitter: 110 };
const IMPR_FACTOR = 1.5;

export function fmtK(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

const today = () => new Date().toISOString().split('T')[0];

export function normalizePosts(items) {
  const normalized = [];
  for (const p of items) {
    if (!p || p._empty) continue;
    const source = p._source || 'unknown';
    const brand = p._brand || '';
    const handle = p._handle || '';

    let post_url = p._url || '';
    if (!post_url) {
      if (p.shortcode) post_url = `https://www.instagram.com/p/${p.shortcode}/`;
      else post_url = p.url || p.postUrl || p.link || p.permalinkUrl || p.videoUrl || String(p.id || '');
    }

    const post_text = p._text || p._caption || p.text ||
      (typeof p.caption === 'string' ? p.caption : '') ||
      p.edge_media_to_caption?.edges?.[0]?.node?.text ||
      p.description || p.title || p.content || p.full_text || '';

    const likes = Number(p._likes ?? p.likes ?? p.likesCount ?? p.likeCount ?? p.edge_liked_by?.count ?? p.numLikes ?? p.favoriteCount ?? p.favorite_count ?? 0) || 0;
    const comments = Number(p._comments ?? p.comments ?? p.commentsCount ?? p.commentCount ?? p.edge_media_to_comment?.count ?? p.numComments ?? p.replyCount ?? p.reply_count ?? 0) || 0;
    const shares = Number(p._shares ?? p.shares ?? p.sharesCount ?? p.shareCount ?? p.retweetCount ?? p.retweet_count ?? p.repostCount ?? 0) || 0;
    const views = Number(p._views ?? p.views ?? p.viewCount ?? p.viewsCount ?? p.video_view_count ?? p.playCount ?? p.videoViewCount ?? p.view_count ?? 0) || 0;
    const thumb = p._thumb || p.display_url || p.thumbnail || p.imageUrl || '';

    let timestamp = p._timestamp || '';
    if (!timestamp) timestamp = p.timestamp || p.datePublished || p.date || p.publishedAt || p.createdAt || p.time || p.created_at || '';
    if (!timestamp && p.taken_at) timestamp = new Date(p.taken_at * 1000).toISOString();
    else if (!timestamp && p.taken_at_timestamp) timestamp = new Date(p.taken_at_timestamp * 1000).toISOString();

    const engagement = likes + comments + shares;
    const rf = REACH_FACTOR[source] || 80;
    const reach = source === 'youtube'
      ? Math.round(views * rf)
      : Math.round(engagement * rf + likes * 5);
    const impressions = Math.round(reach * IMPR_FACTOR);
    const denom = reach > 0 ? reach : (engagement > 0 ? engagement * 50 : 1);
    const engRate = Math.min(100, Number(((engagement / denom) * 100).toFixed(1)));

    let displayDate = '';
    if (timestamp) {
      const dt = new Date(timestamp);
      if (!isNaN(dt)) displayDate = dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    normalized.push({
      brand,
      handle,
      plateform: source,
      post_url: String(post_url).substring(0, 500),
      post_text: String(post_text).substring(0, 800),
      likes, comments, shares, views,
      engagement,
      eng_rate: engRate,
      est_reach: fmtK(reach),
      est_impressions: fmtK(impressions),
      thumb: String(thumb).substring(0, 500),
      display_date: displayDate,
      timestamps: String(timestamp),
      run_date: today(),
    });
  }

  if (normalized.length === 0) {
    return [{ brand: 'no_data', handle: '', plateform: 'none', post_url: '', post_text: '', likes: 0, comments: 0, shares: 0, views: 0, engagement: 0, eng_rate: 0, est_reach: '0', est_impressions: '0', thumb: '', display_date: '', timestamps: '', run_date: today() }];
  }
  return normalized;
}
