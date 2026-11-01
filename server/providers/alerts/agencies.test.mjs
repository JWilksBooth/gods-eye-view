import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENCY_FEEDS,
  bulletinRegions,
  bulletinSeverity,
  createAgencyFeedSources,
  normalizeBulletin,
} from './agencies.js';
import { decodeXmlText, discoverFeedLinks, parseFeedItems } from './rss.js';
import { parseLongLocalDate, zonedTimeToMs } from './time.js';

const NOW = Date.parse('2026-11-01T17:00:00Z');
const [CALOES, SOCO, LAFD] = AGENCY_FEEDS;

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture news</title>
<item><title>Statewide preparedness update</title><link>https://news.example.gov/a</link>
  <guid>a</guid><pubDate>Sun, 01 Nov 2026 15:00:00 +0000</pubDate>
  <description><![CDATA[<p>Residents are reminded to <b>prepare</b> &amp; plan.</p>]]></description></item>
<item><title>Evacuation order lifted near Los Angeles</title><link>https://news.example.gov/b</link>
  <guid>b</guid><pubDate>Sat, 31 Oct 2026 20:00:00 +0000</pubDate>
  <description>Evacuation order for the Los Angeles foothills is now a warning.</description>
  <category>Fire</category><georss:point>34.1 -118.3</georss:point></item>
<item><title>Old news</title><link>https://news.example.gov/c</link><guid>c</guid>
  <pubDate>Sun, 18 Oct 2026 20:00:00 +0000</pubDate></item>
<item><title>No link</title><link>javascript:alert(1)</link><guid>d</guid></item>
<item><title>Duplicate</title><link>https://news.example.gov/a</link><guid>a</guid></item>
<item><title>Las Vegas mention</title><link>https://news.example.gov/e</link>
  <guid>e</guid><pubDate>Sun, 01 Nov 2026 14:00:00 +0000</pubDate>
  <description>Mutual aid crews returned from Las Vegas.</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Atom entry</title><link rel="alternate" href="https://atom.example.gov/1"/>
  <id>tag:atom.example.gov,2026:1</id><updated>2026-11-01T12:00:00Z</updated>
  <summary>Shelter in place lifted.</summary><category term="Safety"/></entry>
</feed>`;

// A CMS-generated alerts feed: anchors with relative addresses inside title,
// link and guid, escaped markup in descriptions and long-form local dates.
const CMS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xml:base="https://lafd.org/"><channel><title>Alerts Feed</title>
<item>
  <title><a href="/alert/structure-fire-11012026-inc0001" hreflang="en">Structure Fire 11/01/2026 INC#0001</a></title>
  <link><a href="/alert/structure-fire-11012026-inc0001" hreflang="en">view</a></link>
  <description>Structure Fire; INC#0001; MAP: &amp;lt;a href="https://maps.example/x"&amp;gt;https://maps.example/x&amp;lt;/a&amp;gt;; crews contained the fire.</description>
  <category>Structure Fire</category>
  <guid isPermaLink="false"><a href="/alert/structure-fire-11012026-inc0001" hreflang="en">view</a></guid>
  <pubDate>Sunday, November 1, 2026 - 08:57
</pubDate>
</item>
<item>
  <title><a href="/alert/rescue-10302026-inc0002" hreflang="en">Rescue 10/30/2026 INC#0002</a></title>
  <link><a href="/alert/rescue-10302026-inc0002" hreflang="en">view</a></link>
  <guid isPermaLink="false"><a href="/alert/rescue-10302026-inc0002" hreflang="en">view</a></guid>
  <pubDate>Friday, October 30, 2026 - 21:57</pubDate>
</item>
</channel></rss>`;

test('local long-form dates read in the feed zone across the DST change', () => {
  const zone = 'America/Los_Angeles';
  assert.equal(
    new Date(
      parseLongLocalDate('Saturday, October 31, 2026 - 21:57', zone),
    ).toISOString(),
    '2026-11-01T04:57:00.000Z',
  );
  assert.equal(
    new Date(
      parseLongLocalDate('Sunday, November 1, 2026 - 08:57', zone),
    ).toISOString(),
    '2026-11-01T16:57:00.000Z',
  );
  assert.equal(
    new Date(
      parseLongLocalDate('October 30, 2026 9:57 PM', zone),
    ).toISOString(),
    '2026-10-31T04:57:00.000Z',
  );
  assert.equal(parseLongLocalDate('not a date', zone), null);
  assert.equal(
    new Date(
      zonedTimeToMs({ year: 2026, month: 7, day: 4, hour: 12 }, zone),
    ).toISOString(),
    '2026-07-04T19:00:00.000Z',
  );
});

test('RSS and Atom items parse with their links checked and duplicates dropped', () => {
  const items = parseFeedItems(RSS);
  assert.deepEqual(
    items.map((item) => item.id),
    ['a', 'b', 'c', 'e'],
  );
  assert.equal(items[0].summary, 'Residents are reminded to prepare & plan.');
  assert.deepEqual(items[1].geo, { lat: 34.1, lon: -118.3 });
  assert.deepEqual(items[1].categories, ['Fire']);
  const [entry] = parseFeedItems(ATOM);
  assert.equal(entry.url, 'https://atom.example.gov/1');
  assert.equal(entry.publishedAt, '2026-11-01T12:00:00.000Z');
  assert.deepEqual(entry.categories, ['Safety']);
});

