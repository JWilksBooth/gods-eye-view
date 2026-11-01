import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  INCIDENT_STALE_MAX_MS,
  createIncidentStore,
  incidentsProxy,
} from './incidents.js';
import { parseChpIncidents, parseChpLatLon } from './incidents/chp.js';
import { dataSfSinceStamp, parseDataSfCalls } from './incidents/datasf.js';
import { parseCalFireIncidents } from './incidents/calfire.js';
import {
  nvroadsEventToIncident,
  parseNvroadsEvents,
} from './incidents/nvroadsEvents.js';
import {
  lafdAddress,
  parseLafdAlerts,
  placeLafdAlerts,
} from './incidents/lafd.js';
import {
  classifyIncidentType,
  pacificToUtcMs,
  parsePacificStamp,
} from './incidents/common.js';

const CHP_XML = `<State><Center ID="LAHB"><Dispatch ID="LACC">
  <Log ID="260615LA2002">
    <LogTime>"Jun 15 2026  5:21PM"</LogTime>
    <LogType>"1179-Trfc Collision-1141 Enrt"</LogType>
    <Location>"Angeles Crest Hwy / Mm 30.50"</Location>
    <LocationDesc>"ANGELES CREST HWY JSO MM30.5"</LocationDesc>
    <Area>"Altadena"</Area>
    <LATLON>"34260464:118190693"</LATLON>
    <LogDetails>
      <details><DetailTime>"Jun 15 2026  5:23PM"</DetailTime><IncidentDetail>"[6] VEH OFF RDWAY"</IncidentDetail></details>
      <units><UnitTime>"Jun 15 2026  5:24PM"</UnitTime><UnitDetail>"Unit Enroute"</UnitDetail></units>
    </LogDetails>
  </Log>
</Dispatch><Dispatch ID="GGCC">
  <Log ID="260615GG0100">
    <LogTime>"Jun 15 2026  5:30PM"</LogTime>
    <LogType>"1125-Traffic Hazard"</LogType>
    <Location>"Us101 N / River Rd"</Location>
    <Area>"Santa Rosa"</Area>
    <LATLON>"38520000:122790000"</LATLON>
  </Log>
  <Log ID="260615GG0101">
    <LogTime>"Jun 15 2026  5:31PM"</LogTime>
    <LogType>"CLOSURE of a Road"</LogType>
    <Location>"I80 E / Somewhere"</Location>
    <Area>"Truckee"</Area>
    <LATLON>"39320000:120180000"</LATLON>
  </Log>
  <Log ID="260615GG0102">
    <LogTime>"Jun 15 2026  5:32PM"</LogTime>
    <LogType>"Vehicle Fire"</LogType>
    <Location>"I80 W / Treasure Island"</Location>
    <Area>"San Francisco"</Area>
    <LATLON>"0:0"</LATLON>
  </Log>
</Dispatch></Center></State>`;

test('CHP timestamps are Pacific wall-clock times, daylight or standard', () => {
  assert.equal(
    parsePacificStamp('Jun 15 2026  5:21PM'),
    Date.parse('2026-06-16T00:21:00Z'),
  );
  assert.equal(
    parsePacificStamp('Jan 5 2026 12:05AM'),
    Date.parse('2026-01-05T08:05:00Z'),
  );
  assert.equal(parsePacificStamp('yesterday'), null);
  assert.equal(
    pacificToUtcMs({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }),
    Date.parse('2026-03-08T10:00:00Z'),
  );
});

test('CHP LATLON is microdegrees with the west sign dropped', () => {
  assert.deepEqual(parseChpLatLon('34260464:118190693'), {
    lat: 34.260464,
    lon: -118.190693,
  });
  assert.equal(parseChpLatLon('0:0'), null);
  assert.equal(parseChpLatLon('34.26,-118.19'), null);
});

