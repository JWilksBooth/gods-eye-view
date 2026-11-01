/**
 * Los Angeles Fire Department alerts: the public RSS feed behind
 * lafd.org/alerts (structure fires, brush fires, rescues, major medical
 * responses inside the City of Los Angeles). Each alert names a street
 * address in its title or body but carries no coordinates, so the address
 * is geocoded once through the server's existing Nominatim queue, bounded
 * to the Los Angeles region box, and cached for the life of the process.
 * Alerts whose address cannot be placed are left out rather than guessed.
 */
import { incidentRecord } from '../../../src/layers/incidents/records.js';
import { liveOpsRegion } from '../../../src/data/liveOpsRegions.js';
import { fetchNominatimSearch } from '../regional/place.js';
import {
  classifyIncidentType,
  fetchIncidentUpstream,
  pacificToUtcMs,
} from './common.js';

export const LAFD_ALERTS_URL = 'https://lafd.org/alerts-rss.xml';
export const LAFD_SOURCE = Object.freeze({
  id: 'lafd-alerts',
  label: 'LAFD alerts',
  agency: 'Los Angeles Fire Department',
  refreshMs: 2 * 60_000,
});
/** Alerts older than this are history, not live operations. */
export const LAFD_WINDOW_MS = 12 * 60 * 60_000;
const MAX_ALERTS = 40;
const MAX_GEOCODES_PER_REFRESH = 8;

function decode(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rssTag(block, tag) {
  const match = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    'i',
  ).exec(block);
  return match ? decode(match[1]) : '';
}

/**
 * The street address an alert names: "1234 N Main St", "Hollywood Fwy at
 * Vermont Ave" or an intersection "Main St / 1st St". Returns null when no
 * address-like phrase is present.
 */
export function lafdAddress(text) {
  const value = String(text || '');
  const numbered =
    /\b(\d{1,5}(?:\s*-\s*\d{1,5})?\s+(?:[NSEW]\.?\s+)?[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,4}\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Pl|Place|Way|Ln|Lane|Ct|Court|Hwy|Highway|Fwy|Freeway|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Av|Bl|Wy|Pk|Hy|Fy|Tr|Te|Cr))\b\.?/;
  const hit = numbered.exec(value);
  if (hit) return hit[1].replace(/\s+/g, ' ').trim();
  const intersection =
    /\b([A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,3}\s+(?:St|Ave|Blvd|Dr|Rd|Way|Hwy|Fwy|Pkwy)\.?\s*(?:\/|&|at|and)\s*[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,3}\s+(?:St|Ave|Blvd|Dr|Rd|Way|Hwy|Fwy|Pkwy))\b\.?/;
  const cross = intersection.exec(value);
  return cross ? cross[1].replace(/\s+/g, ' ').trim() : null;
}

const MONTHS = Object.freeze({
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
});

/**
 * The feed's pubDate is a long-form Pacific local time with no offset
 * ("Sunday, November 1, 2026 - 09:23"); RFC 2822 dates still parse directly.
 * @returns {number|null} Epoch milliseconds, or null when unreadable.
 */
export function lafdTime(text) {
  const value = String(text || '').trim();
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;
  const match =
    /^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*-\s*(\d{1,2}):(\d{2})$/.exec(
      value,
    );
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (!month) return null;
  return pacificToUtcMs({
    year: Number(match[3]),
    month,
    day: Number(match[2]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  });
}

/** Parse the feed into alerts (not yet placed): `{ id, title, body, time, url, address }`. */
export function parseLafdAlerts(xml) {
  const alerts = [];
  for (const match of String(xml || '').matchAll(
    /<item>([\s\S]*?)<\/item>/gi,
  )) {
    const item = match[1];
    const title = rssTag(item, 'title');
    const body = rssTag(item, 'description');
    // The CMS wraps title and link text in anchors; the href is the alert page.
    const href = /<(?:link|title)[^>]*>[\s\S]*?href="([^"]+)"/i.exec(item)?.[1];
    const link = href
      ? new URL(decode(href), 'https://lafd.org/').href
      : rssTag(item, 'link');
    const guid = rssTag(item, 'guid') || link || title;
    if (!title || !guid) continue;
    const time = lafdTime(rssTag(item, 'pubDate'));
    alerts.push({
      id: guid.replace(/^https?:\/\//, '').slice(0, 120),
      title,
      body,
      time: Number.isFinite(time) ? time : null,
      url: link,
      address: lafdAddress(`${title} ${body}`),
    });
    if (alerts.length >= MAX_ALERTS) break;
  }
  return alerts;
}

/** Geocode within the Los Angeles box through the shared Nominatim queue. */
export function createLafdGeocoder({ search = fetchNominatimSearch } = {}) {
  const region = liveOpsRegion('los-angeles');
  const [west, south, east, north] = region.bbox;
  const bounds = `${south},${west}|${north},${east}`;
  const cache = new Map();
  return async function geocode(address, { signal } = {}) {
    const key = address.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    let point = null;
    try {
      const payload = await search(`${address}, Los Angeles, CA`, bounds, {
        signal,
      });
      const location = payload?.results?.[0]?.geometry?.location;
      if (
        location &&
        Number.isFinite(location.lat) &&
        Number.isFinite(location.lng) &&
        location.lat >= south &&
        location.lat <= north &&
        location.lng >= west &&
        location.lng <= east
      )
        point = { lat: location.lat, lon: location.lng };
    } catch {
      // Leave the alert unplaced this round; a later refresh retries.
      return null;
    }
    cache.set(key, point);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return point;
  };
}

/** Place parsed alerts; returns the rows that geocoded inside the region. */
export async function placeLafdAlerts(alerts, { geocode, now, signal } = {}) {
  const rows = [];
  let geocodes = 0;
  for (const alert of alerts) {
    if (alert.time != null && now() - alert.time > LAFD_WINDOW_MS) continue;
    if (!alert.address) continue;
    if (geocodes >= MAX_GEOCODES_PER_REFRESH) break;
    geocodes += 1;
    const point = await geocode(alert.address, { signal });
    if (!point) continue;
    const row = incidentRecord({
      id: alert.id,
      source: LAFD_SOURCE.id,
      sourceLabel: LAFD_SOURCE.label,
      agency: 'LAFD',
      type: classifyIncidentType(`${alert.title} ${alert.body}`, 'fire'),
      typeDetail: alert.title.replace(/\s+\d{1,2}\/\d{1,2}\/\d{4}.*$/, ''),
      lat: point.lat,
      lon: point.lon,
      location: alert.address,
      area: 'City of Los Angeles',
      time: alert.time,
      description: alert.body.slice(0, 400) || null,
      region: 'los-angeles',
      url: alert.url,
    });
    if (row) rows.push(row);
  }
  return rows;
}

export function createLafdFetcher({ geocode = createLafdGeocoder() } = {}) {
  return async function fetchLafdAlerts({
    fetchImpl,
    now = () => Date.now(),
    signal,
  } = {}) {
    const xml = await fetchIncidentUpstream(LAFD_ALERTS_URL, {
      fetchImpl,
      signal,
      json: false,
      redirect: 'follow',
      headers: { Accept: 'application/rss+xml,application/xml,text/xml' },
    });
    if (!/<rss[\s>]|<feed[\s>]|<item>/i.test(xml))
      throw new Error('not the LAFD alerts feed');
    return placeLafdAlerts(parseLafdAlerts(xml), { geocode, now, signal });
  };
}
