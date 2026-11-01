/**
 * Official agency bulletins published as RSS or Atom: Cal OES news
 * (statewide, matched to a region by the places it names), Sonoma County's
 * emergency site and the Los Angeles Fire Department's alerts page. Each
 * feed lists the addresses it is known to publish; when none answers, the
 * agency's own page is read for an advertised feed on the same origin, so
 * a site that moves its feed keeps working without a code change.
 */
import { clampText, createAlert } from '../../../src/layers/alerts/model.js';
import {
  regionsForPoint,
  regionsForState,
  regionsForText,
} from '../../../src/layers/alerts/regions.js';
import { ALERT_FEEDS } from './feeds.js';
import { UpstreamError, fetchUpstreamText } from './http.js';
import { discoverFeedLinks, parseFeedItems } from './rss.js';

const MAX_BYTES = 3 * 1024 * 1024;
const DAY = 24 * 60 * 60_000;

export const AGENCY_FEEDS = Object.freeze([
  Object.freeze({
    ...ALERT_FEEDS.caloes,
    agency: "California Governor's Office of Emergency Services",
    page: 'https://news.caloes.ca.gov/',
    candidates: Object.freeze(['https://news.caloes.ca.gov/feed/']),
    kind: 'advisory',
    scope: Object.freeze({ state: 'CA' }),
    maxAgeMs: 3 * DAY,
  }),
  Object.freeze({
    ...ALERT_FEEDS.socoemergency,
    agency: 'Sonoma County Department of Emergency Management',
    page: 'https://socoemergency.org/',
    candidates: Object.freeze(['https://socoemergency.org/feed/']),
    kind: 'emergency',
    scope: Object.freeze({
      regions: ['sonoma-county', 'san-francisco-bay-area'],
    }),
    maxAgeMs: 3 * DAY,
  }),
  Object.freeze({
    ...ALERT_FEEDS.lafd,
    agency: 'Los Angeles Fire Department',
    page: 'https://www.lafd.org/alerts',
    candidates: Object.freeze([
      'https://www.lafd.org/alerts/rss.xml',
      'https://www.lafd.org/alerts/feed',
      'https://www.lafd.org/rss.xml',
    ]),
    kind: 'emergency',
    scope: Object.freeze({ regions: ['los-angeles'] }),
    maxAgeMs: DAY,
  }),
]);

/** Severity read from a bulletin's wording; bulletins carry no severity field. */
export function bulletinSeverity(text) {
  const words = String(text || '');
  if (/evacuation (order|warning)|mandatory evacuation|shelter[- ]in[- ]place|red flag warning|state of emergency|tsunami|flash flood warning/i.test(words))
    return 'severe';
  if (/evacuat|warning|order|closure|outage|boil water|hazard/i.test(words))
    return 'moderate';
  return 'minor';
}

/** Regions a bulletin concerns: its agency's, or the places a statewide one names. */
export function bulletinRegions(feed, text) {
  if (feed.scope.regions) return [...feed.scope.regions];
  const named = regionsForText(text);
  return named.length ? named : regionsForState(feed.scope.state);
}

/** Normalize one feed item to an alert, or null when it is old. */
export function normalizeBulletin(feed, item, { now = Date.now(), fetchedAt = now } = {}) {
  const publishedMs = Date.parse(item.publishedAt || item.updatedAt || '');
  if (!Number.isFinite(publishedMs)) return null;
  if (now - publishedMs > feed.maxAgeMs) return null;
  const text = `${item.title} ${item.summary}`;
  const named = feed.scope.state ? regionsForText(text) : [];
  const regions = bulletinRegions(feed, text);
  if (!regions.length) return null;
  const area =
    item.geo && regionsForPoint(item.geo.lon, item.geo.lat).length
      ? { type: 'Point', coordinates: [item.geo.lon, item.geo.lat] }
      : null;
  return createAlert(
    {
      id: `${feed.id}:${item.id}`,
      source: feed.id,
      kind: feed.kind,
      severity: bulletinSeverity(text),
      agency: feed.agency,
      headline: item.title,
      body: clampText(item.summary, 600),
      area,
      areaSource: area ? 'feed' : null,
      areaDescription:
        feed.scope.state && !named.length ? 'Statewide bulletin' : null,
      regions,
      starts: item.publishedAt,
      ends: null,
      issued: item.publishedAt,
      updated: item.updatedAt || item.publishedAt,
      url: item.url,
    },
    { fetchedAt },
  );
}

const looksLikeFeed = (text) => /<(rss|feed|rdf:RDF)\b/i.test(text);

/**
 * One loadable source per agency feed. The address that last answered is
 * tried first; the published candidates next; then the agency page is read
 * for an advertised same-origin feed.
 */
export function createAgencyFeedSources({
  fetchImpl,
  now = () => Date.now(),
  feeds = AGENCY_FEEDS,
} = {}) {
  return feeds.map((feed) => {
    let working = null;
    const read = (url) =>
      fetchUpstreamText(url, {
        fetchImpl,
        headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' },
        timeoutMs: 15_000,
        maxBytes: MAX_BYTES,
        redirect: 'follow',
      });
    async function loadFrom(url) {
      const { payload } = await read(url);
      if (!looksLikeFeed(payload)) throw new UpstreamError('not_a_feed', { url });
      return payload;
    }
    return {
      ...feed,
      keyRequired: false,
      async load() {
        const tried = new Set();
        const attempts = [working, ...feed.candidates].filter(Boolean);
        let xml = null;
        let lastError = null;
        for (const url of attempts) {
          if (tried.has(url)) continue;
          tried.add(url);
          try {
            xml = await loadFrom(url);
            working = url;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (xml === null) {
          try {
            const { payload } = await read(feed.page);
            for (const url of discoverFeedLinks(payload, feed.page)) {
              if (tried.has(url)) continue;
              tried.add(url);
              try {
                xml = await loadFrom(url);
                working = url;
                break;
              } catch (error) {
                lastError = error;
              }
            }
          } catch (error) {
            lastError = error;
          }
        }
        if (xml === null)
          throw lastError || new UpstreamError(`${feed.id}_unavailable`);
        const fetchedAt = now();
        const alerts = [];
        for (const item of parseFeedItems(xml)) {
          const alert = normalizeBulletin(feed, item, { now: fetchedAt, fetchedAt });
          if (alert) alerts.push(alert);
        }
        return { alerts, fetchedAt, feedUrl: working };
      },
    };
  });
}