test('every CHP center is parsed and rows are kept by LIVE OPS region', () => {
  const rows = parseChpIncidents(CHP_XML);
  assert.deepEqual(
    rows.map((row) => [row.id, row.region, row.type]),
    [
      ['chp:260615LA2002', 'los-angeles', 'traffic'],
      ['chp:260615GG0100', 'sonoma-county', 'hazard'],
    ],
  );
  assert.equal(rows[0].agency, 'CHP Los Angeles');
  assert.equal(rows[0].typeDetail, 'Trfc Collision-1141 Enrt');
  assert.equal(rows[0].description, 'VEH OFF RDWAY');
  assert.equal(rows[0].area, 'Altadena');
  assert.equal(rows[0].time, Date.parse('2026-06-16T00:21:00Z'));
  assert.equal(rows[1].agency, 'CHP Golden Gate');
  // Outside every region, and no position, are dropped, never guessed.
  assert.equal(parseChpIncidents(CHP_XML, { onlyRegions: false }).length, 3);
});

test('incident type classification reads an agency type text', () => {
  assert.equal(classifyIncidentType('1182-Trfc Collision-No Inj'), 'traffic');
  assert.equal(classifyIncidentType('Vehicle Fire'), 'fire');
  assert.equal(classifyIncidentType('SIG Alert'), 'closure');
  assert.equal(classifyIncidentType('Live or Dead Animal'), 'hazard');
  assert.equal(classifyIncidentType('ROBBERY'), 'police');
  assert.equal(classifyIncidentType('???', 'police'), 'police');
});

