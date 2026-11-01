/**
 * Transit service alerts for the regions, from GTFS-Realtime alert feeds:
 * BART's own keyless feed; 511 SF Bay's regional feed (free token) for
 * Muni, Caltrain, SMART, Sonoma County Transit and the rest of the Bay
 * Area; and the Swiftly-hosted feeds of LA Metro and RTC Southern Nevada
 * (free key). Only URLs named here are ever requested; a keyed feed without
 * its key reports `key-required` and is never asked.
 *
 * Service alerts carry no geometry, so these alerts have no area and are
 * listed under their regions as bulletins.
 */
import { createAlert } from '../../../src/layers/alerts/model.js';
import { ALERT_FEEDS } from './feeds.js';
import { decodeGtfsAlertFeed, normalizeGtfsAlertFeed } from './gtfsrt.js';
import {
  UpstreamError,
  fetchUpstreamBytes,
  fetchUpstreamText,
  parseJsonText,
} from './http.js';

const MAX_BYTES = 6 * 1024 * 1024;
/** A transit alert scheduled further ahead than this is not news yet. */
const LOOKAHEAD_MS = 24 * 60 * 60_000;

/**
 * 511 SF Bay operator ids and the names alerts show. An operator not listed
 * is shown by its id.
 */
export const SF511_AGENCY_NAMES = Object.freeze({
  AC: 'AC Transit',
  AM: 'Capitol Corridor',
  BA: 'BART',
  CC: 'County Connection',
  CE: 'ACE',
  CM: 'Commute.org Shuttles',
  CT: 'Caltrain',
  DE: 'Dumbarton Express',
  EM: 'Emery Go-Round',
  FS: 'FAST',
  GF: 'Golden Gate Ferry',
  GG: 'Golden Gate Transit',
  MA: 'Marin Transit',
  SA: 'SMART',
  SB: 'San Francisco Bay Ferry',
  SC: 'Sonoma County Transit',
  SF: 'San Francisco Muni',
  SI: 'SFO AirTrain',
  SM: 'SamTrans',
  ST: 'SolTrans',
  TD: 'Tri Delta Transit',
  UC: 'Union City Transit',
  VT: 'VTA',
  WC: 'WestCAT',
});
/** 511 operator ids that serve Sonoma County; their alerts belong to it too. */
const SONOMA_AGENCIES = new Set(['SC', 'SA', 'SR', 'PE']);

/** The feeds, in status order. `url` may read the key the feed needs. */
export const TRANSIT_ALERT_FEEDS = Object.freeze([
  Object.freeze({
    ...ALERT_FEEDS.bart,
    agency: 'BART',
    url: () => 'https://api.bart.gov/gtfsrt/alerts.aspx',
    format: 'protobuf',
  }),
  Object.freeze({
    ...ALERT_FEEDS.sf511,
    agency: '511 SF Bay',
    url: (key) =>
      `https://api.511.org/transit/servicealerts?${new URLSearchParams({
        api_key: key,
        agency: 'RG',
        format: 'json',
      })}`,
    format: 'json',
  }),
  Object.freeze({
    ...ALERT_FEEDS['lametro-bus'],
    agency: 'LA Metro',
    url: () => 'https://api.goswift.ly/real-time/lametro/gtfs-rt-alerts',
    format: 'protobuf',
    keyHeader: 'Authorization',
  }),
  Object.freeze({
    ...ALERT_FEEDS['lametro-rail'],
    agency: 'LA Metro Rail',
    url: () => 'https://api.goswift.ly/real-time/lametro-rail/gtfs-rt-alerts',
    format: 'protobuf',
    keyHeader: 'Authorization',
  }),
  Object.freeze({
    ...ALERT_FEEDS.rtc,
    agency: 'RTC Southern Nevada',
    url: () => 'https://api.goswift.ly/real-time/rtcsnv/gtfs-rt-alerts',
    format: 'protobuf',
    keyHeader: 'Authorization',
  }),
]);

