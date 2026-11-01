/** Official alerts and FAA airport status for the LIVE OPS regions. */

import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  areaContains,
  polygonsTouchArea,
  resolveArea,
} from '../area.js';
import {
  LIMIT_SCHEMA,
  breakdown,
  breakdownPhrase,
  capRows,
  countNoun,
} from '../results.js';
import {
  LIVE_OPS_REGIONS,
  LIVE_OPS_REGION_IDS,
  regionArea,
} from '../../data/liveOpsRegions.js';
import {
  AIRPORT_STATUS_KINDS,
  ALERT_KIND_IDS,
  ALERT_SEVERITY_IDS,
  alertAnchor,
  compareAlerts,
  countBySeverity,
  severityRank,
  validateAlertGeometry,
} from '../../layers/alerts/model.js';
import { alertRegion } from '../../layers/alerts/regions.js';

const REGION_SCHEMA = Object.freeze({
  type: 'string',
  enum: LIVE_OPS_REGION_IDS,
  description: `A LIVE OPS region: ${LIVE_OPS_REGIONS.map(
    (region) => `${region.id} (${region.name})`,
  ).join(', ')}.`,
});

const KIND_SCHEMA = Object.freeze({
  type: 'string',
  enum: ALERT_KIND_IDS,
  description:
    'Keep only alerts of this kind: weather, fire, air (air quality), road ' +
    '(highway closures), transit, airport, emergency or advisory.',
});

const SEVERITY_SCHEMA = Object.freeze({
  type: 'string',
  enum: ALERT_SEVERITY_IDS.filter((id) => id !== 'unknown'),
  description:
    'Keep alerts at this severity or worse (extreme > severe > moderate > minor).',
});

const BODY_CHARS = 400;
const regionNames = () => LIVE_OPS_REGIONS.map((entry) => entry.name).join(', ');

/** Whether an alert lies in an area: its shape or point, or for a bulletin without one, its regions' boxes. */
export function alertInArea(alert, area) {
  const geometry = validateAlertGeometry(alert?.area);
  if (geometry?.type === 'Point') return areaContains(area, alertAnchor(alert));
  if (geometry)
    return polygonsTouchArea(
      geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates,
      area,
    );
  return (alert?.regions || []).some((id) => {
    const region = alertRegion(id);
    if (!region) return false;
    const [west, south, east, north] = region.bbox;
    return !(
      east < area.west ||
      west > area.east ||
      north < area.south ||
      south > area.north
    );
  });
}

const alertRow = (alert) => {
  const anchor = alertAnchor(alert);
  const body = alert.body ? String(alert.body) : null;
  return {
    id: alert.id,
    source: alert.source,
    kind: alert.kind,
    severity: alert.severity,
    agency: alert.agency,
    headline: alert.headline,
    area: alert.areaDescription ?? null,
    regions: [...(alert.regions || [])],
    lat: anchor?.lat ?? null,
    lon: anchor?.lon ?? null,
    placed: alert.areaSource ?? null,
    starts: alert.starts ?? null,
    ends: alert.ends ?? null,
    issued: alert.issued ?? null,
    url: alert.url ?? null,
    stale: alert.freshness === 'stale',
    body:
      body && body.length > BODY_CHARS
        ? `${body.slice(0, BODY_CHARS - 1)}…`
        : body,
  };
};

const sourceRow = (source) => ({
  id: source.id,
  label: source.label ?? source.id,
  status: source.status ?? null,
  stale: source.stale === true,
  count: source.count ?? 0,
  refresh_seconds: Number.isFinite(source.refreshMs)
    ? Math.round(source.refreshMs / 1000)
    : null,
  fetched_at: source.fetchedAt ?? null,
  key: source.status === 'key-required' ? (source.envVar ?? null) : null,
  error: source.error ?? null,
});

