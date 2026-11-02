/** Live incidents and the LIVE OPS region console. */

import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
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
  liveOpsRegionLayers,
  regionArea,
} from '../../data/liveOpsRegions.js';
import {
  INCIDENT_TYPES,
  sortIncidentsNewestFirst,
} from '../../layers/incidents/records.js';

const REGION_SCHEMA = Object.freeze({
  type: 'string',
  enum: LIVE_OPS_REGION_IDS,
  description: `A LIVE OPS region: ${LIVE_OPS_REGIONS.map(
    (region) => `${region.id} (${region.name})`,
  ).join(', ')}.`,
});

const TYPE_SCHEMA = Object.freeze({
  type: 'string',
  enum: INCIDENT_TYPES,
  description: 'Keep only incidents of this type.',
});

const incidentRow = (row) => ({
  id: row.id,
  type: row.type,
  type_detail: row.typeDetail ?? null,
  agency: row.agency ?? null,
  source: row.sourceLabel ?? row.source ?? null,
  location: row.location ?? null,
  area: row.area ?? null,
  region: row.region ?? null,
  lat: row.lat,
  lon: row.lon,
  time: isoTime(row.time),
  description: row.description ?? null,
  url: row.url ?? null,
});

const sourceRow = (source) => ({
  id: source.id,
  label: source.label ?? source.id,
  ok: source.ok === true,
  stale: source.stale === true,
  count: source.count ?? 0,
  refresh_seconds: Number.isFinite(source.refreshMs)
    ? Math.round(source.refreshMs / 1000)
    : null,
  fetched_at: isoTime(source.fetchedAt),
  error: source.error ?? null,
});

export const getIncidents = defineTool({
  name: 'get_incidents',
  title: 'Live incidents',
  description:
    'Live police, fire, EMS and traffic incidents reported by public agency ' +
    'feeds (California Highway Patrol CAD, DataSF dispatched calls, LAFD ' +
    'alerts, CAL FIRE, Nevada 511 events) in the LIVE OPS regions, newest ' +
    'first. Give a region, an area, or both; optionally one incident type.',
  inputSchema: {
    type: 'object',
    properties: {
      region: REGION_SCHEMA,
      area: AREA_SCHEMA,
      type: TYPE_SCHEMA,
      limit: LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requires: ['incidents'],
  async run(args, { services, signal }) {
    const region = args.region ? liveOpsRegion(args.region) : null;
    const area = args.area
      ? await resolveArea(args.area, { services, signal })
      : region
        ? regionArea(region)
        : null;
    const snapshot = await services.incidents.getSnapshotDetail({
      region: region?.id ?? null,
      signal,
    });
    const rows = sortIncidentsNewestFirst(
      snapshot.rows.filter(
        (row) =>
          (!args.type || row.type === args.type) &&
          (!area || areaContains(area, row)),
      ),
    );
    const result = capRows(rows, args.limit);
    const types = breakdown(rows, 'type');
    const where = area
      ? ` in ${area.label}`
      : ` across ${LIVE_OPS_REGIONS.map((entry) => entry.name).join(', ')}`;
    const failing = snapshot.sources.filter(
      (source) => source.ok === false && source.error !== 'disabled',
    );
    const notes = [
      ...(snapshot.stale ? ['data may be stale'] : []),
      ...(failing.length
        ? [
            `no live data from ${failing.map((source) => source.label).join(', ')}`,
          ]
        : []),
    ];
    return {
      summary:
        `${countNoun(rows.length, 'live incident')}${where}` +
        breakdownPhrase(types, 'type') +
        (notes.length ? ` (${notes.join('; ')}).` : '.'),
      data: {
        view: suggestView(
          services,
          area
            ? { area, layers: ['incidents'] }
            : {
                point: { lat: 36, lon: -119 },
                altitudeM: 1_500_000,
                layers: ['incidents'],
              },
        ),
        region: region?.id ?? null,
        stale: snapshot.stale === true,
        fetched_at: isoTime(snapshot.fetchedAt),
        sources: snapshot.sources.map(sourceRow),
        by_type: types,
        ...result,
        rows: result.rows.map(incidentRow),
      },
    };
  },
});

const SECTION_LIMIT = 10;

export const liveOpsRegionTool = defineTool({
  name: 'live_ops_region',
  title: 'LIVE OPS region console',
  description:
    'Everything the LIVE OPS console shows for one region in one call: its ' +
    'public cameras, live incidents and latest headlines, plus the view that ' +
    'opens the region with cameras, incidents, traffic and live transit on. ' +
    'Regions: ' +
    LIVE_OPS_REGIONS.map((region) => `${region.id} (${region.name})`).join(
      ', ',
    ) +
    '.',
  inputSchema: {
    type: 'object',
    properties: {
      region: REGION_SCHEMA,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: `Most cameras and incidents to list (default ${SECTION_LIMIT}).`,
      },
    },
    required: ['region'],
    additionalProperties: false,
  },
  requires: ['liveOps'],
  async run(args, { services, signal, tools }) {
    const region = liveOpsRegion(args.region);
    if (!region)
      throw new ToolError('invalid_arguments', `Unknown region ${args.region}`);
    const limit = args.limit ?? SECTION_LIMIT;
    const area = regionArea(region);
    const areaArgument = { bbox: [...region.bbox] };
    const sections = [
      {
        key: 'cameras',
        tool: 'find_cctv_cameras',
        args: { area: areaArgument, limit },
      },
      {
        key: 'incidents',
        tool: 'get_incidents',
        args: { region: region.id, limit },
      },
    ].filter((section) => tools.has(section.tool));
    const [headlines, ...answers] = await Promise.allSettled([
      services.liveOps.getHeadlines(region.id, { signal }),
      ...sections.map((section) => tools.call(section.tool, section.args)),
    ]);
    signal?.throwIfAborted();
    const data = {
      region: region.id,
      name: region.name,
      bbox: [...region.bbox],
      center: { ...region.center },
      view: suggestView(services, {
        area,
        layers: liveOpsRegionLayers(region),
      }),
    };
    const lines = [];
    sections.forEach((section, index) => {
      const answer = answers[index];
      if (answer.status === 'fulfilled') {
        data[section.key] = answer.value.data;
        lines.push(answer.value.summary);
      } else {
        const known = answer.reason instanceof ToolError;
        data[section.key] = {
          unavailable: true,
          reason: known ? answer.reason.message : 'unavailable right now',
        };
      }
    });
    if (headlines.status === 'fulfilled') {
      const articles = headlines.value.articles.slice(0, limit);
      data.headlines = {
        status: headlines.value.status,
        source: headlines.value.source,
        query: headlines.value.query,
        articles: articles.map((article) => ({
          title: article.title,
          url: article.url,
          source: article.domain ?? null,
          published_at: article.publishedAt ?? null,
        })),
      };
      lines.push(
        `${countNoun(articles.length, 'headline')} for ${region.name}.`,
      );
    } else {
      data.headlines = { unavailable: true, reason: 'unavailable right now' };
    }
    return {
      summary: `${region.name} LIVE OPS: ${lines.join(' ') || 'no section answered.'}`,
      data,
    };
  },
});
