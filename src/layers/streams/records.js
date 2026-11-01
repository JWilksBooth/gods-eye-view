/**
 * The one live-stream shape every source normalizes to, and the validation
 * the browser applies before a snapshot can replace what it draws.
 *
 * Portable: no Cesium, DOM, Node or i18n. The server providers build rows
 * with `streamRecord`; the layer, the event-map adapter, the tools and the
 * tests read them. A row is only ever metadata: where a stream is, who
 * publishes it and how it would play. Nothing here fetches media.
 *
 * A row is `{ id, source, sourceLabel, title, lat, lon, region, kind, embed,
 * pageUrl, poster, owner, terms, placement, verifiedAt, time, description,
 * tags }`:
 * - `id` is stable across refreshes (`<source>:<upstream id>`).
 * - `kind` is one of STREAM_KINDS and `embed` is what
 *   `src/layers/streams/embed.js` turns into a player: `{ type: 'youtube',
 *   videoId }` or `{ type: 'hls'|'mjpeg'|'link', url }`.
 * - `placement` says how the point was placed: `exact` (the camera's own
 *   position), `approximate` (a curated vantage near the view) or
 *   `region-centre` (a discovered stream without coordinates, placed at the
 *   centre of the LIVE OPS region it was found near).
 * - `verifiedAt` is the ISO date the entry was last checked, or null.
 */
import {
  isYouTubeVideoId,
  youtubePosterUrl,
  youtubeWatchUrl,
} from './embed.js';

export const STREAM_KINDS = Object.freeze(['youtube', 'hls', 'mjpeg', 'link']);
export const STREAM_SOURCES = Object.freeze([
  'registry',
  'youtube',
  'windy',
  'scanner',
]);
export const STREAM_PLACEMENTS = Object.freeze([
  'exact',
  'approximate',
  'region-centre',
]);

const KIND_SET = new Set(STREAM_KINDS);
const SOURCE_SET = new Set(STREAM_SOURCES);
const PLACEMENT_SET = new Set(STREAM_PLACEMENTS);

const MAX_TEXT = 200;

/** A trimmed, single-line string capped at `max` characters, or null. */
export function streamText(value, max = MAX_TEXT) {
  if (value == null || typeof value === 'boolean') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/** Epoch milliseconds for a date-like value, or null. */
export function streamTime(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** An https URL without credentials as text, or null. */
export function streamUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD` for a date-like value, or null. */
export function streamDate(value) {
  const ms = streamTime(value);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

/** The embed descriptor a kind and its id or URL make, or null. */
export function streamEmbedFor(kind, { videoId, url } = {}) {
  if (kind === 'youtube')
    return isYouTubeVideoId(videoId) ? { type: 'youtube', videoId } : null;
  const href = streamUrl(url);
  return KIND_SET.has(kind) && href ? { type: kind, url: href } : null;
}

/**
 * Build one normalized row. Returns null when the row has no usable
 * identity, position or embed, so a source can skip it.
 */
export function streamRecord({
  id,
  source,
  sourceLabel,
  title,
  lat,
  lon,
  region = null,
  kind,
  videoId = null,
  url = null,
  pageUrl = null,
  poster = null,
  owner = null,
  terms = null,
  placement = 'exact',
  verifiedAt = null,
  time = null,
  description = null,
  tags = [],
} = {}) {
  const upstreamId = streamText(id, 120);
  const sourceId = streamText(source, 40);
  const latitude = Number(lat);
  const longitude = Number(lon);
  const embed = streamEmbedFor(kind, { videoId, url });
  if (
    !upstreamId ||
    !sourceId ||
    !SOURCE_SET.has(sourceId) ||
    !embed ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  const page =
    streamUrl(pageUrl) ||
    (embed.type === 'youtube' ? youtubeWatchUrl(embed.videoId) : embed.url);
  return {
    id: `${sourceId}:${upstreamId}`,
    source: sourceId,
    sourceLabel: streamText(sourceLabel, 80) || sourceId,
    title: streamText(title, 160) || upstreamId,
    lat: Math.round(latitude * 1e6) / 1e6,
    lon: Math.round(longitude * 1e6) / 1e6,
    region: streamText(region, 40),
    kind: embed.type,
    embed,
    pageUrl: page,
    poster:
      streamUrl(poster) ||
      (embed.type === 'youtube' ? youtubePosterUrl(embed.videoId) : null),
    owner: streamText(owner, 120),
    terms: streamText(terms, 400),
    placement: PLACEMENT_SET.has(placement) ? placement : 'approximate',
    verifiedAt: streamDate(verifiedAt),
    time: streamTime(time),
    description: streamText(description, 400),
    tags: Array.isArray(tags)
      ? [...new Set(tags.map((tag) => streamText(tag, 40)).filter(Boolean))]
      : [],
  };
}

const SOURCE_RANK = new Map(
  STREAM_SOURCES.map((source, index) => [source, index]),
);
const KIND_RANK = new Map(STREAM_KINDS.map((kind, index) => [kind, index]));

/**
 * Curated rows first, then discovered, then link-outs; playable kinds before
 * links; then by title and id so the order never flickers.
 */
export function sortStreams(rows) {
  return rows
    .slice()
    .sort(
      (a, b) =>
        (SOURCE_RANK.get(a.source) ?? 9) - (SOURCE_RANK.get(b.source) ?? 9) ||
        (KIND_RANK.get(a.kind) ?? 9) - (KIND_RANK.get(b.kind) ?? 9) ||
        String(a.title).localeCompare(String(b.title)) ||
        String(a.id).localeCompare(String(b.id)),
    );
}

/**
 * Validate a `/api/streams` payload. Returns null when the payload is not a
 * snapshot at all; individually malformed rows are dropped, since one bad
 * row must never blank the layer.
 * @returns {{rows: object[], sources: object[], stale: boolean, fetchedAt: number|null, region: string|null}|null}
 */
export function normalizeStreamSnapshot(payload) {
  if (!payload || !Array.isArray(payload.rows)) return null;
  const rows = [];
  const seen = new Set();
  for (const raw of payload.rows) {
    if (!raw || typeof raw !== 'object') continue;
    const [source, ...rest] = String(raw.id || '').split(':');
    const row = streamRecord({
      ...raw,
      id: rest.join(':'),
      source: raw.source || source,
      kind: raw.kind || raw.embed?.type,
      videoId: raw.embed?.videoId ?? raw.videoId ?? null,
      url: raw.embed?.url ?? raw.url ?? null,
    });
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  const sources = Array.isArray(payload.sources)
    ? payload.sources
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => ({
          id: streamText(entry.id, 40),
          label: streamText(entry.label, 80),
          ok: entry.ok === true,
          stale: entry.stale === true,
          keyRequired: entry.keyRequired === true,
          count: Number.isFinite(entry.count) ? entry.count : 0,
          fetchedAt: Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : null,
          refreshMs: Number.isFinite(entry.refreshMs) ? entry.refreshMs : null,
          error: streamText(entry.error, 160),
        }))
        .filter((entry) => entry.id)
    : [];
  return {
    rows,
    sources,
    stale: payload.stale === true,
    fetchedAt: Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : null,
    region: streamText(payload.region, 40),
  };
}
