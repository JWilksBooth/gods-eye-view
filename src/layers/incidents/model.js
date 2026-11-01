/** Presentation model for live incidents. Pure: no Cesium, no DOM. */
import { msg } from '../../i18n/marker.js';

export const INCIDENT_OVERLAY_SOURCE_ID = 'incidents';
export const INCIDENT_OVERLAY_COHORT_LIMIT = 64;
export const INCIDENT_OVERLAY_COLLISION_CAPACITY = 32;

/** CSS accent per incident type (the point color uses the same values). */
export const INCIDENT_TYPE_ACCENTS = Object.freeze({
  traffic: '#ffb300',
  fire: '#ff3b30',
  medical: '#ff5fa2',
  police: '#4f8cff',
  hazard: '#ff7a00',
  closure: '#b388ff',
  other: '#9aa4ad',
});

/** Short English labels per type; the UI translates them with t(). */
export const INCIDENT_TYPE_LABELS = Object.freeze({
  traffic: msg('Traffic'),
  fire: msg('Fire'),
  medical: msg('Medical'),
  police: msg('Police'),
  hazard: msg('Hazard'),
  closure: msg('Closure'),
  other: msg('Other'),
});

export function incidentAccent(type) {
  return INCIDENT_TYPE_ACCENTS[type] || INCIDENT_TYPE_ACCENTS.other;
}

/** Rows reported within the window, newest first; undated rows are kept. */
export function recentIncidents(rows, nowMs, windowMs) {
  return rows.filter((row) => row.time == null || nowMs - row.time <= windowMs);
}

/**
 * The ambient label for one incident: the type and where it is. Rows are
 * ranked newest first so the freshest incidents win the cohort.
 */
export function createIncidentOverlayEntry({ row, position, title }) {
  return {
    id: `incident:${row.id}`,
    position,
    variant: 'label',
    title,
    accent: incidentAccent(row.type),
    priority: Number.isFinite(row.time) ? Math.floor(row.time / 1000) : 0,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the newest incidents, with stable identity as the tie-break. */
export function selectIncidentOverlayCohort(
  entries,
  limit = INCIDENT_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(INCIDENT_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * JSON-safe analyst record for one incident (the analyst query engine seam).
 * Missing values are null, never undefined.
 */
export function mapIncidentAnalystRecord(row) {
  return {
    id: row.id,
    type: row.type,
    typeDetail: row.typeDetail ?? null,
    agency: row.agency ?? null,
    source: row.sourceLabel ?? row.source ?? null,
    location: row.location ?? null,
    area: row.area ?? null,
    region: row.region ?? null,
    lat: Number.isFinite(row.lat) ? row.lat : null,
    lon: Number.isFinite(row.lon) ? row.lon : null,
    timeMs: Number.isFinite(row.time) ? row.time : null,
    description: row.description ?? null,
  };
}
