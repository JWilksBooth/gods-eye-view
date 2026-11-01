/**
 * National Weather Service active alerts (api.weather.gov), keyless, with
 * the required User-Agent. Two requests per refresh, one per state the
 * regions cover; alerts are kept when their SAME county codes, UGC county
 * codes or geometry fall in a region.
 *
 * Most NWS alerts carry no polygon of their own; they name forecast zones.
 * Zone shapes change on the order of years, so they are fetched once and
 * kept for a week, a bounded number per refresh and per hour. Until a zone
 * shape is known the alert is placed at its county's centre and says so.
 */
import {
  clampText,
  createAlert,
  geometryBbox,
  normalizeSeverity,
} from '../../../src/layers/alerts/model.js';
import {
  ALERT_COUNTY_CENTROIDS,
  ALERT_NWS_AREAS,
  regionsForBbox,
  regionsForCountyFips,
  regionsForUgc,
} from '../../../src/layers/alerts/regions.js';
import { ALERT_FEEDS } from './feeds.js';
import { mergePolygons, simplifyAlertGeometry } from './geometry.js';
import { UpstreamError, fetchUpstreamText, parseJsonText } from './http.js';

export const NWS_ACTIVE_ALERTS_URL = 'https://api.weather.gov/alerts/active';
/** Only zone addresses of this exact shape are ever requested. */
export const NWS_ZONE_URL_PATTERN =
  /^https:\/\/api\.weather\.gov\/zones\/(forecast|county|fire|public)\/([A-Z]{2}[CZ]\d{3})$/;
const NWS_HEADERS = Object.freeze({ Accept: 'application/geo+json' });
const MAX_ALERT_BYTES = 12 * 1024 * 1024;
const MAX_ZONE_BYTES = 6 * 1024 * 1024;
/** Zones an alert may fan out to; a statewide product names dozens. */
const MAX_ZONES_PER_ALERT = 6;

/** The kind of alert an NWS event name describes. */
export function nwsAlertKind(event) {
  const name = String(event || '');
  if (/red flag|fire weather|fire warning|extreme fire/i.test(name))
    return 'fire';
  if (/air quality|air stagnation|smoke/i.test(name)) return 'air';
  if (
    /evacuation|civil danger|civil emergency|shelter in place|hazardous materials|law enforcement|911 telephone|child abduction|local area emergency|nuclear|radiological|earthquake|tsunami|volcano/i.test(
      name,
    )
  )
    return 'emergency';
  return 'weather';
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string')
    : [];
}

/**
 * The region-relevant draft of one NWS feature: the alert fields plus the
 * zone addresses still to resolve. Null for a test, cancelled, expired or
 * out-of-region alert, or for a malformed feature.
 */
export function draftNwsAlert(feature, { now = Date.now() } = {}) {
  const properties = feature?.properties;
  if (!properties || typeof properties !== 'object') return null;
  if (properties.status && properties.status !== 'Actual') return null;
  if (properties.messageType === 'Cancel') return null;
  const event = clampText(properties.event, 120);
  if (!event || /test/i.test(event)) return null;
  const id = clampText(properties.id, 240);
  if (!id) return null;
  const expiresMs = Date.parse(properties.ends || properties.expires || '');
  if (Number.isFinite(expiresMs) && expiresMs < now) return null;

  const same = stringList(properties.geocode?.SAME);
  const ugc = stringList(properties.geocode?.UGC);
  const geometry = simplifyAlertGeometry(feature.geometry);
  let regions = regionsForCountyFips(same);
  if (!regions.length) regions = regionsForUgc(ugc);
  if (!regions.length && geometry) regions = regionsForBbox(geometryBbox(geometry));
  if (!regions.length) return null;

  const zoneUrls = stringList(properties.affectedZones)
    .filter((url) => NWS_ZONE_URL_PATTERN.test(url))
    .slice(0, MAX_ZONES_PER_ALERT);
  const county = same.find((code) => ALERT_COUNTY_CENTROIDS[code]);
  return {
    alert: {
      id: `nws:${id}`,
      source: 'nws',
      kind: nwsAlertKind(event),
      severity: normalizeSeverity(properties.severity),
      agency: clampText(properties.senderName, 120) || 'National Weather Service',
      headline: event,
      body: [clampText(properties.headline, 300), properties.description]
        .filter(Boolean)
        .join(' — '),
      instruction: properties.instruction,
      area: geometry,
      areaSource: geometry ? 'feed' : null,
      areaDescription: properties.areaDesc,
      regions,
      starts: properties.onset || properties.effective || properties.sent,
      ends: properties.ends || properties.expires,
      issued: properties.sent,
      updated: properties.sent,
      url: properties['@id'] || properties.id,
    },
    zoneUrls: geometry ? [] : zoneUrls,
    countyCentroid: county ? ALERT_COUNTY_CENTROIDS[county] : null,
  };
}

