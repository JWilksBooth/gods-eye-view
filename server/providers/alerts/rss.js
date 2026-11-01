/**
 * RSS 2.0 and Atom parsing with the same discipline as the regional news
 * feed (server/providers/regional/news.js): regular expressions over a
 * bounded text, entities decoded, markup stripped, every link checked to be
 * http(s), duplicates dropped. No XML parser, no entity expansion.
 */

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

/** Decode text from an RSS/Atom element: CDATA, entities, markup, whitespace. */
export function decodeXmlText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
      if (name[0] === '#') {
        const hex = name[1] === 'x' || name[1] === 'X';
        const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : ' ';
      }
      return NAMED_ENTITIES[name.toLowerCase()] ?? all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeTag = (tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The decoded text of the first `<tag>` in a block, or ''. */
export function xmlTag(block, tag) {
  const match = new RegExp(
    `<${escapeTag(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeTag(tag)}\\s*>`,
    'i',
  ).exec(block);
  return decodeXmlText(match?.[1] || '');
}

/** An attribute of the first `<tag …>` in a block, decoded, or ''. */
export function xmlAttr(block, tag, attr, { where = null } = {}) {
  for (const match of String(block || '').matchAll(
    new RegExp(`<${escapeTag(tag)}\\b([^>]*)>`, 'gi'),
  )) {
    const attributes = match[1];
    if (where && !where.test(attributes)) continue;
    const value = new RegExp(`\\b${escapeTag(attr)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(
      attributes,
    );
    if (value) return decodeXmlText(value[2] ?? value[3] ?? '');
  }
  return '';
}

function httpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function dateOrNull(value) {
  const ms = Date.parse(String(value || '').trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A `georss:point`, `geo:lat`/`geo:long` or `georss:where` position. */
function itemGeo(block) {
  const point = xmlTag(block, 'georss:point');
  if (point) {
    const [lat, lon] = point.split(/[\s,]+/).map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  const lat = Number(xmlTag(block, 'geo:lat'));
  const lon = Number(xmlTag(block, 'geo:long'));
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon))
    return { lat, lon };
  return null;
}

/**
 * The items of an RSS 2.0 `<item>` or Atom `<entry>` feed, newest as the
 * feed orders them: `{ id, title, url, summary, publishedAt, updatedAt,
 * categories, geo }`. Items without a title or an http(s) link are skipped;
 * duplicates (same id or link) are kept once.
 */
export function parseFeedItems(xml, { limit = 60 } = {}) {
  const text = String(xml || '');
  const blocks = [
    ...text.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi),
    ...text.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry\s*>/gi),
  ];
  const seen = new Set();
  const items = [];
  for (const match of blocks) {
    const block = match[1];
    const title = xmlTag(block, 'title').slice(0, 300);
    const url =
      httpUrl(xmlTag(block, 'link')) ||
      httpUrl(xmlAttr(block, 'link', 'href', { where: /rel\s*=\s*["']alternate["']/i })) ||
      httpUrl(xmlAttr(block, 'link', 'href')) ||
      null;
    if (!title || !url) continue;
    const guid = xmlTag(block, 'guid') || xmlTag(block, 'id');
    const id = guid || url;
    const signature = `${id}|${url}`;
    if (seen.has(signature) || seen.has(id) || seen.has(url)) continue;
    seen.add(signature);
    seen.add(id);
    seen.add(url);
    const summary =
      xmlTag(block, 'description') ||
      xmlTag(block, 'summary') ||
      xmlTag(block, 'content:encoded') ||
      xmlTag(block, 'content');
    const publishedAt =
      dateOrNull(xmlTag(block, 'pubDate')) ||
      dateOrNull(xmlTag(block, 'published')) ||
      dateOrNull(xmlTag(block, 'dc:date')) ||
      dateOrNull(xmlTag(block, 'updated'));
    const updatedAt =
      dateOrNull(xmlTag(block, 'updated')) ||
      dateOrNull(xmlTag(block, 'atom:updated')) ||
      publishedAt;
    const categories = [
      ...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category\s*>/gi),
    ]
      .map((entry) => decodeXmlText(entry[1]))
      .concat(
        [...block.matchAll(/<category\b([^>]*)\/?>/gi)]
          .map((entry) => /\bterm\s*=\s*["']([^"']*)["']/i.exec(entry[1])?.[1])
          .filter(Boolean)
          .map(decodeXmlText),
      )
      .filter(Boolean)
      .slice(0, 12);
    items.push({
      id,
      title,
      url,
      summary: summary.slice(0, 4000),
      publishedAt,
      updatedAt,
      categories,
      geo: itemGeo(block),
    });
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * Feed addresses an HTML page advertises with
 * `<link rel="alternate" type="application/rss+xml|atom+xml">`, resolved
 * against the page and kept only on the page's own origin, so discovery can
 * never send the proxy to a third-party host.
 */
export function discoverFeedLinks(html, pageUrl) {
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const found = [];
  for (const match of String(html || '').matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (!/\brel\s*=\s*["'][^"']*\balternate\b[^"']*["']/i.test(attributes))
      continue;
    if (!/\btype\s*=\s*["']application\/(?:rss|atom)\+xml["']/i.test(attributes))
      continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (!href) continue;
    try {
      const url = new URL(decodeXmlText(href), pageUrl);
      if (url.origin !== origin || url.protocol !== 'https:') continue;
      url.hash = '';
      if (!found.includes(url.href)) found.push(url.href);
    } catch {
      /* skip an unparsable href */
    }
  }
  return found;
}
