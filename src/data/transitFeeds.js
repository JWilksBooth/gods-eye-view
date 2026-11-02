import { greatCircleKm } from '../geoDistance.js';
import { sf511RouteLabel, sf511RouteMode } from './sf511Operators.js';

/**
 * @module transitFeeds
 * @description Registry of keyless, openly licensed GTFS-Realtime
 * VehiclePositions feeds the Transit layer can show.
 *
 * Every entry here is a URL the SERVER fetches — the browser only ever asks
 * `/api/transit/vehicles/<id>` for a registered id (see SECURITY.md: proxies
 * never fetch client-supplied URLs). Adding a feed means adding a row here,
 * a DATA_SOURCES.md row with its license, and a credit in dataCredits.js.
 *
 * Admission rules for a feed:
 *  - Keyless, or keyed by a free key the owner may leave unset. A keyless feed
 *    needs no key, token, or registration (identify-yourself headers are
 *    fine — Entur asks for `ET-Client-Name`, OVapi for a User-Agent). A keyed
 *    feed names the environment variable that holds its key (`envVar`) and
 *    where the proxy puts it (`keyHeader` or `keyQuery`); the registered
 *    `url` never carries the key, the browser never sees it, and while the
 *    variable is unset the proxy answers "needs a key" without asking the
 *    operator. The keyless feeds are unaffected by any key being absent.
 *  - An open license that permits display with attribution.
 *  - Real coordinates in VehiclePosition.position — NYCT subway, for example,
 *    publishes stop-relative positions only and is deliberately absent.
 *
 * A feed whose operator limits requests names its own proxy cache window
 * (`refreshMs`, default `TRANSIT_DEFAULT_REFRESH_MS`) and, where a token has
 * an hourly allowance, the most upstream loads the proxy may make in any
 * rolling hour (`budgetPerHour`).
 *
 * `defaultEnabled` is separate from being registered. A feed ships switched ON
 * only when its operator's own published terms were READ and plainly cover this
 * use. A registered feed with `defaultEnabled: false` is never polled and never
 * offered to the browser; it is here so the decision is visible and reversible
 * in one line. `terms` records the passage that decision rests on, so the next
 * reader does not have to take the licence string on faith.
 *
 * Pure data + pure helpers: imported by the browser layer, the Vite proxy, and
 * node:test. No Cesium, no Node built-ins.
 */

/** Transit modes the layer colors. `routeMode` hints refine a feed's default. */
export const TRANSIT_MODES = Object.freeze([
  'bus',
  'tram',
  'subway',
  'rail',
  'ferry',
  'unknown',
]);

/** Per-mode icon used in labels and the selection card. */
export const TRANSIT_MODE_ICON = Object.freeze({
  bus: '🚌',
  tram: '🚊',
  subway: '🚇',
  rail: '🚆',
  ferry: '⛴️',
  unknown: '🚏',
});

/**
 * MBTA route ids are human-readable and mode-typed: rapid-transit lines carry
 * colour names, commuter rail is prefixed `CR-`, ferries `Boat-`, buses are
 * numeric (or `SL`/`CT` express families).
 * @param {string|null} routeId
 * @returns {string}
 */
function mbtaRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (/^(Red|Orange|Blue)\b/.test(routeId)) return 'subway';
  if (/^(Green|Mattapan)/.test(routeId)) return 'tram';
  if (/^CR-/.test(routeId)) return 'rail';
  if (/^Boat-/.test(routeId)) return 'ferry';
  if (/^Shuttle/i.test(routeId)) return 'bus';
  return 'bus';
}

/**
 * Entur (Norway) route ids are `<codespace>:Line:<local-id>`; the codespace
 * tells the operator, not the mode, but a few are single-mode operators.
 * @param {string|null} routeId
 * @returns {string}
 */
function enturRouteMode(routeId) {
  if (!routeId) return 'unknown';
  const codespace = routeId.split(':')[0];
  if (
    codespace === 'VYG' ||
    codespace === 'GJB' ||
    codespace === 'SJN' ||
    codespace === 'FLT' ||
    codespace === 'GOA' ||
    codespace === 'NSB' ||
    codespace === 'VYT'
  )
    return 'rail';
  if (codespace === 'FLB') return 'rail';
  return 'bus';
}

/**
 * HSL route ids start with a four-digit code whose first digit is the mode
 * family in HSL's numbering: 1xxx/2xxx… are trams (1001–1010) for 4-digit ids
 * beginning with `10`, metro routes are `31M…`, ferries `1019`.
 * @param {string|null} routeId
 * @returns {string}
 */
function hslRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (/^31M/.test(routeId)) return 'subway';
  if (/^10(0[1-9]|10|15)/.test(routeId)) return 'tram';
  if (/^1019/.test(routeId)) return 'ferry';
  if (/^300[0-9A-Z]/.test(routeId)) return 'rail';
  return 'bus';
}

/**
 * Metro Transit (Minneapolis–St Paul): light rail is the Blue/Green line
 * (route ids 901/902), Northstar commuter rail is 888.
 * @param {string|null} routeId
 * @returns {string}
 */
function metroTransitRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (routeId === '901' || routeId === '902') return 'tram';
  if (routeId === '888') return 'rail';
  return 'bus';
}

/**
 * TTC BusTime is the SURFACE feed: buses and streetcars, never the subway.
 * Streetcar routes are the 500-series, plus the four Blue Night routes that
 * run on streetcar trackage (301 Queen, 304 King, 306 Carlton, 310 Spadina);
 * the rest of the 300-series is night buses.
 * @param {string|null} routeId
 * @returns {string}
 */
function ttcRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (/^5\d\d$/.test(routeId)) return 'tram';
  if (/^(301|304|306|310)$/.test(routeId)) return 'tram';
  return 'bus';
}

/**
 * The fleet number settles TTC's mode before the route does: buses replace
 * streetcars on 5xx routes during track work, and streetcars running out of
 * service report no route at all. Flexity streetcars are numbered 4400–4699;
 * every other TTC number is a bus.
 * @param {string|null} vehicleId GTFS-RT vehicle id (the fleet number).
 * @returns {string}
 */
function ttcVehicleMode(vehicleId) {
  if (!/^\d{4}$/.test(String(vehicleId ?? ''))) return 'unknown';
  const fleet = Number(vehicleId);
  return fleet >= 4400 && fleet < 4700 ? 'tram' : 'bus';
}

/**
 * Guelph Transit's realtime feed publishes the internal database key of a
 * route (`2991`), not the number on the front of the bus (`1`). Without this
 * table the detection label reads "Route 2991", which is not what anyone at
 * the stop calls it. Route ids and short names are from the City of Guelph's
 * own published GTFS `routes.txt` (see DATA_SOURCES.md); an id missing here
 * falls through unchanged, so a route added later degrades to its raw id
 * rather than disappearing.
 */