/**
 * Zone shapes, fetched on demand and kept for a week. `resolve` returns the
 * geometries it has or can fetch within this refresh's allowance; a zone it
 * could not fetch yet is simply absent and tried again next time.
 */
export function createNwsZoneCache({
  fetchImpl,
  now = () => Date.now(),
  ttlMs = 7 * 24 * 60 * 60_000,
  budgetPerHour = 120,
  maxPerRefresh = 12,
} = {}) {
  const zones = new Map();
  let attempts = [];
  const HOUR = 60 * 60_000;
  async function fetchZone(url) {
    const { payload } = await fetchUpstreamText(url, {
      fetchImpl,
      headers: NWS_HEADERS,
      timeoutMs: 20_000,
      maxBytes: MAX_ZONE_BYTES,
    });
    const feature = parseJsonText(payload);
    const geometry = simplifyAlertGeometry(feature?.geometry);
    return geometry && geometry.type !== 'Point' ? geometry : null;
  }
  return {
    async resolve(urls) {
      const at = now();
      attempts = attempts.filter((time) => at - time < HOUR);
      let fetchedThisRefresh = 0;
      const results = [];
      for (const url of urls) {
        if (!NWS_ZONE_URL_PATTERN.test(url)) continue;
        const cached = zones.get(url);
        if (cached && at - cached.fetchedAt < ttlMs) {
          if (cached.geometry) results.push(cached.geometry);
          continue;
        }
        if (
          fetchedThisRefresh >= maxPerRefresh ||
          attempts.length >= budgetPerHour
        )
          continue;
        fetchedThisRefresh += 1;
        attempts.push(now());
        try {
          const geometry = await fetchZone(url);
          zones.set(url, { geometry, fetchedAt: now() });
          if (geometry) results.push(geometry);
        } catch {
          // Left absent: the alert falls back to its county centre this round.
        }
      }
      return results;
    },
    describe() {
      return { zones: zones.size, attemptsLastHour: attempts.length };
    },
  };
}

/**
 * The NWS feed as the proxy loads it: every active alert in the regions,
 * normalized, with geometry from the feed, from zone shapes, or a county
 * centre when neither is available yet.
 */
export function createNwsFeedSource({
  fetchImpl,
  now = () => Date.now(),
  areas = ALERT_NWS_AREAS,
  zoneCache = createNwsZoneCache({ fetchImpl, now }),
} = {}) {
  const feed = ALERT_FEEDS.nws;
  return {
    ...feed,
    async load() {
      const features = [];
      for (const area of areas) {
        const url = `${NWS_ACTIVE_ALERTS_URL}?${new URLSearchParams({ area })}`;
        const { payload } = await fetchUpstreamText(url, {
          fetchImpl,
          headers: NWS_HEADERS,
          timeoutMs: 25_000,
          maxBytes: MAX_ALERT_BYTES,
        });
        const json = parseJsonText(payload);
        if (!Array.isArray(json?.features))
          throw new UpstreamError('nws_invalid_payload', { url });
        features.push(...json.features);
      }
      const fetchedAt = now();
      const drafts = new Map();
      for (const feature of features) {
        const draft = draftNwsAlert(feature, { now: fetchedAt });
        if (draft && !drafts.has(draft.alert.id)) drafts.set(draft.alert.id, draft);
      }
      const alerts = [];
      for (const draft of drafts.values()) {
        let { area, areaSource } = draft.alert;
        if (!area && draft.zoneUrls.length) {
          const merged = mergePolygons(await zoneCache.resolve(draft.zoneUrls));
          if (merged) {
            area = merged;
            areaSource = 'zones';
          }
        }
        if (!area && draft.countyCentroid) {
          area = {
            type: 'Point',
            coordinates: [draft.countyCentroid.lon, draft.countyCentroid.lat],
          };
          areaSource = 'centroid';
        }
        const alert = createAlert(
          { ...draft.alert, area, areaSource },
          { fetchedAt },
        );
        if (alert) alerts.push(alert);
      }
      return { alerts, fetchedAt };
    },
  };
}
