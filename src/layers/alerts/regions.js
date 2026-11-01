/**
 * @module layers/alerts/regions
 *
 * The four regions the Alerts layer follows, as named bounding boxes. Pure
 * data: no Cesium, no DOM, no network, so the server proxy, the portable
 * source, the tools and the renderer all read one definition.
 *
 * Each region carries what its feeds need to decide membership:
 *   - `bbox` `[west, south, east, north]` in degrees, for geometry tests;
 *   - `anchor`, where a bulletin with no geometry of its own is placed;
 *   - `countyFips`, the SAME/FIPS county codes NWS alerts carry in
 *     `geocode.SAME` (a leading zero plus the 5-digit FIPS code);
 *   - `ugcCounties`, the UGC county codes NWS alerts carry in `geocode.UGC`;
 *   - `states`, the NWS `area` codes that cover the region;
 *   - `caltransDistricts`, the Caltrans districts whose lane-closure files
 *     cover the region;
 *   - `airports`, the IATA codes of the airports whose FAA status belongs
 *     to the region;
 *   - `keywords`, place names an agency bulletin mentions when it concerns
 *     the region (matched case-insensitively against headline and body).
 *
 * The owner unifies this with the application's region registry at merge
 * time; nothing else in the layer family defines a region.
 */

const region = (definition) =>
  Object.freeze({
    ...definition,
    bbox: Object.freeze([...definition.bbox]),
    anchor: Object.freeze({ ...definition.anchor }),
    countyFips: Object.freeze([...definition.countyFips]),
    ugcCounties: Object.freeze([...definition.ugcCounties]),
    states: Object.freeze([...definition.states]),
    caltransDistricts: Object.freeze([...definition.caltransDistricts]),
    airports: Object.freeze([...definition.airports]),
    keywords: Object.freeze([...definition.keywords]),
  });

/** The regions in presentation order. Ids are stable; names are public place names. */
export const ALERT_REGIONS = Object.freeze([
  region({
    id: 'los-angeles',
    name: 'Los Angeles',
    bbox: [-118.95, 33.3, -117.65, 34.85],
    anchor: { lat: 34.0522, lon: -118.2437 },
    countyFips: ['006037'],
    ugcCounties: ['CAC037'],
    states: ['CA'],
    caltransDistricts: [7],
    airports: ['LAX', 'BUR', 'LGB'],
    keywords: [
      'Los Angeles',
      'L.A.',
      'LA County',
      'Hollywood',
      'Pasadena',
      'Long Beach',
      'Santa Monica',
      'Burbank',
      'Glendale',
      'Palmdale',
      'Lancaster',
      'Malibu',
      'Torrance',
      'Pomona',
      'San Fernando',
      'Santa Clarita',
      'Compton',
      'Inglewood',
      'Altadena',
      'Topanga',
    ],
  }),
  region({
    id: 'sonoma-county',
    name: 'Sonoma County',
    bbox: [-123.55, 38.1, -122.35, 38.86],
    anchor: { lat: 38.4405, lon: -122.7141 },
    countyFips: ['006097'],
    ugcCounties: ['CAC097'],
    states: ['CA'],
    caltransDistricts: [4],
    airports: ['STS'],
    keywords: [
      'Sonoma',
      'Santa Rosa',
      'Petaluma',
      'Healdsburg',
      'Sebastopol',
      'Windsor',
      'Rohnert Park',
      'Cotati',
      'Cloverdale',
      'Guerneville',
      'Bodega Bay',
      'Jenner',
      'Geyserville',
      'Russian River',
    ],
  }),
  region({
    id: 'san-francisco-bay-area',
    name: 'San Francisco Bay Area',
    bbox: [-123.55, 36.85, -121.2, 38.9],
    anchor: { lat: 37.7749, lon: -122.4194 },
    countyFips: [
      '006001',
      '006013',
      '006041',
      '006055',
      '006075',
      '006081',
      '006085',
      '006095',
      '006097',
    ],
    ugcCounties: [
      'CAC001',
      'CAC013',
      'CAC041',
      'CAC055',
      'CAC075',
      'CAC081',
      'CAC085',
      'CAC095',
      'CAC097',
    ],
    states: ['CA'],
    caltransDistricts: [4],
    airports: ['SFO', 'OAK', 'SJC'],
    keywords: [
      'San Francisco',
      'Bay Area',
      'Oakland',
      'San Jose',
      'Berkeley',
      'Fremont',
      'Palo Alto',
      'San Mateo',
      'Marin',
      'Napa',
      'Solano',
      'Vallejo',
      'Richmond',
      'Hayward',
      'Santa Clara',
      'Alameda',
      'Contra Costa',
      'Concord',
      'Walnut Creek',
      'Sunnyvale',
      'Mountain View',
      'Redwood City',
      'Daly City',
      'Sausalito',
      'San Rafael',
      'Novato',
      'Fairfield',
      'Livermore',
      'Antioch',
      'Milpitas',
    ],
  }),
  region({
    id: 'las-vegas',
    name: 'Las Vegas',
    bbox: [-115.6, 35.7, -114.6, 36.6],
    anchor: { lat: 36.1699, lon: -115.1398 },
    countyFips: ['032003'],
    ugcCounties: ['NVC003'],
    states: ['NV'],
    caltransDistricts: [],
    airports: ['LAS'],
    keywords: [
      'Las Vegas',
      'Clark County',
      'Henderson',
      'North Las Vegas',
      'Boulder City',
      'Summerlin',
      'Paradise',
      'Spring Valley',
      'Enterprise',
      'Mesquite',
      'Laughlin',
      'Lake Mead',
      'Nellis',
      'Red Rock Canyon',
    ],
  }),
]);