const GUELPH_ROUTE_NAMES = Object.freeze({
  2991: '1',
  2992: '10',
  2993: '11',
  2994: '12',
  2995: '13',
  2996: '14',
  2997: '15',
  2998: '16',
  2999: '17',
  3000: '18',
  3001: '19',
  3002: '2',
  3003: '20',
  3004: '3',
  3005: '4',
  3006: '5',
  3007: '50 U',
  3008: '52 U',
  3009: '56 U',
  3010: '58 U',
  3011: '6',
  3012: '7',
  3013: '8',
  3014: '9',
  3015: '98',
  3016: '99',
  3017: '99Lite',
  3018: 'BREW',
  3019: 'EdiCol',
  3023: 'IroHarv',
  3030: 'Sun LN',
  3032: 'WHanSco',
  3039: 'ZehCha',
});

/**
 * Guelph route id to the number a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function guelphRouteLabel(routeId) {
  return GUELPH_ROUTE_NAMES[routeId] || routeId;
}

/**
 * Hamilton publishes an internal key for every route: not one of HSR's 80 route
 * ids equals the number on the bus, so an untranslated feed reads as
 * "Route 5783" city-wide. Two generations of id are live at once — `5688` and
 * `5780` are both the 2 BARTON — and both are listed, because both arrive.
 *
 * Numbers are unpadded to match the rest of the registry (`routes.txt` says
 * `02`; a rider says 2). The seasonal and event shuttles publish a name rather
 * than a number — `TC230`, `PEACH`, `ROCKTON` — and those are already what a
 * rider would say, so they survive as published. Ids and names are from the
 * City's own published GTFS `routes.txt`, under the same terms as the feed.
 */
const HAMILTON_ROUTE_NAMES = Object.freeze({
  5687: '1',
  5688: '2',
  5689: '3',
  5690: '4',
  5691: '5',
  5692: '6',
  5693: '7',
  5694: '8',
  5695: '9',
  5696: '10',
  5697: '11',
  5698: '12',
  5699: '16',
  5700: '18',
  5701: '20',
  5702: '21',
  5703: '22',
  5704: '23',
  5705: '24',
  5706: '25',
  5707: '26',
  5708: '27',
  5709: '33',
  5710: '34',
  5711: '35',
  5712: '41',
  5713: '42',
  5714: '43',
  5715: '44',
  5716: '51',
  5717: '52',
  5718: '55',
  5719: '56',
  5720: '99',
  5731: 'X-IND',
  5780: '2',
  5781: '3',
  5782: '4',
  5783: '5',
  5784: '6',
  5785: '7',
  5786: '8',
  5787: '9',
  5789: '11',
  5790: '12',
  5791: '16',
  5792: '18',
  5793: '20',
  5794: '21',
  5795: '22',
  5796: '23',
  5797: '24',
  5798: '25',
  5799: '26',
  5800: '27',
  5801: '33',
  5802: '34',
  5803: '35',
  5805: '42',
  5806: '43',
  5807: '44',
  5808: '51',
  5809: '52',
  5811: '56',
  5812: '99',
  5820: 'TC230',
  5823: 'X IND',
  5824: 'TC-700',
  5825: 'TC-300',
  5826: 'CAN',
  5827: 'PEACH',
  5828: '1',
  5829: '10',
  5830: '41',
  5831: '55',
  5832: 'TC300',
  5833: 'TC700',
  5834: 'TC730',
  5835: 'ANCFAIR',
  5836: 'ROCKTON',
});

/**
 * Hamilton route id to the number a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function hamiltonRouteLabel(routeId) {
  return HAMILTON_ROUTE_NAMES[routeId] || routeId;
}

/**
 * YRT publishes Viva bus rapid transit by route id (`601`), while every rider,
 * station sign and map calls it "Viva Blue". Plain local routes are already the
 * number on the bus and are left alone, unpadded: `105` reads better than the
 * `005` of `routes.txt`.
 *
 * Branches are the exception. YRT suffixes a two-digit branch onto the base
 * route — the scheme Viva's own `60102` follows — so a branch id reaches a
 * rider as "8301" unless it is translated. Names and colours are from York
 * Region's own published GTFS `routes.txt`; Viva Green (604) and Pink (606)
 * are not in current service and so are absent here too.
 *
 * Only branches observed live AND published in `routes.txt` are listed. `9101`
 * runs but is unpublished, so it is deliberately missing: the pattern suggests
 * "91A", and suggesting is not knowing.
 */
const YRT_ROUTE_NAMES = Object.freeze({
  601: 'Viva Blue',
  60102: 'Viva Blue B',
  603: 'Viva Purple',
  60301: 'Viva Purple A',
  605: 'Viva Orange',
  607: 'Viva Yellow',
  8301: '83A',
  9002: '90B',
  10702: '107B',
});

/**
 * YRT route id to the name a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function yrtRouteLabel(routeId) {
  return YRT_ROUTE_NAMES[routeId] || routeId;
}

/**
 * Burlington publishes the internal key of a route, and the keys are a trap:
 * `351` is route 1 while `3510` is route 10, so trimming a `35` prefix gets
 * the wrong answer on half the network. The join is the only correct route.
 * Ids and numbers are from the City's own published GTFS `routes.txt`, which
 * sits in the same directory as the realtime feed under the same terms.
 */
const BURLINGTON_ROUTE_NAMES = Object.freeze({
  351: '1',
  352: '2',
  353: '3',
  354: '4',
  356: '6',
  3510: '10',
  3511: '11',
  3512: '12',
  3525: '25',
  3548: '48',
  3550: '50',
  3551: '51',
  3552: '52',
  3580: '80',
  3581: '81',
  3587: '87',
});

/**
 * Burlington route id to the number a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function burlingtonRouteLabel(routeId) {
  return BURLINGTON_ROUTE_NAMES[routeId] || routeId;
}

/**
 * LA Metro joins a bus route's number to the timetable it runs on: `2-13201`
 * is Line 2 on timetable 13201, and the suffix changes at every shake-up, so
 * it is removed by rule rather than looked up. The rail feed uses stable
 * three-digit codes whose names and kinds are from Metro's own published
 * `gtfs_rail.zip` (`routes.txt`): the A, C, E and K Lines are light rail
 * (`route_type` 0), the B and D Lines the subway (`route_type` 1). The two
 * bus rapid transit lines in the bus feed are named the same way riders see
 * them on the map.
 */
const LAMETRO_RAIL_LINES = Object.freeze({
  801: Object.freeze({ name: 'A Line', mode: 'tram' }),
  802: Object.freeze({ name: 'B Line', mode: 'subway' }),
  803: Object.freeze({ name: 'C Line', mode: 'tram' }),
  804: Object.freeze({ name: 'E Line', mode: 'tram' }),
  805: Object.freeze({ name: 'D Line', mode: 'subway' }),
  807: Object.freeze({ name: 'K Line', mode: 'tram' }),
});
const LAMETRO_BUS_LINES = Object.freeze({ 901: 'G Line', 910: 'J Line' });

/** An LA Metro route id without its timetable suffix. */
function lametroBaseRoute(routeId) {
  return routeId ? String(routeId).replace(/-\d+$/, '') : '';
}

/**
 * LA Metro bus route id to the number on the bus.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function lametroBusRouteLabel(routeId) {
  if (!routeId) return routeId;
  const base = lametroBaseRoute(routeId);
  return LAMETRO_BUS_LINES[base] || base;
}

/**
 * LA Metro rail route id to the line's name.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function lametroRailRouteLabel(routeId) {
  return LAMETRO_RAIL_LINES[lametroBaseRoute(routeId)]?.name || routeId;
}

/**
 * LA Metro rail lines are light rail except the two subway lines.
 * @param {string|null} routeId
 * @returns {string}
 */
