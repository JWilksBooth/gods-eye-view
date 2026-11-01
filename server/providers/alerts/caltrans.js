/**
 * Caltrans lane, ramp and road closures from the Commercial Wholesale Web
 * Portal (cwwp2.dot.ca.gov), one JSON file per district, keyless. Closures
 * in effect now, and those scheduled to start within a few hours, become
 * `road` alerts at the closure's starting point. Times in the feed are
 * Pacific local time without an offset; they are converted here.
 */
import { clampText, createAlert } from '../../../src/layers/alerts/model.js';
import {
  ALERT_CALTRANS_DISTRICTS,
  regionsForPoint,
} from '../../../src/layers/alerts/regions.js';
import { ALERT_FEEDS } from './feeds.js';
import { UpstreamError, fetchUpstreamText, parseJsonText } from './http.js';

/** The district's closure file, as the portal names it (`lcsStatusD07.json`). */
export const caltransLcsUrl = (district) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/lcs/lcsStatusD${String(district).padStart(2, '0')}.json`;
export const caltransDistrictUrl = (district) =>
  `https://lcswebreports.dot.ca.gov/searchdistricts?district=${district}`;
/** A scheduled closure this far ahead is already "what is happening". */
export const CALTRANS_LOOKAHEAD_MS = 6 * 60 * 60_000;
const MAX_BYTES = 12 * 1024 * 1024;
const PACIFIC = 'America/Los_Angeles';

/** A value by any of several names, skipping empties. */
function field(object, names) {
  if (!object || typeof object !== 'object') return undefined;
  for (const name of names) {
    const value = object[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** A value whose key ends with `suffix` (case-insensitive), skipping empties. */
function fieldEndingWith(object, suffix) {
  if (!object || typeof object !== 'object') return undefined;
  const wanted = suffix.toLowerCase();
  for (const [key, value] of Object.entries(object)) {
    if (
      key.toLowerCase().endsWith(wanted) &&
      value !== undefined &&
      value !== null &&
      value !== ''
    )
      return value;
  }
  return undefined;
}

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * The offset, in minutes east of UTC, that a time zone has at an instant.
 * Intl is the only portable source of DST rules.
 */
function zoneOffsetMinutes(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - ms) / 60_000);
}

/**
 * An ISO instant for a local `YYYY-MM-DD` date and `HH:MM[:SS]` time in a
 * zone, or null. The offset is resolved twice so a time near a DST change
 * lands on the right side of it.
 */
export function zonedLocalToIso(date, time, timeZone = PACIFIC) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || '').trim());
  if (!dateMatch) return null;
  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(
    String(time || '00:00').trim(),
  );
  if (!timeMatch) return null;
  const naive = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3] || 0),
  );
  if (!Number.isFinite(naive)) return null;
  let utc = naive - zoneOffsetMinutes(naive, timeZone) * 60_000;
  utc = naive - zoneOffsetMinutes(utc, timeZone) * 60_000;
  return new Date(utc).toISOString();
}

/** Whether the feed marks a closure as in place (Caltrans "10-97"). */
export function closureInEffect(closure) {
  const code = field(closure, ['code1097', 'Code1097', 'isActive', 'active']);
  if (code === undefined) return false;
  if (typeof code === 'boolean') return code;
  const text = String(code).trim().toLowerCase();
  if (['n', 'no', 'false', '0', 'null', 'none'].includes(text)) return false;
  return true;
}

/**
 * Normalize one closure record to an alert: `null` when it is outside the
 * regions, already over, or further ahead than the look-ahead.
 */