/** Regions of a 511 alert from the operators it names. */
function sf511Regions(informed) {
  const ids = informed.map((entry) => entry.agencyId).filter(Boolean);
  const regions = ['sf-bay-area'];
  if (ids.some((id) => SONOMA_AGENCIES.has(id))) regions.push('sonoma-county');
  return regions;
}

function sf511Agency(informed) {
  const ids = [
    ...new Set(informed.map((entry) => entry.agencyId).filter(Boolean)),
  ];
  const names = ids.map((id) => SF511_AGENCY_NAMES[id] || `511 operator ${id}`);
  return names.length ? names.slice(0, 3).join(' · ') : '511 SF Bay';
}

/**
 * Normalize one GTFS alert record to the shared shape for a feed, or null
 * when it is over or not yet near.
 */
export function transitAlert(
  feed,
  record,
  { now = Date.now(), fetchedAt = now, timestamp = null } = {},
) {
  const periods = record.activePeriods.filter(
    (range) => range.start !== null || range.end !== null,
  );
  const starts = periods.length
    ? Math.min(...periods.map((range) => range.start ?? range.end))
    : null;
  const ends =
    periods.length && periods.every((range) => range.end !== null)
      ? Math.max(...periods.map((range) => range.end))
      : null;
  if (ends !== null && ends < now) return null;
  if (starts !== null && starts > now + LOOKAHEAD_MS) return null;
  const is511 = feed.id === 'sf511';
  return createAlert(
    {
      id: `${feed.id}:${record.id}`,
      source: feed.id,
      kind: 'transit',
      severity: record.severity,
      agency: is511 ? sf511Agency(record.informed) : feed.agency,
      headline: record.headline,
      body: [
        record.body,
        record.effect ? record.effect.replace(/_/g, ' ').toLowerCase() : null,
      ]
        .filter(Boolean)
        .join(' · '),
      area: null,
      areaDescription: null,
      regions: is511 ? sf511Regions(record.informed) : feed.regions,
      starts,
      ends,
      issued: timestamp,
      updated: timestamp,
      url: record.url || feed.home,
    },
    { fetchedAt },
  );
}

/**
 * One loadable source per transit feed. A keyed feed reads its key on every
 * load, so one saved in Provider Settings applies without a restart; while
 * it is absent `keyMissing()` is true and the feed is never requested.
 */
export function createTransitFeedSources({
  fetchImpl,
  now = () => Date.now(),
  env = {},
  feeds = TRANSIT_ALERT_FEEDS,
} = {}) {
  return feeds.map((feed) => {
    const readKey = () =>
      feed.envVar ? String(env[feed.envVar] || '').trim() : '';
    return {
      ...feed,
      keyMissing: () => Boolean(feed.envVar) && !readKey(),
      async load() {
        const key = readKey();
        if (feed.envVar && !key) throw new UpstreamError('no_key');
        const url = feed.url(key);
        const headers = {
          Accept: 'application/x-protobuf, application/json;q=0.9, */*;q=0.1',
          ...(feed.keyHeader && key ? { [feed.keyHeader]: key } : {}),
        };
        const options = {
          fetchImpl,
          headers,
          timeoutMs: 20_000,
          maxBytes: MAX_BYTES,
        };
        let normalized;
        if (feed.format === 'json') {
          const { payload } = await fetchUpstreamText(url, options);
          normalized = normalizeGtfsAlertFeed(parseJsonText(payload));
        } else {
          const { payload, contentType } = await fetchUpstreamBytes(
            url,
            options,
          );
          normalized = /json/i.test(contentType)
            ? normalizeGtfsAlertFeed(
                parseJsonText(new TextDecoder().decode(payload)),
              )
            : normalizeGtfsAlertFeed(decodeGtfsAlertFeed(payload));
        }
        if (normalized.malformed) throw new UpstreamError('invalid_payload');
        const fetchedAt = now();
        const alerts = [];
        for (const record of normalized.alerts) {
          const alert = transitAlert(feed, record, {
            now: fetchedAt,
            fetchedAt,
            timestamp: normalized.timestamp,
          });
          if (alert) alerts.push(alert);
        }
        return { alerts, fetchedAt };
      },
    };
  });
}
