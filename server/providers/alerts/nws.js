/**
 * National Weather Service active alerts (api.weather.gov), keyless, with
 * the required User-Agent. One request per state the regions cover per
 * refresh.
 *
 * An alert is a candidate for a region when it names one of the region's
 * counties (SAME or UGC county codes) or its own polygon touches the region
 * box. Most NWS alerts carry no polygon; they name forecast zones, whose
 * shapes change on the order of years, so zone shapes are fetched once and
 * kept for a week, a bounded number per refresh and per hour. Once an alert
 * has an area (its polygon, its zones, or its county's centre while the zones
 * are still unknown) it is kept only in the candidate regions whose box that
 * area touches, so a zone far outside a region's box does not appear in it.
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
  ALERT_REGIONS,
  bboxIntersects,
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
const MAX_ZONES_PER_ALERT = 8;
/** Zone shapes fetched at once. */
const ZONE_CONCURRENCY = 4;
/** SAME state FIPS codes of the states the regions lie in. */
const STATE_BY_FIPS = Object.freeze({ '06': 'CA', '32': 'NV' });

/** The kind of alert an NWS event name describes. */
export function nwsAlertKind(event) {
  const name = String(event || '');
  if (/red flag|fire weather|fire warning|extreme fire/i.test(name))
    return 'fire';
  if (/air quality|air stagnation|smoke|dust/i.test(name)) return 'air';
  if (
    /evacuation|civil danger|civil emergency|shelter in place|hazardous materials|law enforcement|911 telephone|child abduction|blue alert|local area emergency|nuclear|radiological|earthquake|tsunami|volcano/i.test(
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
 * A page a person can read for the alert: the NWS hazard summary for its
 * first forecast zone and county, the issuing office's page, or the API
 * record itself.
 */
export function nwsAlertLink(properties) {
  const ugc = stringList(properties?.geocode?.UGC).map((code) =>
    code.trim().toUpperCase(),
  );
  const zone =
    ugc.find((code) => /^[A-Z]{2}Z\d{3}$/.test(code)) ||
    stringList(properties?.affectedZones)
      .map((url) => NWS_ZONE_URL_PATTERN.exec(url)?.[2])
      .find((code) => code && code[2] === 'Z');
  let county = ugc.find((code) => /^[A-Z]{2}C\d{3}$/.test(code));
  if (!county) {
    const same = stringList(properties?.geocode?.SAME).find((code) =>
      /^0\d{5}$/.test(code),
    );
    const state = same ? STATE_BY_FIPS[same.slice(1, 3)] : null;
    if (state) county = `${state}C${same.slice(3)}`;
  }
  if (zone && county)
    return `https://forecast.weather.gov/showsigwx.php?${new URLSearchParams({
      warnzone: zone,
      warncounty: county,
    })}`;
  const awips = stringList(properties?.parameters?.AWIPSidentifier)[0];
  const office = /^[A-Z]{3}([A-Z]{3})$/.exec(String(awips || ''))?.[1];
  if (office) return `https://www.weather.gov/${office.toLowerCase()}/`;
  return properties?.['@id'] || null;
}

/**
 * The region-relevant draft of one NWS feature: the alert fields, its
 * candidate regions and the zone addresses still to resolve. Null for a
 * test, cancelled, expired or out-of-region alert, or a malformed feature.
 */
export function draftNwsAlert(feature, { now = Date.now() } = {}) {
  const properties = feature?.properties;
  if (!properties || typeof properties !== 'object') return null;
  if (properties.status && properties.status !== 'Actual') return null;
  if (properties.messageType === 'Cancel') return null;
  const event = clampText(properties.event, 120);
  if (!event || /\btest\b/i.test(event)) return null;
  const id = clampText(properties.id, 240);
  if (!id) return null;
  const expiresMs = Date.parse(properties.ends || properties.expires || '');
  if (Number.isFinite(expiresMs) && expiresMs < now) return null;

  const same = stringList(properties.geocode?.SAME);
  const ugc = stringList(properties.geocode?.UGC);
  const geometry = simplifyAlertGeometry(feature.geometry);
  const candidates = [
    ...new Set([
      ...regionsForCountyFips(same),
      ...regionsForUgc(ugc),
      ...(geometry ? regionsForBbox(geometryBbox(geometry)) : []),
    ]),
  ];
  if (!candidates.length) return null;

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
      agency:
        clampText(properties.senderName, 120) || 'National Weather Service',
      headline: event,
      body: [clampText(properties.headline, 300), properties.description]
        .filter(Boolean)
        .join(' — '),
      instruction: properties.instruction,
      area: geometry,
      areaSource: geometry ? 'feed' : null,
      areaDescription: properties.areaDesc,
      regions: candidates,
      starts: properties.onset || properties.effective || properties.sent,
      ends: properties.ends || properties.expires,
      issued: properties.sent,
      updated: properties.sent,
      url: nwsAlertLink(properties),
    },
    zoneUrls: geometry ? [] : zoneUrls,
    countyCentroid: county ? ALERT_COUNTY_CENTROIDS[county] : null,
  };
}

/**
 * The candidate regions whose box an area touches; the candidates as they
 * are when there is no area to test.
 */
export function regionsTouchedBy(area, candidates, regions = ALERT_REGIONS) {
  const box = geometryBbox(area);
  if (!box) return [...candidates];
  return candidates.filter((id) => {
    const region = regions.find((entry) => entry.id === id);
    return region ? bboxIntersects(region.bbox, box) : false;
  });
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
  maxPerRefresh = 16,
} = {}) {
  const zones = new Map();
  let attempts = [];
  let fetchedThisRefresh = 0;
  const HOUR = 60 * 60_000;
  async function fetchZone(url) {
    const { payload } = await fetchUpstreamText(url, {
      fetchImpl,
      headers: NWS_HEADERS,
      timeoutMs: 10_000,
      maxBytes: MAX_ZONE_BYTES,
    });
    const feature = parseJsonText(payload);
    const geometry = simplifyAlertGeometry(feature?.geometry);
    return geometry && geometry.type !== 'Point' ? geometry : null;
  }
  return {
    /** Start a refresh: the per-refresh allowance applies from here. */
    beginRefresh() {
      fetchedThisRefresh = 0;
    },
    async resolve(urls) {
      const at = now();
      attempts = attempts.filter((time) => at - time < HOUR);
      const results = [];
      const missing = [];
      for (const url of urls) {
        if (!NWS_ZONE_URL_PATTERN.test(url)) continue;
        const cached = zones.get(url);
        if (cached && at - cached.fetchedAt < ttlMs) {
          if (cached.geometry) results.push(cached.geometry);
        } else missing.push(url);
      }
      const allowed = missing.filter(() => {
        if (
          fetchedThisRefresh >= maxPerRefresh ||
          attempts.length >= budgetPerHour
        )
          return false;
        fetchedThisRefresh += 1;
        attempts.push(now());
        return true;
      });
      for (let index = 0; index < allowed.length; index += ZONE_CONCURRENCY) {
        const batch = allowed.slice(index, index + ZONE_CONCURRENCY);
        const shapes = await Promise.all(
          batch.map((url) =>
            fetchZone(url).then(
              (geometry) => {
                zones.set(url, { geometry, fetchedAt: now() });
                return geometry;
              },
              () => null, // Left absent: retried on a later refresh.
            ),
          ),
        );
        for (const geometry of shapes) if (geometry) results.push(geometry);
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
  return {
    ...ALERT_FEEDS.nws,
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
          throw new UpstreamError('invalid_payload');
        features.push(...json.features);
      }
      const fetchedAt = now();
      const drafts = new Map();
      for (const feature of features) {
        const draft = draftNwsAlert(feature, { now: fetchedAt });
        if (draft && !drafts.has(draft.alert.id))
          drafts.set(draft.alert.id, draft);
      }
      zoneCache.beginRefresh?.();
      const alerts = [];
      for (const draft of drafts.values()) {
        let { area, areaSource } = draft.alert;
        if (!area && draft.zoneUrls.length) {
          const merged = mergePolygons(
            await zoneCache.resolve(draft.zoneUrls),
          );
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
        const regions = regionsTouchedBy(area, draft.alert.regions);
        if (!regions.length) continue;
        const alert = createAlert(
          { ...draft.alert, area, areaSource, regions },
          { fetchedAt },
        );
        if (alert) alerts.push(alert);
      }
      return { alerts, fetchedAt };
    },
  };
}
