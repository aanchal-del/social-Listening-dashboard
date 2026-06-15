// News / PR monitoring via Google News RSS (free, no API key).
// Returns recent news articles mentioning a brand/keyword.
export async function fetchNews(query, limit = 25) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  let xml = '';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    xml = await res.text();
  } catch { return []; }

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit);
  const pick = (s, tag) => {
    const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
  };
  return items.map(([, s]) => {
    let title = pick(s, 'title');
    const source = pick(s, 'source');
    // Google News titles are usually "Headline - Source" — strip the trailing source.
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    const snippet = pick(s, 'description').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().slice(0, 200);
    return { title, link: pick(s, 'link'), source, date: pick(s, 'pubDate'), snippet };
  }).filter(a => a.title && a.link);
}
