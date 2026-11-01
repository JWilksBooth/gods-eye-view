/**
 * FAA National Airspace System status (nasstatus.faa.gov), keyless, public
 * domain: airport closures, ground stops, ground delay programs and general
 * arrival/departure delays, as one XML document following the FAA's
 * AirportStatus DTD. Parsed with bounded regular expressions, like the RSS
 * feeds; a section this parser does not know is counted, not invented.
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
export const FAA_AGENCY = 'FAA Air Traffic Control System Command Center';
const MAX_BYTES = 2 * 1024 * 1024;

const blocks = (text, tag) =>
  [...String(text || '').matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'))].map(
    (match) => match[1],
  );

const code = (block) =>
  xmlTag(block, 'ARPT')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);

/**
 * Parse the FAA airport status XML into one event per airport program.
 * @returns {{updatedAt: string|null, events: object[], unknownSections: string[]}}
 */
export function parseFaaAirportStatus(xml) {
  const text = String(xml || '');
  if (!/<AIRPORT_STATUS_INFORMATION/i.test(text) && !/<Delay_type/i.test(text))
    throw new UpstreamError('faa_invalid_payload');
  const updatedMs = Date.parse(xmlTag(text, 'Update_Time'));
  const events = [];
  const unknownSections = [];
  for (const block of blocks(text, 'Program')) {
    const airport = code(block);
    if (!airport) continue;
    events.push({
      airport,
      status: 'ground_stop',
      reason: clampText(xmlTag(block, 'Reason'), 200),
      type: null,
      endTime: clampText(xmlTag(block, 'End_Time'), 60),
      start: null,
      reopen: null,
      avgDelay: null,
      maxDelay: null,
      minDelay: null,
      trend: null,
    });
  }
  for (const block of blocks(text, 'Ground_Delay')) {
    const airport = code(block);
    if (!airport) continue;
    events.push({
      airport,
      status: 'ground_delay',
      reason: clampText(xmlTag(block, 'Reason'), 200),
      type: null,
      endTime: null,
      start: null,
      reopen: null,
      avgDelay: clampText(xmlTag(block, 'Avg'), 60),
      maxDelay: clampText(xmlTag(block, 'Max'), 60),
      minDelay: null,
      trend: null,
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
      events.push({
        airport,
        status: 'delay',
        reason,
        type: null,
        endTime: null,
        start: null,
        reopen: null,
        avgDelay: null,
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
      events.push({
        airport,
        status: 'delay',
        reason,
        type: clampText(type, 20),
        endTime: null,
        start: null,
        reopen: null,
        avgDelay: null,
        maxDelay: clampText(xmlTag(inner, 'Max'), 60),
        minDelay: clampText(xmlTag(inner, 'Min'), 60),
        trend: clampText(xmlTag(inner, 'Trend'), 40),
      });
    }
  }
  for (const block of blocks(text, 'Airport')) {
    const airport = code(block);
    if (!airport) continue;
    events.push({
      airport,
      status: 'closure',
      reason: clampText(xmlTag(block, 'Reason'), 200),
      type: null,
      endTime: null,
      start: clampText(xmlTag(block, 'Start'), 60),
      reopen: clampText(xmlTag(block, 'Reopen'), 60),
      avgDelay: null,
      maxDelay: null,
      minDelay: null,
      trend: null,
    });
  }
  for (const section of blocks(text, 'Delay_type')) {
    const name = xmlTag(section, 'Name');
    if (
      !/Ground_Stop_List|Ground_Delay_List|Arrival_Departure_Delay_List|Airport_Closure_List/i.test(
        section,
      ) &&
      /<[A-Za-z_]+_List/i.test(section)
    )
      unknownSections.push(name || 'unnamed');
  }
  return {
    updatedAt: Number.isFinite(updatedMs)
      ? new Date(updatedMs).toISOString()
      : null,
    events,
    unknownSections,
  };
}

/** Describe one event in words, English data the card shows as it came. */
export function describeAirportEvent(event) {
  const kind = AIRPORT_STATUS_KINDS[event.status];
  const parts = [
    event.type ? `${event.type} ${kind?.label?.toLowerCase() || event.status}` : kind?.label || event.status,
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
    const alert = createAlert(
      {
        id: `faa:${event.airport}:${event.status}:${event.type || 'all'}`,
        source: 'faa',
        kind: 'airport',
        severity: kind?.severity || 'unknown',
        agency: FAA_AGENCY,
        headline: `${event.airport} · ${kind?.label || event.status}${event.reason ? ` · ${event.reason}` : ''}`,
        body: describeAirportEvent(event),
        area: { type: 'Point', coordinates: [airport.lon, airport.lat] },
        areaSource: 'site',
        areaDescription: airport.name,
        regions,
        starts: null,
        ends: null,
        issued: status.updatedAt,
        updated: status.updatedAt,
        url: 'https://nasstatus.faa.gov/',
      },
      { fetchedAt },
    );
    if (alert) alerts.push(alert);
  }
  return alerts;
}

/** The FAA feed as the proxy loads it: the parsed national status. */
export function createFaaFeedSource({ fetchImpl, now = () => Date.now() } = {}) {
  return {
    ...ALERT_FEEDS.faa,
    async load() {
      const { payload } = await fetchUpstreamText(FAA_NAS_STATUS_URL, {
        fetchImpl,
        headers: { Accept: 'application/xml, text/xml, */*' },
        timeoutMs: 20_000,
        maxBytes: MAX_BYTES,
      });
      const status = parseFaaAirportStatus(payload);
      const fetchedAt = now();
      return { ...status, fetchedAt, alerts: faaAlerts(status, { fetchedAt }) };
    },
  };
}