export function normalizeCaltransClosure(
  record,
  { district, now = Date.now(), fetchedAt = now, lookaheadMs = CALTRANS_LOOKAHEAD_MS } = {},
) {
  const lcs = record?.lcs || record;
  if (!lcs || typeof lcs !== 'object') return null;
  const location = lcs.location || {};
  const begin = location.begin || location;
  const end = location.end || {};
  const closure = lcs.closure || {};
  const lat = number(fieldEndingWith(begin, 'latitude'));
  const lon = number(fieldEndingWith(begin, 'longitude'));
  if (lat === null || lon === null) return null;
  const regions = regionsForPoint(lon, lat);
  if (!regions.length) return null;

  const timestamps = closure.closureTimestamp || closure;
  const starts = zonedLocalToIso(
    field(timestamps, ['closureStartDate', 'startDate']),
    field(timestamps, ['closureStartTime', 'startTime']),
  );
  const indefinite = /^(true|y|yes|1)$/i.test(
    String(field(timestamps, ['isClosureEndIndefinite']) ?? ''),
  );
  const ends = indefinite
    ? null
    : zonedLocalToIso(
        field(timestamps, ['closureEndDate', 'endDate']),
        field(timestamps, ['closureEndTime', 'endTime']),
      );
  const active = closureInEffect(closure);
  const startsMs = starts ? Date.parse(starts) : null;
  const endsMs = ends ? Date.parse(ends) : null;
  if (endsMs !== null && endsMs < now) return null;
  if (!active && startsMs !== null && startsMs > now + lookaheadMs) return null;
  if (!active && startsMs === null) return null;

  const route = clampText(field(begin, ['beginRoute', 'route']), 40);
  const suffix = clampText(field(begin, ['beginRouteSuffix', 'routeSuffix']), 8);
  const direction = clampText(
    field(location, ['travelFlowDirection']) ??
      field(begin, ['beginDirection', 'direction']),
    40,
  );
  const typeOfClosure = clampText(field(closure, ['typeOfClosure']), 40) || 'Lane';
  const facility = clampText(field(closure, ['facility']), 60);
  const work = clampText(field(closure, ['typeOfWork']), 160);
  const lanesClosed = number(field(closure, ['lanesClosed']));
  const totalLanes = number(field(closure, ['totalExistingLanes']));
  const delay = clampText(field(closure, ['estimatedDelay']), 60);
  const beginName = clampText(
    field(begin, ['beginLocationName', 'locationName']),
    160,
  );
  const endName = clampText(field(end, ['endLocationName', 'locationName']), 160);
  const nearby = clampText(field(begin, ['beginNearbyPlace', 'nearbyPlace']), 80);
  const closureId =
    clampText(field(closure, ['closureID', 'closureId', 'logNumber']), 60) ||
    clampText(field(lcs, ['index']), 40);
  if (!closureId) return null;
  const facts = [
    work,
    lanesClosed !== null && totalLanes !== null
      ? `${lanesClosed} of ${totalLanes} lanes closed`
      : lanesClosed !== null
        ? `${lanesClosed} lane(s) closed`
        : null,
    delay && !/^(0|none|no delay)/i.test(delay) ? `Estimated delay ${delay}` : null,
    facility,
    active ? 'In effect' : 'Scheduled',
  ].filter(Boolean);
  const recordEpoch = number(field(lcs.recordTimestamp || {}, ['recordEpoch']));
  return createAlert(
    {
      id: `caltrans:${district}:${closureId}`,
      source: 'caltrans',
      kind: 'road',
      severity: /full/i.test(typeOfClosure) ? 'moderate' : 'minor',
      agency: `Caltrans District ${district}`,
      headline: `${[route ? `${route}${suffix || ''}` : 'Highway', direction].filter(Boolean).join(' ')} · ${typeOfClosure} closure`,
      body: facts.join(' · ') || null,
      area: { type: 'Point', coordinates: [lon, lat] },
      areaSource: 'feed',
      areaDescription:
        [beginName, endName].filter(Boolean).join(' → ') || nearby || null,
      regions,
      starts,
      ends,
      issued: recordEpoch ? recordEpoch * (recordEpoch < 1e12 ? 1000 : 1) : null,
      updated: recordEpoch ? recordEpoch * (recordEpoch < 1e12 ? 1000 : 1) : null,
      url: caltransDistrictUrl(district),
    },
    { fetchedAt },
  );
}

/** The Caltrans feed as the proxy loads it: closures in the regions' districts. */
export function createCaltransFeedSource({
  fetchImpl,
  now = () => Date.now(),
  districts = ALERT_CALTRANS_DISTRICTS,
} = {}) {
  return {
    ...ALERT_FEEDS.caltrans,
    async load() {
      const alerts = [];
      const fetchedAt = now();
      let loaded = 0;
      let lastError = null;
      for (const district of districts) {
        try {
          const { payload } = await fetchUpstreamText(caltransLcsUrl(district), {
            fetchImpl,
            headers: { Accept: 'application/json' },
            timeoutMs: 25_000,
            maxBytes: MAX_BYTES,
          });
          const json = parseJsonText(payload);
          const rows = Array.isArray(json?.data) ? json.data : null;
          if (!rows) throw new UpstreamError('caltrans_invalid_payload');
          loaded += 1;
          for (const row of rows) {
            const alert = normalizeCaltransClosure(row, {
              district,
              now: fetchedAt,
              fetchedAt,
            });
            if (alert) alerts.push(alert);
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (!loaded) throw lastError || new UpstreamError('caltrans_unavailable');
      return { alerts, fetchedAt, partial: loaded < districts.length };
    },
  };
}
