/**
 * California Highway Patrol CAD incidents, from the statewide XML export at
 * `https://media.chp.ca.gov/sa_xml/sa.xml` (keyless, the same log the
 * cad.chp.ca.gov page shows). Every dispatch center is parsed; rows are kept
 * when their position falls inside a LIVE OPS region, so the Golden Gate,
 * Los Angeles and Inland centers that cover the California regions all
 * contribute without naming their codes here.
 *
 * Shape (text values are wrapped in literal double quotes):
 *   <State><Center ID="LAHB"><Dispatch ID="LACC">
 *     <Log ID="260615LA2002">
 *       <LogTime>"Jun 15 2026  5:21PM"</LogTime>
 *       <LogType>"1179-Trfc Collision-1141 Enrt"</LogType>
 *       <Location>"Angeles Crest Hwy / Mm 30.50"</Location>
 *       <LocationDesc>"ANGELES CREST HWY JSO MM30.5"</LocationDesc>
 *       <Area>"Altadena"</Area>
 *       <LATLON>"34260464:118190693"</LATLON>   (microdegrees; west is positive)
 *       <LogDetails><details><DetailTime>…</DetailTime><IncidentDetail>"[6] VEH OFF RDWAY"</IncidentDetail></details>…</LogDetails>
 *     </Log>
 *   </Dispatch></Center></State>
 */
import { incidentRecord } from '../../../src/layers/incidents/records.js';
import {
  classifyIncidentType,
  fetchIncidentUpstream,
  incidentRegionId,
  parsePacificStamp,
} from './common.js';

export const CHP_XML_URL = 'https://media.chp.ca.gov/sa_xml/sa.xml';
export const CHP_SOURCE = Object.freeze({
  id: 'chp',
  label: 'CHP CAD',
  agency: 'California Highway Patrol',
  refreshMs: 60_000,
});

const DISPATCH_NAMES = Object.freeze({
  GGCC: 'Golden Gate',
  LACC: 'Los Angeles',
  BCCC: 'Border',
  OCCC: 'Orange County',
  SACC: 'Sacramento',
  STCC: 'Stockton',
  VTCC: 'Ventura',
  FRCC: 'Fresno',
});

function unquote(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .trim();
}

function tag(block, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i').exec(
    block,
  );
  return match ? unquote(match[1]) : '';
}

/** `34260464:118190693` → { lat: 34.260464, lon: -118.190693 }. */
export function parseChpLatLon(text) {
  const match = /^(-?\d+):(-?\d+)$/.exec(String(text || '').trim());
  if (!match) return null;
  const lat = Number(match[1]) / 1e6;
  let lon = Number(match[2]) / 1e6;
  // California is in the western hemisphere; the feed drops the sign.
  if (lon > 0) lon = -lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0) return null;
  return { lat, lon };
}

/** CHP incident types carry a code prefix ("1179-Trfc Collision-1141 Enrt"). */
export function chpTypeDetail(logType) {
  return String(logType || '')
    .replace(/^\d{3,5}\s*-\s*/, '')
    .trim();
}

/** Parse the statewide XML into normalized rows inside the LIVE OPS regions. */
export function parseChpIncidents(xml, { onlyRegions = true } = {}) {
  const rows = [];
  const text = String(xml || '');
  for (const dispatch of text.matchAll(
    /<Dispatch\s+ID="([^"]*)"[^>]*>([\s\S]*?)<\/Dispatch>/gi,
  )) {
    const dispatchId = unquote(dispatch[1]).toUpperCase();
    for (const log of dispatch[2].matchAll(
      /<Log\s+ID="([^"]*)"[^>]*>([\s\S]*?)<\/Log>/gi,
    )) {
      const logId = unquote(log[1]);
      const body = log[2];
      const point = parseChpLatLon(tag(body, 'LATLON'));
      if (!point) continue;
      const region = incidentRegionId(point.lat, point.lon);
      if (onlyRegions && !region) continue;
      const logType = tag(body, 'LogType');
      const details = [];
      for (const detail of body.matchAll(/<details>([\s\S]*?)<\/details>/gi)) {
        const line = tag(detail[1], 'IncidentDetail').replace(
          /^\[\d+\]\s*/,
          '',
        );
        if (line) details.push(line);
      }
      const area = tag(body, 'Area');
      const dispatchName = DISPATCH_NAMES[dispatchId] || dispatchId;
      const row = incidentRecord({
        id: logId || `${dispatchId}-${rows.length}`,
        source: CHP_SOURCE.id,
        sourceLabel: CHP_SOURCE.label,
        agency: `CHP ${dispatchName}`,
        type: classifyIncidentType(logType, 'traffic'),
        typeDetail: chpTypeDetail(logType),
        lat: point.lat,
        lon: point.lon,
        location: tag(body, 'Location') || tag(body, 'LocationDesc'),
        area: area || null,
        time: parsePacificStamp(tag(body, 'LogTime')),
        description: details.slice(-3).join(' · ') || null,
        region,
        url: 'https://cad.chp.ca.gov/',
      });
      if (row) rows.push(row);
    }
  }
  return rows;
}

export async function fetchChpIncidents({ fetchImpl, signal } = {}) {
  const xml = await fetchIncidentUpstream(CHP_XML_URL, {
    fetchImpl,
    signal,
    json: false,
    headers: { Accept: 'application/xml,text/xml' },
  });
  if (!/<State[\s>]/i.test(xml)) throw new Error('not the CHP incident XML');
  return parseChpIncidents(xml);
}