function lametroRailRouteMode(routeId) {
  return LAMETRO_RAIL_LINES[lametroBaseRoute(routeId)]?.mode || 'unknown';
}

/**
 * RTC Southern Nevada publishes an internal key for every route (`4778` is
 * the Deuce on the Strip), so the feed would read "Route 4778" city-wide
 * without this table. Ids and the names on the buses are from RTC's own
 * published `google_transit.zip` (`routes.txt`); an id missing here renders
 * unchanged rather than blank.
 */
const RTC_ROUTE_NAMES = Object.freeze({
  4741: '101',
  4742: '105',
  4743: '106',
  4744: '113',
  4745: '115',
  4746: '208',
  4747: '214',
  4748: '215',
  4749: '219',
  4750: '102',
  4751: '103',
  4752: '104',
  4753: '117',
  4754: '122',
  4755: '217',
  4756: 'BHX',
  4757: 'DVX',
  4758: 'CX',
  4759: '108',
  4760: 'RED LINE',
  4761: '110',
  4762: '212',
  4763: '111',
  4764: '203',
  4765: '119',
  4766: '120',
  4767: '121',
  4768: '201',
  4769: '202',
  4770: '206',
  4771: 'SX',
  4772: '207',
  4773: '209',
  4774: '210',
  4775: '218',
  4776: '220',
  4777: '221',
  4778: 'DEUCE',
  4779: '401',
});

/**
 * RTC route id to the number a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function rtcRouteLabel(routeId) {
  return RTC_ROUTE_NAMES[routeId] || routeId;
}

/**
 * MVgo's shuttle routes are lettered A to D with a morning and an afternoon
 * pattern each, published under internal ids. Names are from MVgo's own
 * `gtfs.zip` (`routes.txt`), under the same ODC-BY licence as the feed.
 */
const MVGO_ROUTE_NAMES = Object.freeze({
  5783: 'A - AM',
  5784: 'B - AM',
  5785: 'B - PM',
  5786: 'A - PM',
  5787: 'C - AM',
  5788: 'C - PM',
  5789: 'D - AM',
  5790: 'D - PM',
  5791: 'D - PM Concert',
  5792: 'B - PM Concert',
});

/**
 * MVgo route id to the route's published name.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function mvgoRouteLabel(routeId) {
  return MVGO_ROUTE_NAMES[routeId] || routeId;
}

/**
 * Registry of feeds. Order is presentation order in the stats/credit text.
 * `loadRadiusKm` is the distance from `center` inside which the feed is polled.
 * A keyed feed names `envVar` and either `keyHeader` (the request header that
 * carries the key) or `keyQuery` (the query parameter the proxy appends).
 * @type {ReadonlyArray<Readonly<{
 *   id: string, name: string, operator: string, region: string,
 *   center: {lat: number, lon: number}, loadRadiusKm: number,
 *   url: string, headers?: Record<string, string>,
 *   envVar?: string, keyHeader?: string, keyQuery?: string,
 *   refreshMs?: number, budgetPerHour?: number,
 *   license: string, licenseUrl: string, attribution: string,
 *   defaultMode: string, routeMode?: (routeId: string|null) => string,
 * }>>}
 */
