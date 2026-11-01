/**
 * Official agency bulletins published as RSS or Atom: Cal OES news
 * (statewide, matched to a region by the places it names), the County of
 * Sonoma's emergency site and the Los Angeles Fire Department's alerts.
 * Each feed lists the addresses it is known to publish; when none answers,
 * the agency's own page is read for an advertised feed on the same origin,
 * so a site that moves its feed keeps working without a code change.
 * Redirects are followed only between the hosts a feed lists.
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
    hosts: Object.freeze(['news.caloes.ca.gov', 'www.news.caloes.ca.gov']),
    kind: 'advisory',
    scope: Object.freeze({ state: 'CA' }),
    maxAgeMs: 3 * DAY,
    timeZone: null,
  }),
  Object.freeze({
    ...ALERT_FEEDS.socoemergency,
    agency: 'County of Sonoma Department of Emergency Management',
    page: 'https://socoemergency.org/',
    candidates: Object.freeze(['https://socoemergency.org/feed/']),
    hosts: Object.freeze(['socoemergency.org', 'www.socoemergency.org']),
    kind: 'emergency',
    scope: Object.freeze({ regions: Object.freeze(['sonoma-county']) }),
    maxAgeMs: 3 * DAY,
    timeZone: null,
  }),
  Object.freeze({
    ...ALERT_FEEDS.lafd,
    agency: 'Los Angeles Fire Department',
    page: 'https://lafd.org/alerts',
    candidates: Object.freeze(['https://lafd.org/alerts-rss.xml']),
    hosts: Object.freeze(['lafd.org', 'www.lafd.org']),
    kind: 'emergency',
    scope: Object.freeze({ regions: Object.freeze(['los-angeles']) }),
    maxAgeMs: DAY,
    // LAFD alert items carry long-form Pacific times without an offset.
    timeZone: 'America/Los_Angeles',
  }),
]);

/** Severity read from a bulletin's wording; bulletins carry no severity field. */
export function bulletinSeverity(text) {
  const words = String(text || '');
  if (
    /evacuation (order|warning)|mandatory evacuation|shelter[- ]in[- ]place|red flag warning|state of emergency|tsunami|flash flood warning|major emergency/i.test(
      words,
    )
  )
    return 'severe';
  if (/evacuat|warning|closure|outage|boil water|hazard/i.test(words))
    return 'moderate';
  return 'minor';
}

/**
 * Regions a bulletin concerns: its agency's own, or for a statewide feed the
 * regions in that state whose places it names, else every region in the
 * state.
 */
export function bulletinRegions(feed, text) {
  if (feed.scope.regions) return [...feed.scope.regions];
  const inState = regionsForState(feed.scope.state);
  const named = regionsForText(text).filter((id) => inState.includes(id));
  return named.length ? named : inState;
}

/** Normalize one feed item to an alert, or null when it is old. */
export function normalizeBulletin(
  feed,
  item,
  { now = Date.now(), fetchedAt = now } = {},
) {
  const publishedMs = Date.parse(item.publishedAt || item.updatedAt || '');
  if (!Number.isFinite(publishedMs)) return null;
  if (now - publishedMs > feed.maxAgeMs) return null;
  const text = `${item.title} ${item.summary}`;
  const regions = bulletinRegions(feed, text);
  if (!regions.length) return null;
  const named = feed.scope.state ? regionsForText(text) : [];
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
        headers: {
          Accept:
            'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5',
        },
        timeoutMs: 15_000,
        maxBytes: MAX_BYTES,
        redirectHosts: feed.hosts,
      });
    async function loadFrom(url) {
      const { payload, url: finalUrl } = await read(url);
      if (!looksLikeFeed(payload)) throw new UpstreamError('invalid_payload');
      return { xml: payload, url: finalUrl };
    }
    return {
      ...feed,
      keyRequired: false,
      async load() {
        const tried = new Set();
        const attempts = [working, ...feed.candidates].filter(Boolean);
        let loaded = null;
        let lastError = null;
        for (const url of attempts) {
          if (tried.has(url)) continue;
          tried.add(url);
          try {
            loaded = await loadFrom(url);
            working = url;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (loaded === null) {
          try {
            const { payload, url: pageUrl } = await read(feed.page);
            for (const url of discoverFeedLinks(payload, pageUrl)) {
              if (tried.has(url)) continue;
              tried.add(url);
              try {
                loaded = await loadFrom(url);
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
        if (loaded === null)
          throw lastError || new UpstreamError('unavailable');
        const fetchedAt = now();
        const alerts = [];
        for (const item of parseFeedItems(loaded.xml, {
          baseUrl: loaded.url,
          timeZone: feed.timeZone,
        })) {
          const alert = normalizeBulletin(feed, item, {
            now: fetchedAt,
            fetchedAt,
          });
          if (alert) alerts.push(alert);
        }
        return { alerts, fetchedAt };
      },
    };
  });
}
