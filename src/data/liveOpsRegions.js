/**
 * The LIVE OPS region registry: the metro areas the console can switch to.
 *
 * One entry describes everything a region needs, so adding a region is one
 * entry here plus a camera pack and incident sources where the region's
 * agencies publish them. The registry is portable: the browser panel, the
 * Node providers and the MCP tools read it, so it imports nothing.
 *
 * Fields:
 * - `id`: stable identifier used in `/api/incidents?region=`, the LIVE OPS
 *   buttons and the `live_ops_region` tool.
 * - `name`: the region's public name, shown as it is.
 * - `bbox`: `[west, south, east, north]` in degrees. Incidents are kept to
 *   this box, the camera flight frames it, and tools report it.
 * - `center`: a representative point for place-sized requests.
 * - `cameras`: which CCTV packs cover the region (`caltransDistricts` are the
 *   Caltrans districts that must be in `CCTV_CALTRANS_DISTRICTS`; `packs` the
 *   `sourceKind` values of the packs). Informational: the camera catalog
 *   itself is global and filtered by `bbox`.
 * - `incidents`: the incident sources that cover the region, by the source ids
 *   `server/providers/incidents` registers.
 * - `chpCenters`: the CHP communications centers whose logs cover the region.
 * - `news`: the Google News / GDELT search query for the region's headlines.
 */
export const LIVE_OPS_REGIONS = Object.freeze([
  Object.freeze({
    id: 'los-angeles',
    name: 'Los Angeles',
    bbox: Object.freeze([-118.95, 33.6, -117.65, 34.45]),
    center: Object.freeze({ lat: 34.0537, lon: -118.2428 }),
    cameras: Object.freeze({
      caltransDistricts: Object.freeze([7]),
      packs: Object.freeze(['caltrans-open-data']),
    }),
    incidents: Object.freeze(['chp', 'lafd-alerts']),
    chpCenters: Object.freeze(['LACC']),
    news: 'Los Angeles',
  }),
  Object.freeze({
    id: 'sonoma-county',
    name: 'Sonoma County',
    bbox: Object.freeze([-123.55, 38.1, -122.35, 38.86]),
    center: Object.freeze({ lat: 38.44, lon: -122.71 }),
    cameras: Object.freeze({
      caltransDistricts: Object.freeze([4]),
      packs: Object.freeze(['caltrans-open-data']),
    }),
    incidents: Object.freeze(['chp', 'calfire']),
    chpCenters: Object.freeze(['GGCC']),
    news: 'Sonoma County',
  }),
  Object.freeze({
    id: 'sf-bay-area',
    name: 'San Francisco Bay Area',
    bbox: Object.freeze([-122.75, 37.15, -121.6, 38.1]),
    center: Object.freeze({ lat: 37.7793, lon: -122.4193 }),
    cameras: Object.freeze({
      caltransDistricts: Object.freeze([4]),
      packs: Object.freeze(['caltrans-open-data']),
    }),
    incidents: Object.freeze(['chp', 'datasf-police', 'datasf-fire']),
    chpCenters: Object.freeze(['GGCC']),
    news: 'San Francisco Bay Area',
  }),
  Object.freeze({
    id: 'las-vegas',
    name: 'Las Vegas',
    bbox: Object.freeze([-115.45, 35.9, -114.85, 36.4]),
    center: Object.freeze({ lat: 36.1699, lon: -115.1398 }),
    cameras: Object.freeze({
      caltransDistricts: Object.freeze([]),
      packs: Object.freeze(['nvroads-open-data']),
    }),
    incidents: Object.freeze(['nvroads']),
    chpCenters: Object.freeze([]),
    news: 'Las Vegas',
  }),
]);

/** The layers the console turns on for a region: cameras, incidents, traffic. */
export const LIVE_OPS_LAYERS = Object.freeze(['cctv', 'incidents', 'traffic']);

const BY_ID = new Map(LIVE_OPS_REGIONS.map((region) => [region.id, region]));

/** The region with this id, or null. Ids compare case-insensitively. */
export function liveOpsRegion(id) {
  return (
    BY_ID.get(
      String(id ?? '')
        .trim()
        .toLowerCase(),
    ) ?? null
  );
}

/** Every region id, in display order. */
export const LIVE_OPS_REGION_IDS = Object.freeze(
  LIVE_OPS_REGIONS.map((region) => region.id),
);

/** True when a point lies inside the region's bounding box. */
export function regionContains(region, { lat, lon } = {}) {
  if (!region || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const [west, south, east, north] = region.bbox;
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

/** The first region whose box contains a point, or null. */
export function regionForPoint(point) {
  return (
    LIVE_OPS_REGIONS.find((region) => regionContains(region, point)) ?? null
  );
}

/** A region's box as the `area` the tools take. */
export function regionArea(region) {
  const [west, south, east, north] = region.bbox;
  return { label: region.name, west, south, east, north };
}
