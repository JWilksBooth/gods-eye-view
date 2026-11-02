/**
 * @module sf511Operators
 * @description The transit operators 511 SF Bay carries, by the two-character
 * operator id its APIs use (`agency=SF`, `agency=BA`, …).
 *
 * Two readers share this table. The Transit layer reads the regional
 * GTFS-Realtime vehicle-positions feed (`agency=RG`), which carries every
 * monitored operator in one message, and needs the operator behind a route
 * to pick a mode and to say "Muni 14" rather than "Route SF:14". The alerts
 * provider names the operators a service alert is about. Keeping the ids in
 * one place means a renamed operator is renamed once.
 *
 * `mode` is the operator's usual vehicle kind in the Transit layer's
 * vocabulary (bus, tram, subway, rail, ferry); an operator that runs more
 * than one kind (Muni, VTA) is refined by route in `sf511RouteMode`.
 *
 * Pure data and pure helpers: imported by the browser bundle and the Node
 * providers alike, so nothing here touches the network or Node built-ins.
 */

const operator = (name, short, mode) => Object.freeze({ name, short, mode });

/** Operator id → public name, the short name a rider says, and usual mode. */
export const SF511_OPERATORS = Object.freeze({
  '3D': operator('Tri Delta Transit', 'Tri Delta', 'bus'),
  AC: operator('AC Transit', 'AC Transit', 'bus'),
  AM: operator('Capitol Corridor', 'Capitol Corridor', 'rail'),
  BA: operator('BART', 'BART', 'subway'),
  CC: operator('County Connection', 'County Connection', 'bus'),
  CE: operator('ACE', 'ACE', 'rail'),
  CM: operator('Commute.org Shuttles', 'Commute.org', 'bus'),
  CT: operator('Caltrain', 'Caltrain', 'rail'),
  DE: operator('Dumbarton Express', 'Dumbarton Express', 'bus'),
  EM: operator('Emery Go-Round', 'Emery Go-Round', 'bus'),
  FS: operator('FAST', 'FAST', 'bus'),
  GF: operator('Golden Gate Ferry', 'Golden Gate Ferry', 'ferry'),
  GG: operator('Golden Gate Transit', 'Golden Gate Transit', 'bus'),
  MA: operator('Marin Transit', 'Marin Transit', 'bus'),
  PE: operator('Petaluma Transit', 'Petaluma Transit', 'bus'),
  SA: operator('SMART', 'SMART', 'rail'),
  SB: operator('San Francisco Bay Ferry', 'SF Bay Ferry', 'ferry'),
  SC: operator('Sonoma County Transit', 'Sonoma County Transit', 'bus'),
  SF: operator('San Francisco Muni', 'Muni', 'bus'),
  SI: operator('SFO AirTrain', 'SFO AirTrain', 'tram'),
  SM: operator('SamTrans', 'SamTrans', 'bus'),
  SR: operator('Santa Rosa CityBus', 'Santa Rosa CityBus', 'bus'),
  ST: operator('SolTrans', 'SolTrans', 'bus'),
  TD: operator('Tri Delta Transit', 'Tri Delta', 'bus'),
  UC: operator('Union City Transit', 'Union City Transit', 'bus'),
  VT: operator('VTA', 'VTA', 'bus'),
  WC: operator('WestCAT', 'WestCAT', 'bus'),
});

/** Operator id → public name, the shape the alerts provider has always used. */
export const SF511_AGENCY_NAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(SF511_OPERATORS).map(([id, entry]) => [id, entry.name]),
  ),
);

/**
 * Split a regional-feed id into its operator prefix and the operator's own
 * id. The regional feeds keep ids unique across thirty operators by
 * prefixing them with the operator id and a colon (`SF:14`); an id without a
 * known prefix is returned whole with a null operator, so an operator the
 * table does not know, or a feed that turns out not to prefix, degrades to
 * the raw id rather than to nothing.
 * @param {string|null|undefined} id
 * @returns {{ operator: string|null, local: string }}
 */
export function splitSf511Id(id) {
  const text = typeof id === 'string' ? id.trim() : '';
  const match = /^([A-Za-z0-9]{2}):(.+)$/.exec(text);
  if (match && SF511_OPERATORS[match[1].toUpperCase()]) {
    return { operator: match[1].toUpperCase(), local: match[2] };
  }
  return { operator: null, local: text };
}

/** Muni Metro and streetcar lines, and the three cable-car routes. */
const MUNI_RAIL_ROUTES = new Set([
  'J',
  'K',
  'L',
  'M',
  'N',
  'T',
  'KT',
  'S',
  'E',
  'F',
  '59',
  '60',
  '61',
]);

/**
 * Transit-layer mode for a route in the 511 regional feed, from the operator
 * prefix: BART is a subway, Caltrain, SMART, ACE and the Capitol Corridor are
 * trains, the ferries are ferries, and Muni's and VTA's rail lines are trams.
 * Without a recognised prefix the mode is unknown, so the feed default applies
 * and the layer treats the mode as a guess rather than a fact.
 * @param {string|null} routeId
 * @returns {string}
 */
export function sf511RouteMode(routeId) {
  const { operator: id, local } = splitSf511Id(routeId);
  if (!id) return 'unknown';
  const entry = SF511_OPERATORS[id];
  if (id === 'SF')
    return MUNI_RAIL_ROUTES.has(local.toUpperCase()) ? 'tram' : 'bus';
  if (id === 'VT') {
    return /^(9\d\d|blue|green|orange)\b/i.test(local) ? 'tram' : 'bus';
  }
  return entry.mode;
}

/**
 * The route as a rider would say it, operator first: `SF:14` reads
 * "Muni 14", `BA:Yellow-N` reads "BART Yellow-N". An id without a known
 * prefix is returned unchanged.
 * @param {string|null} routeId
 * @returns {string|null}
 */
export function sf511RouteLabel(routeId) {
  const { operator: id, local } = splitSf511Id(routeId);
  if (!id) return routeId;
  return `${SF511_OPERATORS[id].short} ${local}`;
}