test('CMS feeds resolve anchors against xml:base and read local dates', () => {
  const items = parseFeedItems(CMS, {
    baseUrl: 'https://lafd.org/alerts-rss.xml',
    timeZone: 'America/Los_Angeles',
  });
  assert.equal(items.length, 2);
  const [fire] = items;
  assert.equal(fire.title, 'Structure Fire 11/01/2026 INC#0001');
  assert.equal(
    fire.url,
    'https://lafd.org/alert/structure-fire-11012026-inc0001',
  );
  assert.equal(fire.id, fire.url, 'an anchor GUID is read as its address');
  assert.equal(fire.publishedAt, '2026-11-01T16:57:00.000Z');
  assert.doesNotMatch(fire.summary, /<a|&lt;/);
  assert.match(fire.summary, /crews contained the fire\.$/);
  assert.equal(
    decodeXmlText('&amp;lt;b&amp;gt;bold&amp;lt;/b&amp;gt;'),
    'bold',
  );
});

test('discovery keeps same-origin https feeds and skips comment feeds', () => {
  const html = `<link rel="alternate" type="application/rss+xml" title="Site Feed" href="/feed/">
<link rel="alternate" type="application/rss+xml" title="Site Comments Feed" href="/comments/feed/">
<link rel="alternate" type="application/atom+xml" href="https://other.example/feed">
<link rel="stylesheet" href="/style.css">`;
  assert.deepEqual(
    discoverFeedLinks(html, 'https://agency.example.gov/news/'),
    ['https://agency.example.gov/feed/'],
  );
  assert.deepEqual(discoverFeedLinks(html, 'not a url'), []);
});

test('bulletins take their regions from the agency or the places they name', () => {
  assert.deepEqual(bulletinRegions(SOCO, 'anything'), ['sonoma-county']);
  assert.deepEqual(
    bulletinRegions(CALOES, 'Fire weather in Los Angeles County'),
    ['los-angeles'],
  );
  assert.deepEqual(
    bulletinRegions(CALOES, 'Crews returned from Las Vegas'),
    ['los-angeles', 'sonoma-county', 'sf-bay-area'],
    'a statewide feed never names a region in another state',
  );
  assert.equal(bulletinSeverity('Mandatory evacuation order issued'), 'severe');
  assert.equal(
    bulletinSeverity('Road closure on the coast highway'),
    'moderate',
  );
  assert.equal(bulletinSeverity('Community meeting'), 'minor');
});

test('old bulletins drop and statewide ones say so', () => {
  const items = parseFeedItems(RSS);
  const alerts = items
    .map((item) => normalizeBulletin(CALOES, item, { now: NOW }))
    .filter(Boolean);
  assert.deepEqual(
    alerts.map((alert) => alert.id),
    ['caloes:a', 'caloes:b', 'caloes:e'],
  );
  const [statewide, named] = alerts;
  assert.equal(statewide.areaDescription, 'Statewide bulletin');
  assert.equal(statewide.kind, 'advisory');
  assert.equal(statewide.area, null);
  assert.deepEqual(named.regions, ['los-angeles']);
  assert.equal(named.severity, 'severe');
  assert.deepEqual(named.area, { type: 'Point', coordinates: [-118.3, 34.1] });
});

test('an agency feed follows its own redirects and falls back to discovery', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    asked.push(href);
    if (href === 'https://lafd.org/alerts-rss.xml')
      return new Response(null, {
        status: 301,
        headers: { location: 'https://www.lafd.org/alerts-rss.xml' },
      });
    if (href === 'https://www.lafd.org/alerts-rss.xml')
      return new Response(CMS, {
        headers: { 'content-type': 'application/rss+xml' },
      });
    if (href === 'https://socoemergency.org/feed/')
      return new Response('<html>moved</html>', { status: 200 });
    if (href === 'https://socoemergency.org/')
      return new Response(
        '<link rel="alternate" type="application/rss+xml" href="/emergency/feed/">',
      );
    if (href === 'https://socoemergency.org/emergency/feed/')
      return new Response(RSS);
    return new Response('nope', { status: 404 });
  };
  const sources = createAgencyFeedSources({ fetchImpl, now: () => NOW });
  const byId = Object.fromEntries(sources.map((source) => [source.id, source]));
  const lafd = await byId.lafd.load();
  assert.equal(lafd.alerts.length, 1, 'only the alert from the last day');
  const [alert] = lafd.alerts;
  assert.equal(alert.agency, 'Los Angeles Fire Department');
  assert.deepEqual(alert.regions, ['los-angeles']);
  assert.equal(alert.kind, 'emergency');
  assert.equal(
    alert.url,
    'https://lafd.org/alert/structure-fire-11012026-inc0001',
  );
  const soco = await byId.socoemergency.load();
  assert.deepEqual(
    soco.alerts.map((entry) => entry.regions.join()),
    ['sonoma-county', 'sonoma-county', 'sonoma-county'],
  );
  assert.ok(asked.includes('https://socoemergency.org/emergency/feed/'));
  const failing = createAgencyFeedSources({
    fetchImpl: async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://elsewhere.example/feed' },
      }),
    feeds: [CALOES],
  });
  await assert.rejects(
    failing[0].load(),
    (error) => error.code === 'redirect_refused',
  );
  assert.equal(LAFD.timeZone, 'America/Los_Angeles');
});
