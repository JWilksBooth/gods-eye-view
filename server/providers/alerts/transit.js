/**
 * Transit service alerts for the regions, from GTFS-Realtime alert feeds:
 * BART's own keyless feed; 511 SF Bay's regional feed (free token) for
 * Muni, Caltrain, SMART, Sonoma County Transit and the rest of the Bay
 * Area; and the Swiftly-hosted feeds LA Metro and RTC Southern Nevada
 * publish (free key). Only URLs named here are ever requested; a keyed
 * feed without its key reports `key-required` and is never asked.
 *
 * Service alerts carry no geometry, so these alerts have no area and are
 * listed under their regions as bulletins.
 */
import { createAlert } from '../../../src/layers/alerts/model.js';
import { ALERT_FEEDS } from './feeds.js';
import {
  decodeGtfsAlertFeed,
  normalizeGtfsAlertFeed,
} from './gtfsrt.js';
import {
  UpstreamError,
  fetchUpstreamBytes,
  fetchUpstreamText,
  parseJsonText,
} from './http.js';

const MAX_BYTES = 6 * 1024 * 1024;
/** A transit alert scheduled further ahead than this is not news yet. */
const LOOKAHEAD_MS = 24 * 60 * 60_000;

/** 511 SF Bay operator ids, as the regional feed names them. */
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
  PE: 'Petaluma Transit',
  RV: 'Rio Vista Delta Breeze',
  SA: 'SMART',
  SB: 'San Francisco Bay Ferry',
  SC: 'Sonoma County Transit',
  SF: 'San Francisco Muni',
  SI: 'SFO AirTrain',
  SM: 'SamTrans',
  SO: 'SolTrans',
  SR: 'Santa Rosa CityBus',
  ST: 'SolTrans',
  TD: 'Tri Delta Transit',
  UC: 'Union City Transit',
  VC: 'Vacaville City Coach',
  VN: 'Vine Transit',
  VT: 'VTA',
  WC: 'WestCAT',
  WH: 'WestCAT',
});
/** Operators that serve Sonoma County, whose alerts belong to it too. */
const SONOMA_AGENCIES = new Set(['SC', 'SA', 'SR', 'PE']);

/** The feeds, in status order. `url` may read the key the feed needs. */
export const TRANSIT_ALERT_FEEDS = Object.freeze([
  Object.freeze({
    ...ALERT_FEEDS.bart,
    agency: 'BART',
    regions: Object.freeze(['san-francisco-bay-area']),
    url: () => 'https://api.bart.gov/gtfsrt/alerts.aspx',
    format: 'protobuf',
    advisories: 'https://www.bart.gov/schedules/advisories',
  }),
  Object.freeze({
    ...ALERT_FEEDS.sf511,
    agency: '511 SF Bay',
    regions: Object.freeze(['san-francisco-bay-area']),
    url: (key) =>
      `https://api.511.org/transit/servicealerts?${new URLSearchParams({
        api_key: key,
        agency: 'RG',
        format: 'json',
      })}`,
    format: 'json',
    advisories: 'https://511.org/transit/alerts',
  }),
  Object.freeze({
    ...ALERT_FEEDS['lametro-bus'],
    agency: 'LA Metro',
    regions: Object.freeze(['los-angeles']),
    url: () => 'https://api.goswift.ly/real-time/lametro/gtfs-rt-alerts',
    format: 'protobuf',
    keyHeader: 'Authorization',
    advisories: 'https://www.metro.net/riding/service-alerts/',
  }),
  Object.freeze({
    ...ALERT_FEEDS['lametro-rail'],
    agency: 'LA Metro Rail',
    regions: Object.freeze(['los-angeles']),
    url: () => 'https://api.goswift.ly/real-time/lametro-rail/gtfs-rt-alerts',
    format: 'protobuf',
    keyHeader: 'Authorization',
    advisories: 'https://www.metro.net/riding/service-alerts/',
  }),
  Object.freeze({
    ...ALERT_FEEDS.rtc,
    agency: 'RTC Southern Nevada',
    regions: Object.freeze(['las-vegas']),
    url: () => 'https://api.goswift.ly/real-time/las-vegas-rtc/gtfs-rt-alerts',
    format: 'protobuf',
    keyHeader: 'Authorization',
    advisories: 'https://www.rtcsnv.com/ways-to-travel/alerts-detours/',
  }),
]);

/** Regions of a 511 alert from the operators it names. */
function sf511Regions(informed) {
  const ids = informed.map((entry) => entry.agencyId).filter(Boolean);
  const regions = ['san-francisco-bay-area'];
  if (ids.some((id) => SONOMA_AGENCIES.has(id))) regions.push('sonoma-county');
  return regions;
}

function sf511Agency(informed) {
  const ids = [...new Set(informed.map((entry) => entry.agencyId).filter(Boolean))];
  const names = ids.map((id) => SF511_AGENCY_NAMES[id] || id);
  return names.length ? names.slice(0, 3).join(' · ') : '511 SF Bay';
}

/**
 * Normalize one GTFS alert record to the shared shape for a feed, or null
 * when it is over or not yet near.
 */
export function transitAlert(feed, record, { now = Date.now(), fetchedAt = now, timestamp = null } = {}) {
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
      body: [record.body, record.effect ? record.effect.replace(/_/g, ' ').toLowerCase() : null]
        .filter(Boolean)
        .join(' · '),
      area: null,
      areaDescription: null,
      regions: is511 ? sf511Regions(record.informed) : feed.regions,
      starts,
      ends,
      issued: timestamp,
      updated: timestamp,
      url: record.url || feed.advisories,
    },
    { fetchedAt },
  );
}

/**
 * One loadable source per transit feed. A keyed feed whose key is absent is
 * returned with `keyRequired: true` and no loader, so the composite can say
 * so without ever requesting it.
 */
export function createTransitFeedSources({
  fetchImpl,
  now = () => Date.now(),
  env = {},
  feeds = TRANSIT_ALERT_FEEDS,
} = {}) {
  return feeds.map((feed) => {
    const key = feed.envVar ? String(env[feed.envVar] || '').trim() : '';
    if (feed.envVar && !key) return { ...feed, keyRequired: true };
    return {
      ...feed,
      keyRequired: false,
      async load() {
        const url = feed.url(key);
        const headers = {
          Accept: 'application/x-protobuf, application/json;q=0.9, */*;q=0.1',
          ...(feed.keyHeader && key ? { [feed.keyHeader]: key } : {}),
        };
        const options = { fetchImpl, headers, timeoutMs: 20_000, maxBytes: MAX_BYTES };
        let normalized;
        if (feed.format === 'json') {
          const { payload } = await fetchUpstreamText(url, options);
          normalized = normalizeGtfsAlertFeed(parseJsonText(payload));
        } else {
          const { payload, contentType } = await fetchUpstreamBytes(url, options);
          normalized = /json/i.test(contentType)
            ? normalizeGtfsAlertFeed(
                parseJsonText(new TextDecoder().decode(payload)),
              )
            : normalizeGtfsAlertFeed(decodeGtfsAlertFeed(payload));
        }
        if (normalized.malformed)
          throw new UpstreamError(`${feed.id}_invalid_payload`);
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
