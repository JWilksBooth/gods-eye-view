/**
 * Caltrans lane, ramp and road closures from the Commercial Wholesale Web
 * Portal (cwwp2.dot.ca.gov), one CSV file per district, keyless. The CSV is
 * the same Lane Closure System data as the district JSON at about a sixth of
 * the size, with flat columns and UTC epoch times.
 *
 * A closure is in effect when the crew has reported it in place ("10-97")
 * and has not yet reported it lifted ("10-98") or cancelled ("10-22").
 * Closures in effect, and those scheduled to start within the look-ahead,
 * become `road` alerts at the closure's starting point.
 */
import { clampText, createAlert } from '../../../src/layers/alerts/model.js';
import {
  ALERT_CALTRANS_DISTRICTS,
  regionsForPoint,
} from '../../../src/layers/alerts/regions.js';
import { parseCsvRecords } from './csv.js';
import { ALERT_FEEDS } from './feeds.js';
import { UpstreamError, fetchUpstreamText } from './http.js';

/** The district's closure file, as the portal names it (`lcsStatusD07.csv`). */
export const caltransLcsUrl = (district) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/lcs/lcsStatusD${String(district).padStart(2, '0')}.csv`;
/** The district's public closure report, the page a card opens. */
export const caltransDistrictUrl = (district) =>
  `https://lcswebreports.dot.ca.gov/searchdistricts?district=${district}`;
/** A scheduled closure starting this soon is already "what is happening". */
export const CALTRANS_LOOKAHEAD_MS = 60 * 60_000;
/** Columns a district file must carry to be read at all. */
export const CALTRANS_REQUIRED_COLUMNS = Object.freeze([
  'beginLatitude',
  'beginLongitude',
  'closureID',
  'closureStartEpoch',
  'closureEndEpoch',
  'isCode1097',
  'isCode1098',
  'typeOfClosure',
]);
const MAX_BYTES = 16 * 1024 * 1024;

const truthy = (value) => /^(true|y|yes|1)$/i.test(String(value ?? '').trim());

const number = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

/** Epoch seconds (or milliseconds) as milliseconds, or null. */
const epochMs = (value) => {
  const n = number(value);
  if (n === null || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
};

/** `Not Reported` and similar placeholders read as absent. */
const reported = (value, max) => {
  const text = clampText(value, max);
  return text && !/^(not reported|n\/a|na|none|unknown)$/i.test(text)
    ? text
    : null;
};

/** Whether a closure record is in place now (10-97, not lifted or cancelled). */
export function closureInEffect(record) {
  return (
    truthy(record?.isCode1097) &&
    !truthy(record?.isCode1098) &&
    !truthy(record?.isCode1022)
  );
}

/**
 * Normalize one closure record to an alert: null when it is outside the
 * regions, lifted, cancelled, over, or further ahead than the look-ahead.
 */
export function normalizeCaltransClosure(
  record,
  {
    district,
    now = Date.now(),
    fetchedAt = now,
    lookaheadMs = CALTRANS_LOOKAHEAD_MS,
  } = {},
) {
  if (!record || typeof record !== 'object') return null;
  const lat = number(record.beginLatitude);
  const lon = number(record.beginLongitude);
  if (lat === null || lon === null) return null;
  const regions = regionsForPoint(lon, lat);
  if (!regions.length) return null;
  if (truthy(record.isCode1098) || truthy(record.isCode1022)) return null;

  const startsMs = epochMs(record.closureStartEpoch);
  const indefinite = truthy(record.isClosureEndIndefinite);
  const endsMs = indefinite ? null : epochMs(record.closureEndEpoch);
  const active = closureInEffect(record);
  if (endsMs !== null && endsMs < now) return null;
  if (!active) {
    if (startsMs === null) return null;
    if (startsMs > now + lookaheadMs) return null;
  }

  const closureId = clampText(record.closureID, 40);
  if (!closureId) return null;
  const logNumber = clampText(record.logNumber, 20);
  const route = clampText(record.beginRoute, 40);
  const suffix = clampText(record.beginRouteSuffix, 8);
  const direction =
    reported(record.travelFlowDirection, 40) ||
    reported(record.beginDirection, 40);
  const typeOfClosure = clampText(record.typeOfClosure, 40) || 'Lane';
  const lanesClosed = reported(record.lanesClosed, 40);
  const totalLanes = reported(record.totalExistingLanes, 10);
  const delay = reported(record.estimatedDelay, 40);
  const delayMinutes = number(delay);
  const facts = [
    reported(record.typeOfWork, 160),
    lanesClosed && totalLanes
      ? `${lanesClosed} of ${totalLanes} lanes closed`
      : lanesClosed
        ? `Lanes closed: ${lanesClosed}`
        : null,
    delayMinutes !== null && delayMinutes > 0
      ? `Estimated delay ${delayMinutes} min`
      : null,
    reported(record.facility, 60),
    reported(record.durationOfClosure, 40),
    active ? 'In effect' : 'Scheduled',
  ].filter(Boolean);
  const from =
    reported(record.beginLocationName, 160) ||
    reported(record.beginFreeFormDescription, 160);
  const to =
    reported(record.endLocationName, 160) ||
    reported(record.endFreeFormDescription, 160);
  const recordMs = epochMs(record.recordEpoch);
  const reportedMs = epochMs(record.code1097Epoch);
  const full = /full/i.test(typeOfClosure);
  return createAlert(
    {
      id: `caltrans:${district}:${closureId}:${logNumber || '0'}`,
      source: 'caltrans',
      kind: 'road',
      severity: full ? 'moderate' : 'minor',
      agency: `Caltrans District ${district}`,
      headline: `${[route ? `${route}${suffix || ''}` : 'State highway', direction].filter(Boolean).join(' ')} · ${typeOfClosure} closure`,
      body: facts.join(' · ') || null,
      area: { type: 'Point', coordinates: [lon, lat] },
      areaSource: 'feed',
      areaDescription:
        [from, to].filter(Boolean).join(' → ') ||
        reported(record.beginNearbyPlace, 80),
      regions,
      starts: startsMs,
      ends: endsMs,
      issued: reportedMs ?? startsMs ?? recordMs,
      updated: recordMs,
      url: caltransDistrictUrl(district),
    },
    { fetchedAt },
  );
}

/** The alerts in one district file, or a typed failure for a file that is not one. */
export function caltransAlertsFromCsv(
  text,
  { district, now = Date.now(), fetchedAt = now } = {},
) {
  const { header, records } = parseCsvRecords(text);
  if (!CALTRANS_REQUIRED_COLUMNS.every((name) => header.includes(name)))
    throw new UpstreamError('invalid_payload');
  const alerts = [];
  const seen = new Set();
  for (const record of records) {
    const alert = normalizeCaltransClosure(record, {
      district,
      now,
      fetchedAt,
    });
    if (alert && !seen.has(alert.id)) {
      seen.add(alert.id);
      alerts.push(alert);
    }
  }
  return alerts;
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
          const { payload } = await fetchUpstreamText(
            caltransLcsUrl(district),
            {
              fetchImpl,
              headers: { Accept: 'text/csv, */*;q=0.5' },
              timeoutMs: 30_000,
              maxBytes: MAX_BYTES,
            },
          );
          alerts.push(
            ...caltransAlertsFromCsv(payload, {
              district,
              now: fetchedAt,
              fetchedAt,
            }),
          );
          loaded += 1;
        } catch (error) {
          lastError = error;
        }
      }
      if (!loaded) throw lastError || new UpstreamError('unavailable');
      return { alerts, fetchedAt, partial: loaded < districts.length };
    },
  };
}
