/**
 * Nevada 511 road events (crashes and incidents, closures, roadwork,
 * special events) for the Las Vegas valley.
 *
 * With `NVROADS_API_KEY` the developer API `GET /api/v2/get/event?key=…`
 * answers an array of `{ ID, RoadwayName, DirectionOfTravel, Description,
 * Comment, LastUpdated (Unix seconds), StartDate, PlannedEndDate,
 * LanesAffected, Latitude, Longitude, EventType, EventSubType,
 * IsFullClosure, Severity }`. Without a key the site's own event table,
 * `GET /List/GetData/Events?query=<DataTables JSON>&lang=en-US`, is read
 * the same way the camera pack reads its table; its rows use the
 * lower-camel spelling of the same fields and a WKT point. Both are parsed
 * by one tolerant mapper.
 */
import { incidentRecord } from '../../../src/layers/incidents/records.js';
import {
  classifyIncidentType,
  fetchIncidentUpstream,
  incidentRegionId,
} from './common.js';
import {
  NVROADS_ORIGIN,
  nvroadsTableQuery,
  parseNvroadsPoint,
} from '../cctv/nvroads.js';

export const NVROADS_EVENTS_API_URL = `${NVROADS_ORIGIN}/api/v2/get/event`;
export const NVROADS_EVENTS_TABLE_URL = `${NVROADS_ORIGIN}/List/GetData/Events`;
export const NVROADS_EVENTS_SOURCE = Object.freeze({
  id: 'nvroads',
  label: 'Nevada 511 events',
  agency: 'Nevada DOT',
  refreshMs: 2 * 60_000,
});
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

const EVENT_TYPE_MAP = Object.freeze({
  accidentsandincidents: 'traffic',
  closures: 'closure',
  roadwork: 'closure',
  specialevents: 'other',
});

function pick(row, ...names) {
  for (const name of names) {
    const value = row?.[name];
    if (value != null && value !== '') return value;
  }
  return null;
}

function eventTime(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** One API or table row → a normalized row inside a LIVE OPS region, or null. */
export function nvroadsEventToIncident(row) {
  if (!row || typeof row !== 'object') return null;
  const id = pick(row, 'ID', 'Id', 'id');
  const finite = (value) => (value == null ? NaN : Number(value));
  let lat = finite(pick(row, 'Latitude', 'latitude'));
  let lon = finite(pick(row, 'Longitude', 'longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const wkt =
      row.latLng?.geography?.wellKnownText ??
      row.startLatLng?.geography?.wellKnownText ??
      row.location?.geography?.wellKnownText;
    ({ lat, lon } = parseNvroadsPoint(wkt));
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const region = incidentRegionId(lat, lon);
  if (!region) return null;
  const eventType = String(pick(row, 'EventType', 'eventType') || '')
    .replace(/[^a-z]/gi, '')
    .toLowerCase();
  const subtype = pick(row, 'EventSubType', 'eventSubType', 'subType');
  const description = pick(row, 'Description', 'description', 'headline');
  const type =
    EVENT_TYPE_MAP[eventType] ||
    classifyIncidentType(`${subtype || ''} ${description || ''}`, 'other');
  const roadway = pick(row, 'RoadwayName', 'roadwayName', 'roadway');
  const direction = pick(
    row,
    'DirectionOfTravel',
    'directionOfTravel',
    'direction',
  );
  const lanes = pick(row, 'LanesAffected', 'lanesAffected');
  const severity = pick(row, 'Severity', 'severity');
  const fullClosure = pick(row, 'IsFullClosure', 'isFullClosure') === true;
  return incidentRecord({
    id,
    source: NVROADS_EVENTS_SOURCE.id,
    sourceLabel: NVROADS_EVENTS_SOURCE.label,
    agency: NVROADS_EVENTS_SOURCE.agency,
    type,
    typeDetail: subtype || pick(row, 'EventType', 'eventType'),
    lat,
    lon,
    location: [roadway, direction].filter(Boolean).join(' '),
    area: pick(row, 'Region', 'region', 'County', 'county', 'city'),
    time: eventTime(
      pick(row, 'LastUpdated', 'lastUpdated', 'StartDate', 'startDate'),
    ),
    description: [
      description,
      fullClosure ? 'Full closure' : null,
      lanes ? `Lanes: ${lanes}` : null,
      severity ? `Severity ${severity}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    region,
    url: 'https://www.nvroads.com/',
  });
}

export function parseNvroadsEvents(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : null;
  if (!list) throw new Error('Nevada 511 answered no list');
  return list.map(nvroadsEventToIncident).filter(Boolean);
}

async function fetchFromApi({ fetchImpl, key, signal }) {
  const url = new URL(NVROADS_EVENTS_API_URL);
  url.searchParams.set('key', key);
  url.searchParams.set('format', 'json');
  return parseNvroadsEvents(
    await fetchIncidentUpstream(url, {
      fetchImpl,
      signal,
      headers: { Accept: 'application/json' },
    }),
  );
}

async function fetchFromTable({ fetchImpl, signal }) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(NVROADS_EVENTS_TABLE_URL);
    url.searchParams.set(
      'query',
      nvroadsTableQuery(page * PAGE_SIZE, PAGE_SIZE),
    );
    url.searchParams.set('lang', 'en-US');
    const body = await fetchIncidentUpstream(url, {
      fetchImpl,
      signal,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    const list = Array.isArray(body?.data) ? body.data : [];
    rows.push(...list.map(nvroadsEventToIncident).filter(Boolean));
    const total = Number(body?.recordsFiltered ?? body?.recordsTotal);
    if (
      list.length < PAGE_SIZE ||
      (Number.isFinite(total) && (page + 1) * PAGE_SIZE >= total)
    )
      break;
  }
  return rows;
}

export async function fetchNvroadsEvents({
  fetchImpl,
  env = process.env,
  signal,
} = {}) {
  const key = String(env.NVROADS_API_KEY ?? '').trim();
  if (!key) return fetchFromTable({ fetchImpl, signal });
  try {
    return await fetchFromApi({ fetchImpl, key, signal });
  } catch (error) {
    console.warn(
      '[incidents] Nevada 511 developer API failed, using the site event table:',
      error?.message || error,
    );
    return fetchFromTable({ fetchImpl, signal });
  }
}