export const TRANSIT_FEED_REGISTRY = Object.freeze([
  Object.freeze({
    id: 'mbta',
    historyRetention: true,
    name: 'MBTA',
    operator: 'Massachusetts Bay Transportation Authority',
    region: 'Boston, MA',
    center: Object.freeze({ lat: 42.3601, lon: -71.0589 }),
    loadRadiusKm: 70,
    url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb',
    license: 'MassDOT Developers License Agreement',
    licenseUrl:
      'https://cdn.mbta.com/sites/default/files/2023-08/mbta-massdot-develop-license-agreement.pdf',
    attribution: 'MBTA / MassDOT',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'MassDOT ... hereby grants You (Licensee) non-exclusive, limited, and revocable rights to use, reproduce, and redistribute the Data. ... Clearly acknowledge MassDOT as the provider of the Data.',
      note: 'Credit is text only: the agreement forbids using MBTA/MassDOT logos or trademarks with the data.',
    }),
    defaultMode: 'bus',
    routeMode: mbtaRouteMode,
  }),
  Object.freeze({
    id: 'capmetro-austin',
    name: 'CapMetro',
    operator: 'Capital Metropolitan Transportation Authority',
    region: 'Austin, TX',
    center: Object.freeze({ lat: 30.2672, lon: -97.7431 }),
    loadRadiusKm: 60,
    url: 'https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream',
    license: 'CapMetro Developer Tools license',
    licenseUrl: 'https://www.capmetro.org/developertools',
    attribution:
      'Capital Metropolitan Transportation Authority — data.texas.gov',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Capital Metropolitan Transportation Authority (CMTA) hereby grants you (Licensee) non-exclusive, limited and revocable rights to use, reproduce, and redistribute CMTA Data.',
      note: 'CMTA trademarks may not be used in association with the data, so the credit is the operator name as text.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'metrotransit-msp',
    name: 'Metro Transit',
    operator: 'Metro Transit (Metropolitan Council)',
    region: 'Minneapolis–St Paul, MN',
    center: Object.freeze({ lat: 44.9778, lon: -93.265 }),
    loadRadiusKm: 70,
    url: 'https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb',
    license: 'Public Metro Transit vehicle position data',
    licenseUrl: 'https://svc.metrotransit.org/',
    attribution: 'Metro Transit — Metropolitan Council',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        "Metro Transit's GTFS-realtime feeds are refreshed every 5 seconds.",
      note: 'The realtime feed is published from a developer page carrying operational guidance and no licence text of its own. The public-domain statement below belongs to the Metropolitan Council metadata for the COMPANION SCHEDULE dataset, not to this feed: "None. This dataset is public domain under the Minnesota Government Data Practices Act". Credited as a courtesy, the way the other public agency feeds are.',
    }),
    defaultMode: 'bus',
    routeMode: metroTransitRouteMode,
  }),
  Object.freeze({
    id: 'hsl-helsinki',
    name: 'HSL',
    operator: 'Helsinki Region Transport (HSL)',
    region: 'Helsinki, Finland',
    center: Object.freeze({ lat: 60.1699, lon: 24.9384 }),
    loadRadiusKm: 70,
    url: 'https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl',
    license: 'CC BY 4.0',
    licenseUrl: 'https://www.hsl.fi/en/hsl/open-data',
    attribution: 'HSL (Helsinki Region Transport)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: null,
      note: 'The open-data page refuses automated readers (HTTP 403, bot protection), so this entry rests on the owner opening it and accepting it rather than on a passage quoted here. HSL publishes its open data under CC BY 4.0 and asks to be credited as the source; the feed needs no key.',
    }),
    defaultMode: 'bus',
    routeMode: hslRouteMode,
  }),
  Object.freeze({
    id: 'ovapi-nl',
    name: 'OVapi',
    operator: 'Stichting OpenGeo (NDOV data)',
    region: 'Netherlands',
    center: Object.freeze({ lat: 52.2, lon: 5.3 }),
    loadRadiusKm: 220,
    url: 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb',
    license: 'Free to use per the OVapi README (best effort, no SLA)',
    licenseUrl: 'https://gtfs.ovapi.nl/README',
    attribution:
      'OVapi / Stichting OpenGeo — Dutch integrated real-time transit data',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'You are free to use this data, but there is no service level agreement (best-effort) nor are you allowed to say you represent or impersonate any of the transit agencies listed here.',
      note: 'The README asks consumers to identify themselves in the User-Agent, to send If-Modified-Since / If-None-Match when polling faster than once a minute, and to accept gzip. The proxy does all three.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'entur-norway',
    name: 'Entur',
    operator: 'Entur AS (Norwegian national transit data)',
    region: 'Norway',
    // Circle chosen to hold Oslo, Bergen, Bodø and Tromsø while leaving
    // Helsinki (≈820 km) out — a national feed must not poll from next door.
    center: Object.freeze({ lat: 64.0, lon: 11.5 }),
    loadRadiusKm: 720,
    url: 'https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions',
    headers: Object.freeze({ 'ET-Client-Name': 'osiris-transit' }),
    license: 'Norwegian Licence for Open Government Data (NLOD)',
    licenseUrl: 'https://developer.entur.org/pages-intro-authentication',
    attribution: 'Entur — data under NLOD',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'This API is open under NLOD licence, however, it is required that all consumers identify themselves by using the header ET-Client-Name.',
      note: 'The header is mandatory — unidentified consumers may be rate-limited or blocked — and the proxy sends it on every request.',
    }),
    defaultMode: 'bus',
    routeMode: enturRouteMode,
  }),
  Object.freeze({
    id: 'translink-seq',
    name: 'TransLink',
    operator: 'TransLink (Queensland Government)',
    region: 'South East Queensland, Australia',
    center: Object.freeze({ lat: -27.4698, lon: 153.0251 }),
    loadRadiusKm: 150,
    url: 'https://gtfsrt.api.translink.com.au/api/realtime/seq/VehiclePositions',
    license: 'CC BY 4.0',
    licenseUrl: 'https://translink.com.au/about-translink/open-data',
    attribution: 'TransLink — Queensland Government (CC BY 4.0)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Our data is licensed under a Creative Commons Attribution 4.0 International License. ... You must not represent that the State in any way endorses your Application.',
      note: 'No key, no stated rate limit, no caching rule. Logos and network imagery need separate approval, so the credit is text only.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'ttc-toronto',
    name: 'TTC',
    operator: 'Toronto Transit Commission',
    region: 'Toronto, ON',
    center: Object.freeze({ lat: 43.6532, lon: -79.3832 }),
    loadRadiusKm: 45,
    url: 'https://bustime.ttc.ca/gtfsrt/vehicles',
    license: 'Open Government Licence \u2013 Toronto',
    licenseUrl: 'https://open.toronto.ca/open-data-licence/',
    attribution:
      'Toronto Transit Commission \u2014 City of Toronto Open Data (Open Government Licence \u2013 Toronto)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Information Provider grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the Information, including for commercial purposes ... Acknowledge the source of the Information by including any attribution statement specified by the Information Provider.',
      note: 'The City publishes this endpoint from the TTC BusTime NVAS catalogue entry, whose own licence field reads \"License not specified\"; the quote above is the portal-wide Open Government Licence \u2013 Toronto the City applies to its open data, so the credit carries the licence name the way the Metro Transit entry carries its public-domain note. BusTime is the surface system: buses and streetcars report real positions, the subway reports none, so Lines 1/2/4 are simply absent rather than inferred. The endpoint sends no ETag or Last-Modified, so conditional requests fall through to the proxy snapshot TTL.',
    }),
    defaultMode: 'bus',
    // Toronto rides streetcars. The vehicles are the shared `tram` mode and
    // share its silhouette and speed limits; only the word a reader sees
    // changes, because "tram" is not what anyone at Queen and Spadina says.
    modeWords: Object.freeze({
      tram: Object.freeze({ word: 'Streetcar', abbr: 'STREETCAR' }),
    }),
    routeMode: ttcRouteMode,
    vehicleMode: ttcVehicleMode,
  }),
  Object.freeze({
    id: 'miway-mississauga',
    name: 'MiWay',
    operator: 'MiWay (City of Mississauga)',
    region: 'Mississauga, ON',
    center: Object.freeze({ lat: 43.589, lon: -79.6441 }),
    loadRadiusKm: 30,
    url: 'https://www.miapp.ca/GTFS_RT/Vehicle/VehiclePositions.pb',
    license: 'City of Mississauga Open Data Terms of Use',
    licenseUrl:
      'http://www5.mississauga.ca/research_catalogue/CityofMississauga_TermsofUse.pdf',
    attribution: 'MiWay \u2014 City of Mississauga Open Data',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The City of Mississauga (the City) now grants you a world-wide, royalty-free, non-exclusive, revocable licence to use, modify, and distribute the Datasets in all current and future media and formats for any lawful purpose.',
      note: 'Two conditions shape how this ships. The licence is REVOCABLE, and it asks that anyone who provides access to the data pass on the Terms of Use URL \u2014 so `licenseUrl` points at the terms themselves rather than at a catalogue page, and the attribution popover carries the link. Credit is optional here ("you are not required to credit the City"), and is given anyway as a courtesy, the way the other municipal feeds are.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'hsr-hamilton',
    name: 'Hamilton HSR',
    operator: 'Hamilton Street Railway (City of Hamilton)',
    region: 'Hamilton, ON',
    center: Object.freeze({ lat: 43.2557, lon: -79.8711 }),
    loadRadiusKm: 30,
    url: 'https://opendata.hamilton.ca/GTFS-RT/GTFS_VehiclePositions.pb',
    license: 'City of Hamilton Open Data Licence',
    licenseUrl:
      'https://www.hamilton.ca/city-initiatives/strategies-actions/open-data-licence-terms-and-conditions',
    attribution:
      'Contains public sector Data made available under the City of Hamilton\u2019s Open Data Licence',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The City of Hamilton grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the Data, including for commercial purposes ... you must acknowledge the source of the Data by including the following attribution statement: \u201cContains public sector Data made available under the City of Hamilton\u2019s Open Data Licence\u201d.',
      note: 'The attribution wording is prescribed by the licence, so it is used verbatim as the credit rather than paraphrased to an operator name. Names, crests, logos and marks are excluded from the grant, so the credit stays text.',
    }),
    defaultMode: 'bus',
    routeLabel: hamiltonRouteLabel,
  }),
  Object.freeze({
    id: 'durham-region',
    name: 'Durham Region Transit',
    operator: 'Durham Region Transit (Regional Municipality of Durham)',
    region: 'Durham Region, ON',
    center: Object.freeze({ lat: 43.9496, lon: -78.9365 }),
    loadRadiusKm: 45,
    url: 'https://drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions',
    license: 'Region of Durham Open Data Licence v.1.0',
    licenseUrl: 'https://www.durham.ca/en/regional-government/open-data.aspx',
    attribution:
      "Contains public sector information made available under The Regional Municipality of Durham's Open Data Licence",
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Durham Region grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the information ... You are free to: Copy, publish, distribute and transmit the information ... Use the information commercially.',
      note: 'The licence link the open-data catalogue publishes for this feed (OpenDataLicenceAgreement.pdf) is dead after a site relaunch; `licenseUrl` points at the live Open Data page carrying the same licence v.1.0 text, which is where the quote above was read. Credit is optional and the suggested statement is used verbatim.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'guelph-transit',
    name: 'Guelph Transit',
    operator: 'Guelph Transit (City of Guelph)',
    region: 'Guelph, ON',
    center: Object.freeze({ lat: 43.5325, lon: -80.2482 }),
    loadRadiusKm: 15,
    url: 'https://glphprdtmgtfs.glphtrpcloud.com/tmgtfsrealtimewebservice/vehicle/vehiclepositions.pb',
    license: 'Open Government Licence \u2013 City of Guelph (v2.0)',
    licenseUrl: 'https://explore.guelph.ca/pages/open-data-license',
    attribution:
      'Contains information licensed under the Open Government Licence \u2013 City of Guelph',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Information Provider grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the Information including for commercial purposes subject to the terms below. ... Acknowledge the source of the Information by including any attribution statement specified by the Information Provider(s) and, where possible, provide a link to this licence.',
      note: 'The endpoint sits on a vendor host, so provenance matters: the City publishes this exact URL on its own open-data developer page, https://explore.guelph.ca/pages/transit-gtfs-data, under an open-data initiative heading (that page is JavaScript-rendered; its readable source is the ArcGIS item JSON behind it). The licence is a verbatim OGL-Canada 2.0 derivative and the attribution wording above is its prescribed fallback, so it is used as written. The transit datasets carry a BLANK licence field in the portal catalogue; the Terms of Use supply it by default ("Except where otherwise noted this is the Open Government Licence"), the same shape of gap the TTC entry records. The Terms also publish a traffic limit \u2014 no concurrent requests, at most 5 per second \u2014 which one poll every 15 s satisfies many times over. Crests and logos are excluded from the grant, so the credit stays text.',
    }),
    defaultMode: 'bus',
    routeLabel: guelphRouteLabel,
  }),
  Object.freeze({
    id: 'kingston-transit',
    name: 'Kingston Transit',
    operator: 'Kingston Transit (The Corporation of the City of Kingston)',
    region: 'Kingston, ON',
    center: Object.freeze({ lat: 44.24, lon: -76.57 }),
    loadRadiusKm: 20,
    url: 'https://api.cityofkingston.ca/gtfs-realtime/vehicleupdates.pb',
    license: 'City of Kingston Open Data Licence 1.0',
    licenseUrl:
      'https://www.cityofkingston.ca/media/wtpgpkb0/gis_license_opendata.pdf',
    attribution:
      'Contains information licensed under the Open Data Licence \u2013 City of Kingston',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Information Provider, the City of Kingston, grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the information provided for any purpose, including for commercial purposes, subject to the terms below. ... Acknowledge the source of the information by including any attribution statement specified by the City of Kingston and, where possible, provide a link to this licence.',
      note: 'The City catalogues this exact URL as an open-data dataset, so provenance is direct rather than inferred. `licenseUrl` is the canonical location of the licence PDF; the address the catalogue prints is a legacy path that currently redirects there, and pinning the redirect target is what survives the next site relaunch \u2014 the Durham entry records what happens when it does not. Names, crests and logos are excluded from the grant, so the credit stays text. Roughly one entity in ten carries no usable position (the position field absent, occasionally a momentary 0,0 GPS dropout); both are discarded before rendering.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'barrie-transit',
    name: 'Barrie Transit',
    operator: 'Barrie Transit (City of Barrie)',
    region: 'Barrie, ON',
    center: Object.freeze({ lat: 44.371, lon: -79.6733 }),
    loadRadiusKm: 10,
    url: 'https://www.myridebarrie.ca/gtfs/GTFS_VehiclePositions.pb',
    license: 'Barrie Transit Data licence',
    licenseUrl:
      'https://www.barrie.ca/services-payments/transportation-parking/barrie-transit/barrie-gtfs',
    attribution:
      'Realtime vehicle data \u00a9 City of Barrie, used under the Barrie Transit Data licence',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Barrie Transit hereby grants you a non-exclusive, limited and revocable rights to use, reproduce, and redistribute Barrie Transit Data (scheduled and real-time data) subject to the following terms: Barrie Transit trademarks and copyrighted materials, including any confusingly similar variants, may not be used in association with Data. ... Barrie Transit maintains title, ownership, rights and interest in and to Data.',
      note: 'The City offers this licence for acceptance behind a click-through checkbox, and the licence body also makes use itself acceptance: \u201cBy using Barrie Transit Data, you agree to be bound by these terms.\u201d This deployment\u2019s owner took that clause as sufficient on 2026-09-16 and switched the feed on; nothing gates the endpoint, which needs no key, token or cookie. Two oddities worth knowing: the licence requires NO attribution at all (the credit above is a courtesy), and its trademark clause is broad enough that the credit names the City rather than Barrie Transit. The grant is expressly REVOCABLE and unversioned, so the quote above is the text as read on 2026-09-16.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'yrt-york',
    name: 'YRT/Viva',
    operator:
      'York Region Transit (YRT/Viva), The Regional Municipality of York',
    region: 'York Region, ON',
    center: Object.freeze({ lat: 44.025, lon: -79.436 }),
    loadRadiusKm: 38,
    url: 'https://rtu.york.ca/gtfsrealtime/VehiclePositions',
    license: 'YRT Open Data Licence v2.0 (UK OGL-derived)',
    licenseUrl:
      'https://www.yrt.ca/en/about-us/open-data-licence-agreement.aspx',
    attribution:
      "Contains public transit Information made available under YRT's Open Data Licence",
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'YRT grants You a worldwide, royalty-free, perpetual, non-exclusive licence to Use the Information subject to the conditions below ... Use the Information commercially ... Provide credit to YRT when using Information under this licence but are not required to. ... Please note: You must agree with and accept the above stated License Agreement in order to download YRT GTFS or real-time GTFS data.',
      note: 'The operator asks that its licence be accepted through a form (forms.yrt.ca/YRT-GTFS-Data, which collects a name, company, phone and email and issues no credential), while the licence body says acceptance is by use: \u201cYour Use of Information indicates Your acceptance of the terms and conditions below.\u201d This deployment\u2019s owner took that clause as sufficient on 2026-09-16 and switched the feed on. Nothing gates the endpoint. The credit above is the licence\u2019s own wording and must be reproduced as given; attribution is optional here, and given anyway. Logos, trademarks and crests are carved out, so the credit stays text. Two data notes: no vehicle carries a bearing, so heading comes from observed movement; and one stuck unit reported a position ten hours old, which the layer shows as a stale report rather than hides.',
    }),
    defaultMode: 'bus',
    routeLabel: yrtRouteLabel,
  }),
  Object.freeze({
    id: 'burlington-transit',
    name: 'Burlington Transit',
    operator: 'Burlington Transit (City of Burlington)',
    region: 'Burlington, ON',
    center: Object.freeze({ lat: 43.3342, lon: -79.8089 }),
    loadRadiusKm: 12,
    url: 'https://opendata.burlington.ca/gtfs-rt/GTFS_VehiclePositions.pb',
    license: 'City of Burlington Open Data Terms of Use',
    licenseUrl:
      'https://opendata.burlington.ca/opendata-terms-of-use/City%20of%20Burlington%20-%20Open%20Data%20Terms%20of%20Use.pdf',
    attribution:
      'Transit data \u00a9 City of Burlington (Burlington Transit), used under the City of Burlington Open Data Terms of Use',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Corporation of the City of Burlington (the City) now grants you a worldwide, royalty-free, non-exclusive, revocable licence to use, reproduce, modify, and distribute the datasets in all current and future media and formats for any lawful purpose. ... If you distribute or provide access to these datasets to any other person ... you agree to include a copy of, or this Uniform Resource Locator (URL) for, these Terms of Use.',
      note: 'Same 2011-era municipal template as Mississauga, and the same two consequences: the grant is REVOCABLE, and the terms have to travel with the data, so `licenseUrl` is the Terms document itself rather than a catalogue page and the attribution popover carries the link. Credit is optional here and given anyway. Crests, logos and marks are excluded and the terms forbid implying any association, so the credit stays plain text. The catalogue record for this data leads with a licence link that 404s; the URL above is the live one. Plain http:// has no listener at all \u2014 not a redirect, a hang \u2014 so the https:// URL is mandatory rather than preferred. The feed updates once a minute and answers conditional requests with an ETag.',
    }),
    defaultMode: 'bus',
    routeLabel: burlingtonRouteLabel,
  }),
  Object.freeze({
    id: 'sf511-bay-area',
    name: '511 SF Bay',
    operator:
      'Metropolitan Transportation Commission (511 SF Bay), for the Bay Area transit operators',
    region: 'San Francisco Bay Area',
    // A circle that holds San Francisco, San Jose and Santa Rosa: the
    // regional feed carries the whole Bay Area and Sonoma County at once.
    center: Object.freeze({ lat: 37.8, lon: -122.3 }),
    loadRadiusKm: 120,
    url: 'https://api.511.org/transit/vehiclepositions?agency=RG',
    envVar: 'BAY_AREA_511_API_KEY',
    keyQuery: 'api_key',
    // 511 answers protobuf only to one of these two Accept values (or to a
    // `format` parameter); the proxy's default Accept lists neither first.
    headers: Object.freeze({
      Accept: 'application/x-google-protobuf, application/octet-stream;q=0.9',
    }),
    // A token is allowed 60 requests an hour and the Alerts layer spends up
    // to 15 of them. An 80 s window lands on every sixth 15 s poll, so the
    // feed costs the token at most 40 loads an hour however many tabs poll;
    // the budget is the backstop should the failure ladder retry faster.
    refreshMs: 80_000,
    budgetPerHour: 45,
    license: '511 SF Bay Data Disseminator Agreement',
    licenseUrl: 'https://511.org/open-data/transit',
    attribution: 'data provided by 511.org',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'MTC hereby grants to Registered Data Disseminator a nonexclusive, royalty-free, worldwide, non-transferable license to use, sublicense, copy, distribute, and store (electronically or otherwise) the Provided Data; to create derivative works from the Provided Data; to display (publicly or otherwise) the Provided Data ... MUST acknowledge the source of the Provided Data with the tag line "powered by 511.org," or "data provided by 511.org," or a variant approved in writing by MTC, and a link to http://www.511.org.',
      note: 'One entry, not thirty: the regional feed (`agency=RG`) carries every operator 511 monitors (Muni, BART, Caltrain, AC Transit, VTA, SamTrans, Golden Gate Transit and Ferry, SMART, Marin Transit, Sonoma County Transit, Santa Rosa CityBus, Petaluma Transit and the rest) in one message, and one token is allowed 60 requests an hour. The token is free and issued on email verification (511.org/open-data/token); the agreement read on 2026-11-01 also asks the holder to show MTC the product within thirty days of launch (section 2.g) and keeps the operators’ logos off the application (sections 2.e and 5.d), so the credit is the prescribed tag line as text with a link to 511.org. BART publishes no vehicle positions of its own (its GTFS-Realtime page lists trip updates and alerts only), so this feed is where BART trains come from. Route and vehicle ids are expected to carry the operator prefix 511 uses across its APIs (`SF:14`), which is what the mode and label rules read; an unprefixed id degrades to the raw id and the bus default. Not exercised live where this was built: no token was configured.',
    }),
    defaultMode: 'bus',
    routeMode: sf511RouteMode,
    routeLabel: sf511RouteLabel,
  }),
  Object.freeze({
    id: 'lametro-bus',
    name: 'LA Metro',
    operator:
      'Los Angeles County Metropolitan Transportation Authority (LA Metro), via Swiftly',
    region: 'Los Angeles, CA',
    center: Object.freeze({ lat: 34.0537, lon: -118.2428 }),
    loadRadiusKm: 60,
    url: 'https://api.goswift.ly/real-time/lametro/gtfs-rt-vehicle-positions',
    envVar: 'SWIFTLY_API_KEY',
    keyHeader: 'Authorization',
    // Swiftly refreshes vehicle positions every 5 s and asks for a reasonable
    // request volume; 30 s is two bus reports and 120 loads an hour.
    refreshMs: 30_000,
    license: 'Swiftly API License Agreement, under LA Metro’s developer terms',
    licenseUrl: 'https://www.goswift.ly/api-license-agreement',
    attribution:
      'Transport information provided by LA Metro, through the Swiftly real-time API',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'a limited, non-exclusive, non-sublicensable, non-transferable, non-assignable license ... distribute or allow access to Licensee’s integration of the APIs within the Application ... Licensee has no right to distribute or allow access to the stand-alone APIs.',
      note: 'LA Metro points developers to Swiftly for its GTFS-Realtime feeds (developer.metro.net/api: agency keys `lametro` for bus and `lametro-rail` for rail, protobuf, refreshed every 5 seconds). The key is free for named agencies through Swiftly’s request form (goswift.ly/realtime-api-key); Swiftly’s agreement, read on 2026-11-01, licenses display inside the holder’s own application and forbids re-serving the API itself. Metro’s own developer terms ask that Metro be acknowledged as the provider of the transport information and forbid redistribution of the feeds, which the credit and the registered-feeds-only proxy satisfy. Not exercised live where this was built: no key was configured.',
    }),
    defaultMode: 'bus',
    routeLabel: lametroBusRouteLabel,
  }),
  Object.freeze({
    id: 'lametro-rail',
    name: 'LA Metro Rail',
    operator:
      'Los Angeles County Metropolitan Transportation Authority (LA Metro), via Swiftly',
    region: 'Los Angeles, CA',
    center: Object.freeze({ lat: 34.0537, lon: -118.2428 }),
    loadRadiusKm: 60,
    url: 'https://api.goswift.ly/real-time/lametro-rail/gtfs-rt-vehicle-positions',
    envVar: 'SWIFTLY_API_KEY',
    keyHeader: 'Authorization',
    refreshMs: 30_000,
    license: 'Swiftly API License Agreement, under LA Metro’s developer terms',
    licenseUrl: 'https://www.goswift.ly/api-license-agreement',
    attribution:
      'Transport information provided by LA Metro, through the Swiftly real-time API',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'a limited, non-exclusive, non-sublicensable, non-transferable, non-assignable license ... distribute or allow access to Licensee’s integration of the APIs within the Application ... Licensee has no right to distribute or allow access to the stand-alone APIs.',
      note: 'The rail half of the LA Metro entry above, on the same key and terms. Four of the six lines are light rail and two are the subway, so the default mode is tram and the route table settles the rest; the subway is drawn at street level like every other feed without depth.',
    }),
    defaultMode: 'tram',
    routeMode: lametroRailRouteMode,
    routeLabel: lametroRailRouteLabel,
  }),
  Object.freeze({
    id: 'metrolink',
    name: 'Metrolink',
    operator: 'Southern California Regional Rail Authority (Metrolink)',
    region: 'Southern California',
    // Union Station; the network reaches Lancaster, Ventura, San Bernardino
    // and Oceanside, so the circle is wide and the feed is small.
    center: Object.freeze({ lat: 34.0561, lon: -118.2365 }),
    loadRadiusKm: 120,
    url: 'https://metrolink-gtfsrt.gbsdigital.us/feed/gtfsrt-vehicles',
    envVar: 'METROLINK_API_KEY',
    keyHeader: 'X-Api-Key',
    refreshMs: 30_000,
    license: 'Metrolink GTFS-RT End-User License Agreement',
    licenseUrl:
      'https://metrolinktrains.com/about/gtfs/gtfs-rt-terms-and-conditions/',
    attribution: 'Metrolink (Southern California Regional Rail Authority)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Metrolink grants you a non-exclusive, non-transferable license to use the API Access solely for your own internal business purposes ... You may not copy, modify, distribute, sell, or transfer the API Access or any part thereof without the prior written consent of Metrolink.',
      note: 'A key is emailed on request from the GTFS-RT access page (metrolinktrains.com/about/gtfs/gtfs-rt-access) and travels in the `X-Api-Key` header, which the MobilityData catalogue records for this producer; the API answers 429 past a per-key rate limit, which the 30 s window keeps clear of. The licence read on 2026-11-01 covers the key holder’s own internal use, which is what a private console is, and not re-serving the feed to the public, so a shared deployment should leave METROLINK_API_KEY unset. Trains only, so the default mode is rail. Not exercised live where this was built: no key was configured.',
    }),
    defaultMode: 'rail',
  }),
  Object.freeze({
    id: 'rtc-southern-nevada',
    name: 'RTC Southern Nevada',
    operator:
      'Regional Transportation Commission of Southern Nevada (RTC), via Swiftly',
    region: 'Las Vegas, NV',
    center: Object.freeze({ lat: 36.1699, lon: -115.1398 }),
    loadRadiusKm: 45,
    url: 'https://api.goswift.ly/real-time/las-vegas-rtc/gtfs-rt-vehicle-positions',
    envVar: 'SWIFTLY_API_KEY',
    keyHeader: 'Authorization',
    refreshMs: 30_000,
    license: 'Swiftly API License Agreement',
    licenseUrl: 'https://www.goswift.ly/api-license-agreement',
    attribution: 'RTC of Southern Nevada, through the Swiftly real-time API',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'a limited, non-exclusive, non-sublicensable, non-transferable, non-assignable license ... distribute or allow access to Licensee’s integration of the APIs within the Application ... Licensee has no right to distribute or allow access to the stand-alone APIs.',
      note: 'RTC publishes its real-time feeds through Swiftly; its own site refuses automated readers, so the producer address is the one RTC submitted to the MobilityData catalogue, agency key `las-vegas-rtc` (the Alerts layer had carried an unconfirmed `rtcsnv`). Same key and agreement as the LA Metro entries. Route ids are internal keys translated from RTC’s published routes.txt. Not exercised live where this was built: no key was configured.',
    }),
    defaultMode: 'bus',
    routeLabel: rtcRouteLabel,
  }),
  Object.freeze({
    id: 'octa',
    name: 'OCTA',
    operator: 'Orange County Transportation Authority',
    region: 'Orange County, CA',
    center: Object.freeze({ lat: 33.75, lon: -117.87 }),
    loadRadiusKm: 50,
    url: 'https://api.octa.net/GTFSRealTime/protoBuf/VehiclePositions.aspx',
    license: 'OCTA open data: free developer data feeds',
    licenseUrl: 'https://www.octa.net/news-and-resources/open-data/overview/',
    attribution: 'Orange County Transportation Authority (OCTA)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'OCTA publically offers free data feeds to developers. These resources are to encourage community building and contributions by having developers utilize our transit information for the production of useful web services.',
      note: 'Keyless. The open-data page read on 2026-11-01 keeps ownership with OCTA ("At all times, OCTA maintains the rights and ownership of the open data we offer") and disclaims warranties; it prescribes no attribution wording, so the credit names the authority. The catalogue prints the endpoint as plain http://, but the https address answers, labelling the protobuf text/html; the proxy decodes bytes, not labels. Orange County is the south-eastern corner of the Los Angeles region box: 150 of 160 buses were inside it on the Sunday evening this was registered, every one with a bearing, a speed and its own timestamp. No ETag or Last-Modified, so conditional requests fall through to the cache window.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'mvgo-mountain-view',
    name: 'MVgo',
    operator: 'Mountain View Transportation Management Association (MVgo)',
    region: 'Mountain View, CA',
    center: Object.freeze({ lat: 37.4, lon: -122.07 }),
    loadRadiusKm: 12,
    url: 'https://mtma.tripshot.com/v1/gtfs/realtime/feed/mvgo?types=VehiclePosition',
    license: 'ODC-BY',
    licenseUrl: 'https://mvgo.org/developers/',
    attribution:
      'MVgo — Mountain View Transportation Management Association (ODC-BY)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'MVgo’s GTFS and GTFS Realtime data is available under the ODC-BY license.',
      note: 'Keyless, and the only keyless vehicle feed inside the Bay Area region box that publishes licence text. A weekday commuter shuttle network of a few vehicles around Mountain View, empty outside service hours (zero vehicles on the Sunday it was registered). Route ids are internal keys translated from the published routes.txt.',
    }),
    defaultMode: 'bus',
    routeLabel: mvgoRouteLabel,
  }),
]);