test('DataSF calls carry their intersection point and a Pacific floating time', () => {
  const rows = parseDataSfCalls([
    {
      cad_number: '261230123',
      received_datetime: '2026-06-15T17:21:00.000',
      call_type_final_desc: 'TRAFFIC COLLISION',
      priority_final: 'B',
      agency: 'Police',
      intersection_name: 'MARKET ST \\ 5TH ST',
      intersection_point: { type: 'Point', coordinates: [-122.4084, 37.7838] },
      police_district: 'Tenderloin',
      analysis_neighborhood: 'Tenderloin',
    },
    { cad_number: 'nopoint', received_datetime: '2026-06-15T17:21:00.000' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'datasf-police:261230123');
  assert.equal(rows[0].region, 'sf-bay-area');
  assert.equal(rows[0].type, 'traffic');
  assert.equal(rows[0].agency, 'SF Police');
  assert.equal(rows[0].time, Date.parse('2026-06-16T00:21:00Z'));
  assert.equal(rows[0].description, 'Priority B · Tenderloin district');
  assert.match(
    dataSfSinceStamp(Date.parse('2026-06-16T00:21:00Z'), 60 * 60_000),
    /^2026-06-15T16:21:00$/,
  );
  assert.throws(() => parseDataSfCalls({ error: true }), /no list/);
});

test('CAL FIRE incidents inside a region become fire rows with their facts', () => {
  const rows = parseCalFireIncidents([
    {
      UniqueId: 'abc-123',
      Name: 'Glass Fire',
      Updated: '2026-06-15T18:00:00Z',
      County: 'Sonoma',
      Location: 'North of Santa Rosa',
      AcresBurned: 1200.4,
      PercentContained: 35,
      Latitude: 38.6,
      Longitude: -122.6,
      Type: 'Wildfire',
      IsActive: true,
      Url: 'https://www.fire.ca.gov/incidents/2026/6/15/glass-fire',
    },
    { UniqueId: 'far', Latitude: 40.9, Longitude: -121.5, IsActive: true },
    { UniqueId: 'old', Latitude: 38.6, Longitude: -122.6, IsActive: false },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'calfire:abc-123');
  assert.equal(rows[0].region, 'sonoma-county');
  assert.equal(rows[0].type, 'fire');
  assert.equal(rows[0].area, 'Sonoma County');
  assert.equal(rows[0].description, '1200 acres · 35% contained');
  assert.equal(rows[0].location, 'Glass Fire · North of Santa Rosa');
});

test('Nevada 511 events parse both the developer API and the site table shapes', () => {
  const api = nvroadsEventToIncident({
    ID: 'NV-1',
    RoadwayName: 'I-15',
    DirectionOfTravel: 'Northbound',
    Description: 'Crash blocking the right lane',
    LastUpdated: 1781569260,
    Latitude: 36.1,
    Longitude: -115.17,
    EventType: 'accidentsAndIncidents',
    EventSubType: 'Crash',
    LanesAffected: '1 right lane',
    IsFullClosure: false,
    Severity: 'Minor',
  });
  assert.equal(api.id, 'nvroads:NV-1');
  assert.equal(api.type, 'traffic');
  assert.equal(api.region, 'las-vegas');
  assert.equal(api.time, 1781569260000);
  assert.equal(api.location, 'I-15 Northbound');
  assert.equal(
    api.description,
    'Crash blocking the right lane · Lanes: 1 right lane · Severity Minor',
  );
  const table = parseNvroadsEvents({
    data: [
      {
        id: 7,
        roadwayName: 'US-95',
        description: 'Road work',
        eventType: 'roadwork',
        latLng: { geography: { wellKnownText: 'POINT (-115.2 36.2)' } },
        lastUpdated: '2026-06-15T17:21:00Z',
      },
      { id: 8, latitude: 39.5, longitude: -119.8, eventType: 'closures' },
    ],
  });
  assert.equal(table.length, 1);
  assert.equal(table[0].type, 'closure');
  assert.equal(table[0].id, 'nvroads:7');
});

test('LAFD alerts are placed only when their address geocodes inside Los Angeles', async () => {
  assert.equal(
    lafdAddress('Structure Fire 10/30/2026 INC#1733 1234 N Main St'),
    '1234 N Main St',
  );
  assert.equal(
    lafdAddress('Brush fire near Sunset Blvd / Vermont Ave this morning'),
    'Sunset Blvd / Vermont Ave',
  );
  assert.equal(lafdAddress('No address here'), null);
  const xml = `<rss><channel>
    <item><title>Structure Fire 10/30/2026 INC#1733</title><link>https://www.lafd.org/alert/1733</link>
      <description><![CDATA[<p>1234 N Main St; firefighters knocked down the fire.</p>]]></description>
      <pubDate>Fri, 30 Oct 2026 16:00:00 +0000</pubDate></item>
    <item><title>Traffic Collision</title><link>https://www.lafd.org/alert/1734</link>
      <description>9999 Nowhere Ave</description><pubDate>Fri, 30 Oct 2026 16:05:00 +0000</pubDate></item>
    <item><title>Unplaceable</title><link>https://www.lafd.org/alert/1735</link><description>text</description></item>
  </channel></rss>`;
  const alerts = parseLafdAlerts(xml);
  assert.equal(alerts.length, 3);
  const asked = [];
  const rows = await placeLafdAlerts(alerts, {
    now: () => Date.parse('2026-10-30T17:00:00Z'),
    geocode: async (address) => {
      asked.push(address);
      return address.startsWith('1234') ? { lat: 34.06, lon: -118.24 } : null;
    },
  });
  assert.deepEqual(asked, ['1234 N Main St', '9999 Nowhere Ave']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'lafd-alerts:www.lafd.org/alert/1733');
  assert.equal(rows[0].type, 'fire');
  assert.equal(rows[0].typeDetail, 'Structure Fire');
  assert.equal(rows[0].region, 'los-angeles');
});

function fakeSources(loaders) {
  return Object.entries(loaders).map(([id, load]) => ({
    id,
    label: id,
    agency: id,
    refreshMs: 60_000,
    enabled: () => true,
    load,
  }));
}

const row = (source, id, region, extra = {}) => ({
  id: `${source}:${id}`,
  source,
  sourceLabel: source,
  agency: source,
  type: 'traffic',
  typeDetail: null,
  lat: 34,
  lon: -118,
  location: null,
  area: null,
  time: 1_000_000,
  description: null,
  region,
  url: null,
  ...extra,
});

test('sources refresh independently; a failed source keeps its last rows, marked stale', async () => {
  let clock = 10_000_000;
  let chpFails = false;
  let loads = 0;
  const store = createIncidentStore({
    now: () => clock,
    warn: () => {},
    sources: fakeSources({
      chp: async () => {
        loads += 1;
        if (chpFails) throw new Error('ENOTFOUND');
        return [row('chp', '1', 'los-angeles', { time: clock - 1000 })];
      },
      nvroads: async () => [
        row('nvroads', '2', 'las-vegas', { type: 'closure', time: clock }),
      ],
    }),
  });
  const first = await store.snapshot();
  assert.equal(first.rows.length, 2);
  assert.equal(first.rows[0].id, 'nvroads:2');
  assert.equal(first.stale, false);
  assert.deepEqual(
    first.sources.map((entry) => [entry.id, entry.ok, entry.count]),
    [
      ['chp', true, 1],
      ['nvroads', true, 1],
    ],
  );
  // Within the refresh interval nothing is fetched again.
  await store.snapshot();
  assert.equal(loads, 1);
  // A failure after the interval serves the last snapshot, marked stale.
  clock += 61_000;
  chpFails = true;
  const stale = await store.snapshot({ region: 'los-angeles' });
  assert.equal(loads, 2);
  assert.equal(stale.rows.length, 1);
  assert.equal(stale.rows[0].source, 'chp');
  const chp = stale.sources.find((entry) => entry.id === 'chp');
  assert.equal(chp.ok, false);
  assert.equal(chp.stale, true);
  assert.match(chp.error, /ENOTFOUND/);
  // The other source is still live, so the answer as a whole is not stale.
  assert.equal(stale.stale, false);
  // Filtering by region and type reads the normalized rows.
  const closures = await store.snapshot({ type: 'closure' });
  assert.deepEqual(
    closures.rows.map((entry) => entry.id),
    ['nvroads:2'],
  );
  // Past the stale ceiling the failed source's rows are dropped.
  clock += INCIDENT_STALE_MAX_MS + 1;
  const dropped = await store.snapshot({ region: 'los-angeles' });
  assert.equal(dropped.rows.length, 0);
});

function request(url, method = 'GET') {
  const req = new EventEmitter();
  Object.assign(req, {
    method,
    url,
    headers: { host: 'localhost:4173' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = new EventEmitter();
  const out = { status: null, headers: null, body: '' };
  Object.assign(res, {
    destroyed: false,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(body) {
      out.body = body || '';
    },
    setHeader() {},
  });
  return { req, res, out };
}

test('the /api/incidents route validates its query and serves the merged snapshot', async () => {
  const plugin = incidentsProxy({
    now: () => 10_000_000,
    warn: () => {},
    sources: fakeSources({
      chp: async () => [row('chp', '1', 'los-angeles', { time: 9_999_000 })],
    }),
  });
  let handler;
  plugin.configureServer({
    middlewares: {
      use: (path, fn) => {
        assert.equal(path, '/api/incidents');
        handler = fn;
      },
    },
  });
  let call = request('/?region=mars');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 400);
  assert.deepEqual(JSON.parse(call.out.body).regions, [
    'los-angeles',
    'sonoma-county',
    'sf-bay-area',
    'las-vegas',
  ]);
  call = request('/?type=weather');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 400);
  call = request('/', 'POST');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 405);
  call = request('/?region=los-angeles&type=traffic');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 200);
  const payload = JSON.parse(call.out.body);
  assert.equal(payload.region, 'los-angeles');
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.sources[0].refreshMs, 60_000);
  assert.equal(call.out.headers['Cache-Control'], 'no-store');
});
