/**
 * San Francisco law-enforcement dispatched calls for service (real time),
 * DataSF dataset gnap-fj3t over the keyless Socrata SODA API. Rows carry the
 * CAD number, call type, priority, agency, the intersection the call was
 * placed at and a GeoJSON point for it. An optional Socrata app token only
 * raises the per-host throttle; it is never required.
 *
 * Licence: DataSF publishes the dataset under the Open Data Commons Public
 * Domain Dedication and License (PDDL).
 */
import { incidentRecord } from '../../../src/layers/incidents/records.js';
import {
  classifyIncidentType,
  fetchIncidentUpstream,
  incidentRegionId,
  pacificToUtcMs,
} from './common.js';

export const DATASF_CALLS_URL = 'https://data.sf.gov/resource/gnap-fj3t.json';
export const DATASF_SOURCE = Object.freeze({
  id: 'datasf-police',
  label: 'DataSF dispatched calls',
  agency: 'San Francisco Police Department',
  refreshMs: 60_000,
});
/** Calls received within this window are shown. */
export const DATASF_WINDOW_MS = 6 * 60 * 60_000;
const LIMIT = 500;

function pointOf(row) {
  const point = row?.intersection_point ?? row?.point ?? row?.location;
  if (point && Array.isArray(point.coordinates)) {
    const [lon, lat] = point.coordinates;
    return { lat: Number(lat), lon: Number(lon) };
  }
  if (point && typeof point === 'object') {
    const lat = Number(point.latitude ?? point.lat);
    const lon = Number(point.longitude ?? point.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  const finite = (value) => (value == null ? NaN : Number(value));
  return { lat: finite(row?.latitude), lon: finite(row?.longitude) };
}

/** Socrata's floating timestamps are San Francisco local time without a zone. */
function callTime(row) {
  const raw = row?.received_datetime ?? row?.entry_datetime;
  if (typeof raw !== 'string' || !raw) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(raw)) return Date.parse(raw);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw);
  if (!match) return null;
  return pacificToUtcMs({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  });
}

/** Normalize SODA rows; rows without a usable point are skipped. */
export function parseDataSfCalls(rows) {
  if (!Array.isArray(rows)) throw new Error('DataSF answered no list');
  const out = [];
  for (const row of rows) {
    const id = row?.cad_number ?? row?.id;
    const { lat, lon } = pointOf(row);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const typeText = [
      row.call_type_final_desc,
      row.call_type_original_desc,
      row.call_type_final,
      row.call_type_original,
    ]
      .filter(Boolean)
      .join(' ');
    const priority = row.priority_final ?? row.priority_original;
    const disposition = row.disposition;
    const description = [
      priority ? `Priority ${priority}` : null,
      row.police_district ? `${row.police_district} district` : null,
      disposition ? `Disposition ${disposition}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const record = incidentRecord({
      id,
      source: DATASF_SOURCE.id,
      sourceLabel: DATASF_SOURCE.label,
      agency: row.agency ? `SF ${row.agency}` : 'SFPD',
      type: classifyIncidentType(typeText, 'police'),
      typeDetail: row.call_type_final_desc || row.call_type_original_desc,
      lat,
      lon,
      location: row.intersection_name,
      area: row.analysis_neighborhood || row.police_district,
      time: callTime(row),
      description: description || null,
      region: incidentRegionId(lat, lon),
      url: 'https://data.sf.gov/d/gnap-fj3t',
    });
    if (record) out.push(record);
  }
  return out;
}

/** Floating timestamp in the dataset's zone, for `$where` comparisons. */
export function dataSfSinceStamp(nowMs, windowMs = DATASF_WINDOW_MS) {
  const since = new Date(nowMs - windowMs);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(since);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour').replace('24', '00')}:${get('minute')}:${get('second')}`;
}

export async function fetchDataSfCalls({
  fetchImpl,
  env = process.env,
  now = () => Date.now(),
  signal,
} = {}) {
  const url = new URL(DATASF_CALLS_URL);
  url.searchParams.set(
    '$where',
    `received_datetime > '${dataSfSinceStamp(now())}'`,
  );
  url.searchParams.set('$order', 'received_datetime DESC');
  url.searchParams.set('$limit', String(LIMIT));
  const token = String(env.SOCRATA_APP_TOKEN ?? '').trim();
  const rows = await fetchIncidentUpstream(url, {
    fetchImpl,
    signal,
    headers: {
      Accept: 'application/json',
      ...(token ? { 'X-App-Token': token } : {}),
    },
  });
  return parseDataSfCalls(rows);
}