/**
 * The feeds this build actually polls. A registered feed that is not here is
 * inert everywhere: it resolves to no route, is never offered to the browser,
 * and never appears in a coverage check.
 */
export const TRANSIT_ENABLED_FEEDS = Object.freeze(
  TRANSIT_FEED_REGISTRY.filter((feed) => feed.defaultEnabled === true),
);

const FEED_BY_ID = new Map(
  TRANSIT_ENABLED_FEEDS.map((feed) => [feed.id, feed]),
);
const ANY_FEED_BY_ID = new Map(
  TRANSIT_FEED_REGISTRY.map((feed) => [feed.id, feed]),
);

/** Feed ids are path segments: lowercase letters, digits, hyphens only. */
export const TRANSIT_FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Proxy cache window for a feed that does not name its own (ms). */
export const TRANSIT_DEFAULT_REFRESH_MS = 15_000;

/**
 * How long the proxy serves one snapshot of a feed before asking again: the
 * feed's own `refreshMs`, else the default. An operator that allows a token
 * sixty requests an hour is polled on its terms, not the layer's.
 * @param {object|null} feed Registry entry.
 * @returns {number}
 */
export function transitFeedRefreshMs(feed) {
  const value = feed?.refreshMs;
  return Number.isFinite(value) && value > 0
    ? value
    : TRANSIT_DEFAULT_REFRESH_MS;
}

