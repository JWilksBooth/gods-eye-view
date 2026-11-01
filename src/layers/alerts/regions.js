/**
 * @module layers/alerts/regions
 *
 * The Alerts layer's view of the LIVE OPS regions. `src/data/liveOpsRegions.js`
 * is the single source of truth for every region's id, public name, bounding
 * box and centre; this module adds only what the alert feeds need to decide
 * membership, keyed by region id (`ALERT_REGION_FEEDS`):
 *
 *   - `countyFips`: SAME/FIPS county codes NWS alerts carry in `geocode.SAME`
 *     (a leading zero plus the five-digit FIPS code) for the counties that
 *     overlap the region's box;
 *   - `ugcCounties`: the same counties as UGC county codes (`geocode.UGC`);
 *   - `nwsAreas`: the NWS `area` (state) codes whose active alerts are read;
 *   - `closureDistricts`: the Caltrans districts whose lane-closure files
 *     cover the region;
 *   - `airports`: IATA codes of the airports whose FAA status belongs to it;
 *   - `keywords`: names a statewide bulletin uses when it concerns the
 *     region, matched whole-word and case-insensitively.
 *
 * A region added to the LIVE OPS registry appears here automatically with no
 * alert-specific ids: NWS, CAL FIRE and the bounding-box feeds cover it, the
 * id-keyed feeds do not until an entry is added. Pure data and functions: no
 * Cesium, no DOM, no network, so the server proxy, the portable source, the
 * tools and the renderer all read one definition.
 */
import { LIVE_OPS_REGIONS } from '../../data/liveOpsRegions.js';

const frozenList = (values) => Object.freeze([...(values || [])]);

/** Alert-specific ids per LIVE OPS region. Public place names only. */
export const ALERT_REGION_FEEDS = Object.freeze({
  'los-angeles': Object.freeze({
    countyFips: frozenList(['006037', '006059', '006111']),
    ugcCounties: frozenList(['CAC037', 'CAC059', 'CAC111']),
    nwsAreas: frozenList(['CA']),
    closureDistricts: frozenList([7, 12]),
    airports: frozenList(['LAX', 'BUR', 'LGB', 'SNA']),
    keywords: frozenList([
      'Los Angeles',
      'L.A.',
      'LA County',
      'Orange County',
      'Long Beach',
      'Pasadena',
      'Santa Monica',
      'Burbank',
      'Glendale',
      'Malibu',
      'Torrance',
      'Santa Clarita',
      'Hollywood',
      'Inglewood',
      'Anaheim',
      'Santa Ana',
      'Irvine',
    ]),
  }),
  'sonoma-county': Object.freeze({
    countyFips: frozenList(['006097']),
    ugcCounties: frozenList(['CAC097']),
    nwsAreas: frozenList(['CA']),
    closureDistricts: frozenList([4]),
    airports: frozenList(['STS']),
    keywords: frozenList(['Sonoma County']),
  }),
  'sf-bay-area': Object.freeze({
    countyFips: frozenList([
      '006001',
      '006013',
      '006041',
      '006075',
      '006081',
      '006085',
    ]),
    ugcCounties: frozenList([
      'CAC001',
      'CAC013',
      'CAC041',
      'CAC075',
      'CAC081',
      'CAC085',
    ]),
    nwsAreas: frozenList(['CA']),
    closureDistricts: frozenList([4]),
    airports: frozenList(['SFO', 'OAK', 'SJC']),
    keywords: frozenList([
      'San Francisco',
      'Bay Area',
      'Oakland',
      'San Jose',
      'San José',
      'Berkeley',
      'Fremont',
      'Palo Alto',
      'San Mateo',
      'Marin County',
      'Santa Clara',
      'Alameda',
      'Contra Costa',
      'Hayward',
      'Concord',
      'Walnut Creek',
      'Sunnyvale',
      'Mountain View',
      'Redwood City',
      'Daly City',
      'San Rafael',
      'Livermore',
      'Milpitas',
    ]),
  }),
  'las-vegas': Object.freeze({
    countyFips: frozenList(['032003']),
    ugcCounties: frozenList(['NVC003']),
    nwsAreas: frozenList(['NV']),
    closureDistricts: frozenList([]),
    airports: frozenList(['LAS']),
    keywords: frozenList([
      'Las Vegas',
      'North Las Vegas',
      'Clark County',
      'Henderson',
      'Summerlin',
      'Nellis',
      'Lake Mead',
      'Red Rock Canyon',
    ]),
  }),
});

