/** Presentation model for live streams. Pure: no Cesium, no DOM. */
import { msg } from '../../i18n/marker.js';
import { STREAM_KINDS, STREAM_SOURCES } from './records.js';

export const STREAM_OVERLAY_SOURCE_ID = 'streams';
export const STREAM_OVERLAY_COHORT_LIMIT = 48;
export const STREAM_OVERLAY_COLLISION_CAPACITY = 24;

/**
 * The theme token each kind is drawn with, and the colour used when a
 * token is not defined (the event map's `--event-stream` for anything
 * that plays in place; a muted tone for link-outs). The layer reads the
 * token from the page; this model never touches the DOM.
 */
export const STREAM_KIND_TOKENS = Object.freeze({
  youtube: Object.freeze({ token: '--event-stream', fallback: '#7cf5d2' }),
  hls: Object.freeze({ token: '--event-stream', fallback: '#7cf5d2' }),
  mjpeg: Object.freeze({ token: '--event-stream', fallback: '#7cf5d2' }),
  link: Object.freeze({ token: '--text-muted', fallback: '#9aa4ad' }),
});

/** Short English labels per kind; the UI translates them with t(). */
export const STREAM_KIND_LABELS = Object.freeze({
  youtube: msg('YouTube live'),
  hls: msg('Live video (HLS)'),
  mjpeg: msg('Motion JPEG'),
  link: msg('Link out'),
});

/** How a point was placed, where it is not the camera's own position. */
export const STREAM_PLACEMENT_LABELS = Object.freeze({
  exact: null,
  approximate: msg('Position is approximate'),
  'region-centre': msg('Placed at the region centre'),
});

/**
 * The accent for a kind. `readToken(name)` returns the page's value of a
 * CSS custom property, or an empty string when it is not defined.
 */
export function streamAccent(kind, readToken = () => '') {
  const spec = STREAM_KIND_TOKENS[kind] || STREAM_KIND_TOKENS.link;
  const value = String(readToken(spec.token) || '').trim();
  return value || spec.fallback;
}

const SOURCE_RANK = new Map(
  STREAM_SOURCES.map((source, index) => [source, STREAM_SOURCES.length - index]),
);
const KIND_RANK = new Map(
  STREAM_KINDS.map((kind, index) => [kind, STREAM_KINDS.length - index]),
);

/** Curated and playable streams win the ambient-label cohort. */
export function streamPriority(row) {
  return (SOURCE_RANK.get(row.source) ?? 0) * 10 + (KIND_RANK.get(row.kind) ?? 0);
}

/**
 * The ambient label for one stream: its title, coloured by kind. Labels
 * never start media; they only say what a point is.
 */
export function createStreamOverlayEntry({ row, position, title, accent }) {
  return {
    id: `stream:${row.id}`,
    position,
    variant: 'label',
    title,
    accent,
    priority: streamPriority(row),
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

/** Keep the highest-priority streams, with stable identity as the tie-break. */
export function selectStreamOverlayCohort(
  entries,
  limit = STREAM_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(STREAM_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
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
 * JSON-safe analyst record for one stream (the analyst query engine seam).
 * Missing values are null, never undefined.
 */
export function mapStreamAnalystRecord(row) {
  return {
    id: row.id,
    title: row.title ?? null,
    kind: row.kind ?? null,
    source: row.sourceLabel ?? row.source ?? null,
    owner: row.owner ?? null,
    region: row.region ?? null,
    placement: row.placement ?? null,
    lat: Number.isFinite(row.lat) ? row.lat : null,
    lon: Number.isFinite(row.lon) ? row.lon : null,
    pageUrl: row.pageUrl ?? null,
    verifiedAt: row.verifiedAt ?? null,
    timeMs: Number.isFinite(row.time) ? row.time : null,
  };
}
