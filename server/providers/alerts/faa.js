/**
 * FAA National Airspace System status (nasstatus.faa.gov), keyless, public
 * domain: airport closures, ground stops, ground delay programs and general
 * arrival/departure delays, as one XML document following the FAA's
 * AirportStatus DTD. Parsed with bounded regular expressions, like the RSS
 * feeds; a section this parser does not know is counted, not invented.
 *
 * The closure list also carries NOTAMs that close an airport only to some
 * traffic ("AD AP CLSD TO NON SKED TRANSIENT GA ACFT ..."); those are
 * reported as restrictions, so scheduled service is never shown as closed.
 */
import {
  AIRPORT_STATUS_KINDS,
  clampText,
  createAlert,
} from '../../../src/layers/alerts/model.js';
import {
  ALERT_AIRPORTS,
  regionsForAirport,
} from '../../../src/layers/alerts/regions.js';
import { ALERT_FEEDS } from './feeds.js';
import { UpstreamError, fetchUpstreamText } from './http.js';
import { decodeXmlText, xmlTag } from './rss.js';

export const FAA_NAS_STATUS_URL =
  'https://nasstatus.faa.gov/api/airport-status-information';
export const FAA_STATUS_PAGE = 'https://nasstatus.faa.gov/';
export const FAA_AGENCY = 'FAA Air Traffic Control System Command Center';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 500;

const blocks = (text, tag) =>
  [
    ...String(text || '').matchAll(
      new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'),
    ),
  ].map((match) => match[1]);

const code = (block) =>
  xmlTag(block, 'ARPT')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);

/** Whether a closure NOTAM closes the airport only to some traffic. */
export function isPartialClosure(reason) {
  const text = String(reason || '').toUpperCase();
  return /\bCLSD\s+TO\b/.test(text) || /\bEXC\b[\s\S]*\bPPR\b/.test(text);
}

const blankEvent = (airport, status, reason) => ({
  airport,
  status,
  reason,
  type: null,
  endTime: null,
  start: null,
  reopen: null,
  avgDelay: null,
  maxDelay: null,
  minDelay: null,
  trend: null,
});

/**
 * Parse the FAA airport status XML into one event per airport program.
 * @returns {{updatedAt: string|null, events: object[], unknownSections: string[]}}
 */
export function parseFaaAirportStatus(xml) {
  const text = String(xml || '');
  if (!/<AIRPORT_STATUS_INFORMATION/i.test(text))
    throw new UpstreamError('invalid_payload');
  const updatedMs = Date.parse(xmlTag(text, 'Update_Time'));
  const events = [];
  const add = (event) => {
    if (events.length < MAX_EVENTS) events.push(event);
  };
  for (const block of blocks(text, 'Program')) {
    const airport = code(block);
    if (!airport) continue;
    add({
      ...blankEvent(
        airport,
        'ground_stop',
        clampText(xmlTag(block, 'Reason'), 200),
      ),
      endTime: clampText(xmlTag(block, 'End_Time'), 60),
    });
  }
  for (const block of blocks(text, 'Ground_Delay')) {
    const airport = code(block);
    if (!airport) continue;
    add({
      ...blankEvent(
        airport,
        'ground_delay',
        clampText(xmlTag(block, 'Reason'), 200),
      ),
      avgDelay: clampText(xmlTag(block, 'Avg'), 60),
      maxDelay: clampText(xmlTag(block, 'Max'), 60),
    });
  }
  for (const block of blocks(text, 'Delay')) {
    const airport = code(block);
    if (!airport) continue;
    const reason = clampText(xmlTag(block, 'Reason'), 200);
    const legs = [
      ...block.matchAll(
        /<Arrival_Departure\b([^>]*)>([\s\S]*?)<\/Arrival_Departure\s*>/gi,
      ),
    ];
    if (!legs.length) {
      add({
        ...blankEvent(airport, 'delay', reason),
        maxDelay: clampText(xmlTag(block, 'Max'), 60),
        minDelay: clampText(xmlTag(block, 'Min'), 60),
        trend: clampText(xmlTag(block, 'Trend'), 40),
      });
      continue;
    }
    for (const [, attributes, inner] of legs) {
      const type = decodeXmlText(
        /\bType\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] || '',
      );
      add({
        ...blankEvent(airport, 'delay', reason),
        type: clampText(type, 20),
        maxDelay: clampText(xmlTag(inner, 'Max'), 60),
        minDelay: clampText(xmlTag(inner, 'Min'), 60),
        trend: clampText(xmlTag(inner, 'Trend'), 40),
      });
    }
  }
  for (const block of blocks(text, 'Airport')) {
    const airport = code(block);
    if (!airport) continue;
    const reason = clampText(xmlTag(block, 'Reason'), 300);
    add({
      ...blankEvent(
        airport,
        isPartialClosure(reason) ? 'restriction' : 'closure',
        reason,
      ),
      start: clampText(xmlTag(block, 'Start'), 60),
      reopen: clampText(xmlTag(block, 'Reopen'), 60),
    });
  }
  const unknownSections = [];
  for (const section of blocks(text, 'Delay_type')) {
    const name = xmlTag(section, 'Name');
    if (
      !/Ground_Stop_List|Ground_Delay_List|Arrival_Departure_Delay_List|Airport_Closure_List/i.test(
        section,
      ) &&
      /<[A-Za-z_]+_List/i.test(section)
    )
      unknownSections.push(clampText(name, 60) || 'unnamed');
  }
  return {
    updatedAt: Number.isFinite(updatedMs)
      ? new Date(updatedMs).toISOString()
      : null,
    events,
    unknownSections,
  };
}