const NO_FEEDS = Object.freeze({
  countyFips: frozenList([]),
  ugcCounties: frozenList([]),
  nwsAreas: frozenList([]),
  closureDistricts: frozenList([]),
  airports: frozenList([]),
  keywords: frozenList([]),
});

/**
 * One alert region: the LIVE OPS region's `id`, `name`, `bbox` and centre
 * (as `anchor`, where bulletins without geometry gather) plus its feed ids.
 */
function alertRegionFrom(region) {
  const feeds = ALERT_REGION_FEEDS[region.id] || NO_FEEDS;
  return Object.freeze({
    id: region.id,
    name: region.name,
    bbox: region.bbox,
    anchor: region.center,
    countyFips: feeds.countyFips,
    ugcCounties: feeds.ugcCounties,
    nwsAreas: feeds.nwsAreas,
    closureDistricts: feeds.closureDistricts,
    airports: feeds.airports,
    keywords: feeds.keywords.length
      ? feeds.keywords
      : frozenList([region.name]),
  });
}

/** The regions in LIVE OPS display order. */
export const ALERT_REGIONS = Object.freeze(
  LIVE_OPS_REGIONS.map(alertRegionFrom),
);

/** Every region id, in display order. */
export const ALERT_REGION_IDS = Object.freeze(
  ALERT_REGIONS.map((entry) => entry.id),
);

const BY_ID = new Map(ALERT_REGIONS.map((entry) => [entry.id, entry]));

/** The region with this id (case-insensitive), or null. */
export function alertRegion(id) {
  return (
    BY_ID.get(
      String(id ?? '')
        .trim()
        .toLowerCase(),
    ) || null
  );
}

/** The NWS `area` (state) codes the regions need, deduplicated. */
export const ALERT_NWS_AREAS = Object.freeze([
  ...new Set(ALERT_REGIONS.flatMap((entry) => entry.nwsAreas)),
]);

/** The Caltrans districts whose lane-closure files the regions need. */
export const ALERT_CALTRANS_DISTRICTS = Object.freeze(
  [...new Set(ALERT_REGIONS.flatMap((entry) => entry.closureDistricts))].sort(
    (a, b) => a - b,
  ),
);

/**
 * Airports whose FAA status the layer shows, with the coordinates the globe
 * places their status at. IATA codes, as the FAA feed names them.
 */
export const ALERT_AIRPORTS = Object.freeze({
  LAX: Object.freeze({
    name: 'Los Angeles International',
    lat: 33.9416,
    lon: -118.4085,
  }),
  BUR: Object.freeze({
    name: 'Hollywood Burbank',
    lat: 34.2007,
    lon: -118.3587,
  }),
  LGB: Object.freeze({ name: 'Long Beach', lat: 33.8177, lon: -118.1516 }),
  SNA: Object.freeze({
    name: 'John Wayne–Orange County',
    lat: 33.6757,
    lon: -117.8682,
  }),
  SFO: Object.freeze({
    name: 'San Francisco International',
    lat: 37.6213,
    lon: -122.379,
  }),
  OAK: Object.freeze({
    name: 'Oakland International',
    lat: 37.7126,
    lon: -122.2197,
  }),
  SJC: Object.freeze({
    name: 'San José Mineta International',
    lat: 37.3639,
    lon: -121.9289,
  }),
  STS: Object.freeze({
    name: 'Charles M. Schulz–Sonoma County',
    lat: 38.5089,
    lon: -122.8128,
  }),
  LAS: Object.freeze({
    name: 'Harry Reid International',
    lat: 36.084,
    lon: -115.1537,
  }),
});

