/** Geotagged live streams: curated cameras, discovered streams, webcams and scanner links. */

import { suggestView } from '../views.js';
import { defineTool } from '../catalog.js';
import { AREA_SCHEMA, areaContains, resolveArea } from '../area.js';
import {
  LIMIT_SCHEMA,
  breakdown,
  breakdownPhrase,
  capRows,
  countNoun,
  isoTime,
} from '../results.js';
import {
  LIVE_OPS_REGIONS,
  LIVE_OPS_REGION_IDS,
  liveOpsRegion,
  regionArea,
} from '../../data/liveOpsRegions.js';
import {
  STREAM_KINDS,
  STREAM_SOURCES,
  sortStreams,
} from '../../layers/streams/records.js';

const REGION_SCHEMA = Object.freeze({
  type: 'string',
  enum: LIVE_OPS_REGION_IDS,
  description: `A LIVE OPS region: ${LIVE_OPS_REGIONS.map(
    (region) => `${region.id} (${region.name})`,
  ).join(', ')}.`,
});

const KIND_SCHEMA = Object.freeze({
  type: 'string',
  enum: STREAM_KINDS,
  description:
    'Keep only streams that play this way: youtube (an embedded YouTube live ' +
    'stream), hls (direct live video), mjpeg (motion JPEG) or link (opens on ' +
    'the provider site, which is how scanner directories and Windy webcams ' +
    'are listed).',
});

const SOURCE_SCHEMA = Object.freeze({
  type: 'string',
  enum: STREAM_SOURCES,
  description:
    'Keep only one source: registry (curated, verified 24/7 cameras), youtube ' +
    '(YouTube Data API discovery, needs YOUTUBE_API_KEY), windy (Windy ' +
    'webcams, needs WINDY_WEBCAMS_API_KEY) or scanner (Broadcastify ' +
    'directories, links only).',
});

const streamRow = (row) => ({
  id: row.id,
  title: row.title,
  kind: row.kind,
  source: row.sourceLabel ?? row.source ?? null,
  owner: row.owner ?? null,
  region: row.region ?? null,
  lat: row.lat,
  lon: row.lon,
  placement: row.placement ?? null,
  page_url: row.pageUrl ?? null,
  embed:
    row.embed?.type === 'youtube'
      ? { type: 'youtube', video_id: row.embed.videoId }
      : { type: row.embed?.type ?? row.kind, url: row.embed?.url ?? null },
  poster: row.poster ?? null,
  verified_at: row.verifiedAt ?? null,
  updated_at: isoTime(row.time),
  description: row.description ?? null,
  terms: row.terms ?? null,
  tags: Array.isArray(row.tags) ? row.tags : [],
});

const sourceRow = (source) => ({
  id: source.id,
  label: source.label ?? source.id,
  ok: source.ok === true,
  stale: source.stale === true,
  key_required: source.keyRequired === true,
  count: source.count ?? 0,
  refresh_seconds: Number.isFinite(source.refreshMs)
    ? Math.round(source.refreshMs / 1000)
    : null,
  fetched_at: isoTime(source.fetchedAt),
  error: source.error ?? null,
});

export const findLiveStreams = defineTool({
  name: 'find_live_streams',
  title: 'Live streams',
  description:
    'Public live video streams and webcams with a place on the map, as ' +
    'metadata: a curated registry of 24/7 cameras (embedded YouTube live ' +
    'streams and direct HLS video, each verified), YouTube live streams ' +
    'discovered near a LIVE OPS region when a YouTube Data API key is set, ' +
    'Windy webcams when a Windy key is set, and public-safety scanner ' +
    'directories as links. Give a region, an area, or both; optionally one ' +
    'kind or one source. Nothing plays until a stream is opened in God’s ' +
    'Eye View or on the provider’s page.',
  inputSchema: {
    type: 'object',
    properties: {
      region: REGION_SCHEMA,
      area: AREA_SCHEMA,
      kind: KIND_SCHEMA,
      source: SOURCE_SCHEMA,
      limit: LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requires: ['streams'],
  async run(args, { services, signal }) {
    const region = args.region ? liveOpsRegion(args.region) : null;
    const area = args.area
      ? await resolveArea(args.area, { services, signal })
      : region
        ? regionArea(region)
        : null;
    const snapshot = await services.streams.getSnapshotDetail({
      region: region?.id ?? null,
      kind: args.kind ?? null,
      signal,
    });
    const rows = sortStreams(
      snapshot.rows.filter(
        (row) =>
          (!args.kind || row.kind === args.kind) &&
          (!args.source || row.source === args.source) &&
          (!area || areaContains(area, row)),
      ),
    );
    const result = capRows(rows, args.limit);
    const kinds = breakdown(rows, 'kind');
    const where = area
      ? ` in ${area.label}`
      : ` across ${LIVE_OPS_REGIONS.map((entry) => entry.name).join(', ')}`;
    const keyless = snapshot.sources.filter(
      (source) => source.keyRequired === true,
    );
    const failing = snapshot.sources.filter(
      (source) =>
        source.ok === false &&
        source.keyRequired !== true &&
        source.error !== 'disabled',
    );
    const notes = [
      ...(snapshot.stale ? ['data may be stale'] : []),
      ...(keyless.length
        ? [`${keyless.map((source) => source.label).join(' and ')} need a key`]
        : []),
      ...(failing.length
        ? [
            `no live data from ${failing.map((source) => source.label).join(', ')}`,
          ]
        : []),
    ];
    return {
      summary:
        `${countNoun(rows.length, 'live stream')}${where}` +
        breakdownPhrase(kinds, 'kind') +
        (notes.length ? ` (${notes.join('; ')}).` : '.'),
      data: {
        view: suggestView(
          services,
          area
            ? { area, layers: ['streams'] }
            : {
                point: { lat: 36, lon: -119 },
                altitudeM: 1_500_000,
                layers: ['streams'],
              },
        ),
        region: region?.id ?? null,
        stale: snapshot.stale === true,
        fetched_at: isoTime(snapshot.fetchedAt),
        sources: snapshot.sources.map(sourceRow),
        by_kind: kinds,
        ...result,
        rows: result.rows.map(streamRow),
      },
    };
  },
});