/** Every region id, in presentation order. */
export const ALERT_REGION_IDS = Object.freeze(
  ALERT_REGIONS.map((entry) => entry.id),
);

const BY_ID = new Map(ALERT_REGIONS.map((entry) => [entry.id, entry]));

/** The region with this id, or null. */
export function alertRegion(id) {
  return BY_ID.get(String(id ?? '')) || null;
}

/** The NWS `area` (state) codes the regions need, deduplicated. */
export const ALERT_NWS_AREAS = Object.freeze([
  ...new Set(ALERT_REGIONS.flatMap((entry) => entry.states)),
]);

/** The Caltrans districts whose lane-closure feeds the regions need. */
export const ALERT_CALTRANS_DISTRICTS = Object.freeze([
  ...new Set(ALERT_REGIONS.flatMap((entry) => entry.caltransDistricts)),
]);

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
 * names counties but carries no geometry is placed. Degrees.
 */
export const ALERT_COUNTY_CENTROIDS = Object.freeze({
  '006037': Object.freeze({ lat: 34.32, lon: -118.22 }),
  '006097': Object.freeze({ lat: 38.53, lon: -122.93 }),
  '006001': Object.freeze({ lat: 37.65, lon: -121.92 }),
  '006013': Object.freeze({ lat: 37.92, lon: -121.95 }),
  '006041': Object.freeze({ lat: 38.05, lon: -122.75 }),
  '006055': Object.freeze({ lat: 38.51, lon: -122.33 }),
  '006075': Object.freeze({ lat: 37.76, lon: -122.44 }),
  '006081': Object.freeze({ lat: 37.43, lon: -122.33 }),
  '006085': Object.freeze({ lat: 37.23, lon: -121.7 }),
  '006095': Object.freeze({ lat: 38.27, lon: -121.94 }),
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

/**
 * Region ids whose keywords appear in free text. Word-bounded and
 * case-insensitive, so "Sonoma" matches "Sonoma County" but not "Sonomap".
 */
export function regionsForText(text, regions = ALERT_REGIONS) {
  const haystack = String(text ?? '');
  if (!haystack.trim()) return [];
  return regions
    .filter((entry) =>
      entry.keywords.some((keyword) =>
        new RegExp(
          `(?<![\\p{L}\\p{N}])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
          'iu',
        ).test(haystack),
      ),
    )
    .map((entry) => entry.id);
}

/** Region ids whose states include this code, for statewide bulletins. */
export function regionsForState(state, regions = ALERT_REGIONS) {
  const wanted = String(state ?? '')
    .trim()
    .toUpperCase();
  return regions
    .filter((entry) => entry.states.includes(wanted))
    .map((entry) => entry.id);
}