/**
 * Approximate county centroids by SAME/FIPS code, where an NWS alert that
 * names a county but has no shape yet is placed. Only counties whose centre
 * lies inside a region box are listed; elsewhere the alert waits for its
 * zone shapes. Degrees.
 */
export const ALERT_COUNTY_CENTROIDS = Object.freeze({
  '006037': Object.freeze({ lat: 34.32, lon: -118.22 }),
  '006059': Object.freeze({ lat: 33.7, lon: -117.76 }),
  '006097': Object.freeze({ lat: 38.53, lon: -122.93 }),
  '006001': Object.freeze({ lat: 37.65, lon: -121.92 }),
  '006013': Object.freeze({ lat: 37.92, lon: -121.95 }),
  '006041': Object.freeze({ lat: 38.05, lon: -122.72 }),
  '006075': Object.freeze({ lat: 37.76, lon: -122.44 }),
  '006081': Object.freeze({ lat: 37.43, lon: -122.33 }),
  '006085': Object.freeze({ lat: 37.23, lon: -121.7 }),
  '032003': Object.freeze({ lat: 36.21, lon: -115.01 }),
});

/** Whether a longitude/latitude lies inside a `[west, south, east, north]` box. */
export function bboxContains(bbox, lon, lat) {
  if (!Array.isArray(bbox) || !Number.isFinite(lon) || !Number.isFinite(lat))
    return false;
  const [west, south, east, north] = bbox;
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

/** Whether two `[west, south, east, north]` boxes overlap (touching counts). */
export function bboxIntersects(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/** Region ids whose box contains a point. */
export function regionsForPoint(lon, lat, regions = ALERT_REGIONS) {
  return regions
    .filter((entry) => bboxContains(entry.bbox, lon, lat))
    .map((entry) => entry.id);
}

/** Region ids whose box overlaps a `[west, south, east, north]` box. */
export function regionsForBbox(bbox, regions = ALERT_REGIONS) {
  return regions
    .filter((entry) => bboxIntersects(entry.bbox, bbox))
    .map((entry) => entry.id);
}

/** Region ids that claim any of these SAME/FIPS county codes. */
export function regionsForCountyFips(codes, regions = ALERT_REGIONS) {
  const wanted = new Set((codes || []).map((code) => String(code).trim()));
  if (!wanted.size) return [];
  return regions
    .filter((entry) => entry.countyFips.some((code) => wanted.has(code)))
    .map((entry) => entry.id);
}

/** Region ids that claim any of these UGC county codes (`CAC037`). */
export function regionsForUgc(codes, regions = ALERT_REGIONS) {
  const wanted = new Set(
    (codes || []).map((code) => String(code).trim().toUpperCase()),
  );
  if (!wanted.size) return [];
  return regions
    .filter((entry) => entry.ugcCounties.some((code) => wanted.has(code)))
    .map((entry) => entry.id);
}

/** Region ids whose airports include this IATA code. */
export function regionsForAirport(code, regions = ALERT_REGIONS) {
  const wanted = String(code ?? '')
    .trim()
    .toUpperCase();
  return regions
    .filter((entry) => entry.airports.includes(wanted))
    .map((entry) => entry.id);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Region ids whose keywords appear in free text. Whole-word and
 * case-insensitive, so "Clark County" matches "Clark County officials" but a
 * keyword inside a longer word does not.
 */
export function regionsForText(text, regions = ALERT_REGIONS) {
  const haystack = String(text ?? '');
  if (!haystack.trim()) return [];
  return regions
    .filter((entry) =>
      entry.keywords.some((keyword) =>
        new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}])`,
          'iu',
        ).test(haystack),
      ),
    )
    .map((entry) => entry.id);
}

/** Region ids whose NWS areas include this state code, for statewide bulletins. */
export function regionsForState(state, regions = ALERT_REGIONS) {
  const wanted = String(state ?? '')
    .trim()
    .toUpperCase();
  return regions
    .filter((entry) => entry.nwsAreas.includes(wanted))
    .map((entry) => entry.id);
}