/**
 * The key a feed needs, read from an environment, or null: for a keyless
 * feed, or a keyed one whose variable is unset or blank. Read at request
 * time, never cached, so a key saved in Provider Settings applies without a
 * restart. The value is handed to the proxy's request and nowhere else.
 * @param {object|null} feed Registry entry.
 * @param {Record<string, string|undefined>|null} env Environment variables.
 * @returns {string|null}
 */
export function transitFeedKey(feed, env) {
  if (!feed?.envVar) return null;
  const value = env ? env[feed.envVar] : undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

/**
 * True when the feed needs a key the environment does not hold. A keyless
 * feed never needs one.
 * @param {object|null} feed Registry entry.
 * @param {Record<string, string|undefined>|null} env Environment variables.
 * @returns {boolean}
 */
export function transitFeedKeyMissing(feed, env) {
  return Boolean(feed?.envVar) && transitFeedKey(feed, env) === null;
}

/**
 * Look up a POLLABLE feed by id. Unknown ids, malformed ids, and feeds that are
 * registered but switched off all return null — this is the only door from a
 * request path to an upstream URL, so a feed the owner has not cleared must not
 * be reachable through it.
 * @param {string} id
 * @returns {object|null}
 */
export function getTransitFeed(id) {
  if (typeof id !== 'string' || !TRANSIT_FEED_ID_PATTERN.test(id)) return null;
  return FEED_BY_ID.get(id) || null;
}

/**
 * Look up any registered feed, enabled or not. For credits and documentation
 * only — never for resolving a request into an upstream fetch.
 * @param {string} id
 * @returns {object|null}
 */
export function getRegisteredTransitFeed(id) {
  if (typeof id !== 'string' || !TRANSIT_FEED_ID_PATTERN.test(id)) return null;
  return ANY_FEED_BY_ID.get(id) || null;
}

/**
 * Great-circle distance in km. Retained for compatibility with existing
 * transit consumers; new shared spatial code should use `greatCircleKm`.
 * @param {number} aLat
 * @param {number} aLon
 * @param {number} bLat
 * @param {number} bLon
 * @returns {number}
 */
export function haversineKm(aLat, aLon, bLat, bLon) {
  return greatCircleKm({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon });
}

/**
 * Feeds whose coverage circle contains the point, nearest first.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [slackKm=0] Extra radius (hysteresis) so a feed at the edge
 *   of coverage does not flap on small camera moves.
 * @returns {object[]}
 */
export function transitFeedsInRange(lat, lon, slackKm = 0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return TRANSIT_ENABLED_FEEDS.map((feed) => ({
    feed,
    km: haversineKm(lat, lon, feed.center.lat, feed.center.lon),
  }))
    .filter(({ feed, km }) => km <= feed.loadRadiusKm + Math.max(0, slackKm))
    .sort((a, b) => a.km - b.km)
    .map(({ feed }) => feed);
}

/**
 * The feed's own hint for a vehicle: its fleet number when the feed maps
 * those (`vehicleMode`), else its route (`routeMode`). Null when neither knows.
 * @param {object} feed Registry entry.
 * @param {string|null} routeId
 * @param {string|null} vehicleId
 * @returns {string|null}
 */
function hintedMode(feed, routeId, vehicleId) {
  const byVehicle =
    typeof feed?.vehicleMode === 'function'
      ? feed.vehicleMode(vehicleId)
      : null;
  if (byVehicle && byVehicle !== 'unknown') return byVehicle;
  return typeof feed?.routeMode === 'function' ? feed.routeMode(routeId) : null;
}

/**
 * Mode for a vehicle: the feed's fleet or route hint when it has one, else
 * its default.
 * @param {object} feed Registry entry.
 * @param {string|null} routeId GTFS route_id from the vehicle's trip.
 * @param {string|null} [vehicleId] GTFS-RT vehicle id.
 * @returns {string} One of TRANSIT_MODES.
 */
export function transitModeFor(feed, routeId, vehicleId = null) {
  const hinted = hintedMode(feed, routeId, vehicleId);
  const mode =
    hinted && hinted !== 'unknown' ? hinted : feed?.defaultMode || 'unknown';
  return TRANSIT_MODES.includes(mode) ? mode : 'unknown';
}

/**
 * Whether the mode came from the route id rather than the feed's default. A
 * default is a guess about a fleet — TransLink's is "bus" while it publishes
 * rail in the same feed — so a consumer judging physical plausibility must
 * not hold a defaulted vehicle to a bus's limits.
 * @param {object} feed Registry entry.
 * @param {string|null} routeId
 * @param {string|null} [vehicleId]
 * @returns {boolean}
 */
export function transitModeResolved(feed, routeId, vehicleId = null) {
  const hinted = hintedMode(feed, routeId, vehicleId);
  return (
    Boolean(hinted) && hinted !== 'unknown' && TRANSIT_MODES.includes(hinted)
  );
}

/**
 * The route as a rider would say it. Most feeds publish that already, so this
 * is identity for them; a feed that publishes internal keys supplies its own
 * `routeLabel`. Never invents a label: an id the feed does not know survives
 * unchanged, because a raw id a person can compare against the bus is more
 * use than a blank.
 * @param {object|null} feed Registry entry.
 * @param {string|null} routeId
 * @returns {string|null}
 */
export function transitRouteLabel(feed, routeId) {
  if (!routeId || typeof feed?.routeLabel !== 'function') return routeId;
  const named = feed.routeLabel(routeId);
  return typeof named === 'string' && named ? named : routeId;
}

/**
 * Public catalog shape served by `/api/transit/feeds` — everything the browser
 * needs to gate polling and credit the source, and nothing it could misuse.
 * A keyed feed says which variable it reads (`envVar`) and whether that key
 * is currently missing (`keyRequired`); the key itself never appears.
 * @param {Record<string, string|undefined>|null} [env] Environment the proxy
 *   reads keys from; without one every keyed feed reports its key missing.
 * @returns {object[]}
 */
export function publicTransitCatalog(env = null) {
  return TRANSIT_ENABLED_FEEDS.map((feed) => ({
    id: feed.id,
    name: feed.name,
    operator: feed.operator,
    region: feed.region,
    center: { ...feed.center },
    loadRadiusKm: feed.loadRadiusKm,
    license: feed.license,
    licenseUrl: feed.licenseUrl,
    attribution: feed.attribution,
    historyRetention: feed.historyRetention === true,
    refreshMs: transitFeedRefreshMs(feed),
    envVar: feed.envVar || null,
    keyRequired: transitFeedKeyMissing(feed, env),
  }));
}