/** Describe one event in words: English data, shown as it came. */
export function describeAirportEvent(event) {
  const kind = AIRPORT_STATUS_KINDS[event.status];
  const label = kind?.name || event.status;
  const parts = [
    event.type ? `${event.type} ${label.toLowerCase()}` : label,
    event.reason,
    event.avgDelay ? `average ${event.avgDelay}` : null,
    event.maxDelay ? `up to ${event.maxDelay}` : null,
    event.minDelay && !event.maxDelay ? `${event.minDelay} or more` : null,
    event.trend ? `trend ${event.trend.toLowerCase()}` : null,
    event.endTime ? `until ${event.endTime}` : null,
    event.start ? `from ${event.start}` : null,
    event.reopen ? `reopens ${event.reopen}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Alerts for the regions' airports, one per program, placed at the airport. */
export function faaAlerts(status, { fetchedAt = Date.now() } = {}) {
  const alerts = [];
  for (const event of status?.events || []) {
    const airport = ALERT_AIRPORTS[event.airport];
    if (!airport) continue;
    const regions = regionsForAirport(event.airport);
    if (!regions.length) continue;
    const kind = AIRPORT_STATUS_KINDS[event.status];
    const label = kind?.name || event.status;
    // NOTAM text is long and coded; it stays in the body, not the headline.
    const shortReason =
      event.reason && !['closure', 'restriction'].includes(event.status)
        ? ` · ${event.reason}`
        : '';
    const alert = createAlert(
      {
        id: `faa:${event.airport}:${event.status}:${event.type || 'all'}`,
        source: 'faa',
        kind: 'airport',
        severity: kind?.severity || 'unknown',
        agency: FAA_AGENCY,
        headline: `${event.airport} · ${label}${shortReason}`,
        body: describeAirportEvent(event),
        area: { type: 'Point', coordinates: [airport.lon, airport.lat] },
        areaSource: 'site',
        areaDescription: airport.name,
        regions,
        starts: null,
        ends: null,
        issued: status.updatedAt,
        updated: status.updatedAt,
        url: FAA_STATUS_PAGE,
      },
      { fetchedAt },
    );
    if (alert) alerts.push(alert);
  }
  return alerts;
}

/** The FAA feed as the proxy loads it: the parsed national status. */
export function createFaaFeedSource({
  fetchImpl,
  now = () => Date.now(),
} = {}) {
  return {
    ...ALERT_FEEDS.faa,
    async load() {
      const { payload } = await fetchUpstreamText(FAA_NAS_STATUS_URL, {
        fetchImpl,
        headers: { Accept: 'application/xml, text/xml, */*;q=0.5' },
        timeoutMs: 20_000,
        maxBytes: MAX_BYTES,
      });
      const status = parseFaaAirportStatus(payload);
      const fetchedAt = now();
      return { ...status, fetchedAt, alerts: faaAlerts(status, { fetchedAt }) };
    },
  };
}