export const getAlerts = defineTool({
  name: 'get_alerts',
  title: 'Official alerts',
  description:
    'Official alerts in the LIVE OPS regions (Los Angeles, Sonoma County, ' +
    'San Francisco Bay Area, Las Vegas), worst first: National Weather ' +
    'Service warnings and advisories, CAL FIRE incidents, Caltrans highway ' +
    'closures, FAA airport status, AirNow air quality, transit service ' +
    'alerts and agency bulletins. Give an area, a region, or neither for ' +
    'all four; optionally one kind and a minimum severity.',
  inputSchema: {
    type: 'object',
    properties: {
      area: AREA_SCHEMA,
      region: REGION_SCHEMA,
      kind: KIND_SCHEMA,
      severity: SEVERITY_SCHEMA,
      limit: LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requires: ['alerts'],
  async run(args, { services, signal }) {
    const region = args.region ? alertRegion(args.region) : null;
    const live = region
      ? LIVE_OPS_REGIONS.find((entry) => entry.id === region.id)
      : null;
    const area = args.area
      ? await resolveArea(args.area, { services, signal })
      : live
        ? regionArea(live)
        : null;
    const snapshot = await services.alerts.getSnapshot({
      signal,
      region: region?.id ?? null,
      kinds: args.kind ? [args.kind] : null,
      minSeverity: args.severity ?? null,
    });
    const floor = args.severity ? severityRank(args.severity) : 0;
    const rows = snapshot.alerts
      .filter(
        (alert) =>
          (!args.kind || alert.kind === args.kind) &&
          severityRank(alert.severity) >= floor &&
          (!region || alert.regions?.includes(region.id)) &&
          (!area || alertInArea(alert, area)),
      )
      .sort(compareAlerts);
    const result = capRows(rows, args.limit);
    const kinds = breakdown(rows, 'kind');
    const severities = countBySeverity(rows);
    const where = area ? ` in ${area.label}` : ` across ${regionNames()}`;
    const failing = snapshot.sources.filter(
      (source) => source.status === 'unavailable',
    );
    const keyless = snapshot.sources.filter(
      (source) => source.status === 'key-required',
    );
    const worst = ALERT_SEVERITY_IDS.filter((id) => severities[id] > 0)
      .slice(0, 2)
      .map((id) => `${severities[id]} ${id}`);
    const notes = [
      ...(snapshot.stale ? ['some feeds are serving a stale copy'] : []),
      ...(failing.length
        ? [`no answer from ${failing.map((source) => source.label).join(', ')}`]
        : []),
      ...(keyless.length
        ? [
            `${keyless.map((source) => source.label).join(', ')} need a key`,
          ]
        : []),
    ];
    return {
      summary:
        `${countNoun(rows.length, 'alert')}${where}` +
        (worst.length ? ` (${worst.join(', ')})` : '') +
        breakdownPhrase(kinds, 'kind') +
        (notes.length ? `; ${notes.join('; ')}.` : '.'),
      data: {
        view: suggestView(
          services,
          area
            ? { area, layers: ['alerts'] }
            : {
                point: { lat: 36, lon: -119 },
                altitudeM: 1_500_000,
                layers: ['alerts'],
              },
        ),
        region: region?.id ?? null,
        stale: snapshot.stale === true,
        fetched_at: snapshot.fetchedAt ?? null,
        sources: snapshot.sources.map(sourceRow),
        by_kind: kinds,
        by_severity: severities,
        ...result,
        rows: result.rows.map(alertRow),
      },
    };
  },
});

/** `KSFO` → `SFO`; codes are compared upper case. */
export function normalizeAirportCode(code) {
  const text = String(code ?? '')
    .trim()
    .toUpperCase();
  return /^K[A-Z]{3}$/.test(text) ? text.slice(1) : text;
}

const eventRow = (event) => ({
  status: event.status,
  label: AIRPORT_STATUS_KINDS[event.status]?.name ?? event.status,
  severity: AIRPORT_STATUS_KINDS[event.status]?.severity ?? 'unknown',
  reason: event.reason ?? null,
  type: event.type ?? null,
  average_delay: event.avgDelay ?? null,
  max_delay: event.maxDelay ?? null,
  min_delay: event.minDelay ?? null,
  trend: event.trend ?? null,
  until: event.endTime ?? null,
  from: event.start ?? null,
  reopens: event.reopen ?? null,
});

/** The worst status among an airport's events, or `normal`. */
function worstStatus(events) {
  let worst = null;
  for (const event of events) {
    const kind = AIRPORT_STATUS_KINDS[event.status];
    if (!kind) continue;
    if (
      !worst ||
      severityRank(kind.severity) >
        severityRank(AIRPORT_STATUS_KINDS[worst].severity)
    )
      worst = event.status;
  }
  return worst || 'normal';
}

function statusPhrase(airport) {
  if (airport.status === 'normal') return `${airport.code} normal`;
  if (airport.status === 'unknown') return `${airport.code} unknown`;
  const labels = [
    ...new Set(airport.events.map((event) => event.label.toLowerCase())),
  ];
  return `${airport.code} ${labels.join(' and ')}`;
}

export const getAirportStatus = defineTool({
  name: 'get_airport_status',
  title: 'Airport status',
  description:
    'Live FAA National Airspace System status: airport closures and ' +
    'restrictions, ground stops, ground delay programs and arrival or ' +
    'departure delays. Give airport codes (any US airport the FAA reports, ' +
    'such as SFO or LAS), an area or a LIVE OPS region; with none, the ' +
    'airports of all four regions.',
  inputSchema: {
    type: 'object',
    properties: {
      airports: {
        type: 'array',
        items: { type: 'string', pattern: '^[A-Za-z0-9]{3,4}$' },
        minItems: 1,
        maxItems: 20,
        description: 'IATA or FAA airport codes, such as SFO, LAX or LAS.',
      },
      area: AREA_SCHEMA,
      region: REGION_SCHEMA,
    },
    additionalProperties: false,
  },
  requires: ['alerts'],
  async run(args, { services, signal }) {
    const payload = await services.alerts.getAirports({ signal });
    if (payload.status === 'unavailable')
      throw new ToolError(
        'unavailable',
        'FAA airport status is unavailable right now',
      );
    const known = new Map(
      payload.airports.map((airport) => [airport.code, airport]),
    );
    const eventsFor = (code) =>
      payload.events.filter((event) => event.airport === code);
    const answer = (code) => {
      const airport = known.get(code);
      const events = eventsFor(code).map(eventRow);
      return {
        code,
        name: airport?.name ?? null,
        lat: airport?.lat ?? null,
        lon: airport?.lon ?? null,
        regions: airport?.regions ?? [],
        status: worstStatus(eventsFor(code)),
        events,
      };
    };
    let label;
    let area = null;
    let codes;
    if (args.airports?.length) {
      codes = [...new Set(args.airports.map(normalizeAirportCode))];
      label = codes.join(', ');
    } else {
      const region = args.region ? alertRegion(args.region) : null;
      const live = region
        ? LIVE_OPS_REGIONS.find((entry) => entry.id === region.id)
        : null;
      area = args.area
        ? await resolveArea(args.area, { services, signal })
        : live
          ? regionArea(live)
          : null;
      codes = payload.airports
        .filter((airport) =>
          area
            ? areaContains(area, airport)
            : region
              ? airport.regions.includes(region.id)
              : true,
        )
        .map((airport) => airport.code);
      label = area ? area.label : regionNames();
    }
    const airports = codes.map(answer);
    const affected = airports.filter((airport) => airport.status !== 'normal');
    const located = airports.filter((airport) => Number.isFinite(airport.lat));
    const view = area
      ? suggestView(services, { area, layers: ['alerts'] })
      : located.length === 1
        ? suggestView(services, {
            point: { lat: located[0].lat, lon: located[0].lon },
            altitudeM: 40_000,
            layers: ['alerts'],
          })
        : null;
    const stale = payload.stale === true;
    let summary;
    if (!airports.length)
      summary = `No airports the alerts layer follows in ${label}.`;
    else if (!affected.length)
      summary = `${countNoun(airports.length, 'airport')} (${label}): no closures, stops or delays reported by the FAA.`;
    else
      summary = `${affected.map(statusPhrase).join('; ')}; ${countNoun(airports.length - affected.length, 'other airport')} normal.`;
    if (stale) summary = `${summary.replace(/\.$/, '')} (FAA status may be stale).`;
    return {
      summary,
      data: {
        ...(view ? { view } : {}),
        source: payload.source ?? 'FAA National Airspace System Status',
        url: payload.home ?? null,
        updated_at: payload.updatedAt ?? null,
        fetched_at: payload.fetchedAt ?? null,
        stale,
        airports,
      },
    };
  },
});
