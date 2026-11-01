/**
 * CAL FIRE active incidents: the keyless JSON behind fire.ca.gov/incidents
 * (`incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false`).
 * Statewide wildfire and other CAL FIRE incidents with a position, acres,
 * containment and an incident page. Rows inside a LIVE OPS region are kept.
 */
import { incidentRecord } from '../../../src/layers/incidents/records.js';
import { fetchIncidentUpstream, incidentRegionId } from './common.js';

export const CALFIRE_URL =
  'https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false';
export const CALFIRE_SOURCE = Object.freeze({
  id: 'calfire',
  label: 'CAL FIRE incidents',
  agency: 'CAL FIRE',
  refreshMs: 5 * 60_000,
});

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function parseCalFireIncidents(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.Incidents)
      ? payload.Incidents
      : null;
  if (!list) throw new Error('CAL FIRE answered no list');
  const rows = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.IsActive === false || item.isActive === false) continue;
    const lat = number(item.Latitude ?? item.latitude);
    const lon = number(item.Longitude ?? item.longitude);
    if (lat == null || lon == null) continue;
    const region = incidentRegionId(lat, lon);
    if (!region) continue;
    const acres = number(item.AcresBurned ?? item.acresBurned);
    const contained = number(item.PercentContained ?? item.percentContained);
    const facts = [
      acres != null ? `${Math.round(acres)} acres` : null,
      contained != null ? `${Math.round(contained)}% contained` : null,
      item.AdminUnit || item.adminUnit || null,
    ].filter(Boolean);
    const row = incidentRecord({
      id: item.UniqueId ?? item.uniqueId ?? item.Name ?? item.name,
      source: CALFIRE_SOURCE.id,
      sourceLabel: CALFIRE_SOURCE.label,
      agency: CALFIRE_SOURCE.agency,
      type: 'fire',
      typeDetail: item.Type || item.type || 'Wildfire',
      lat,
      lon,
      location: [item.Name ?? item.name, item.Location ?? item.location]
        .filter(Boolean)
        .join(' · '),
      area: item.County ? `${item.County} County` : (item.county ?? null),
      time: item.Updated ?? item.updated ?? item.Started ?? item.started,
      description: facts.join(' · ') || null,
      region,
      url: item.Url ?? item.url,
    });
    if (row) rows.push(row);
  }
  return rows;
}

export async function fetchCalFireIncidents({ fetchImpl, signal } = {}) {
  const payload = await fetchIncidentUpstream(CALFIRE_URL, {
    fetchImpl,
    signal,
    headers: { Accept: 'application/json' },
  });
  return parseCalFireIncidents(payload);
}
