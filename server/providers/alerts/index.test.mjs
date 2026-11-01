import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createAlert } from '../../../src/layers/alerts/model.js';
import {
  ALERTS_ASSEMBLY_TTL_MS,
  airportsPayload,
  alertsProxy,
  assembleAlerts,
  createAlertFeedSources,
  narrowAlertsPayload,
  parseAlertsQuery,
} from './index.js';
import { createFeedGovernor } from './governor.js';
import { UpstreamError } from './http.js';

const NOW = Date.parse('2026-11-01T17:00:00Z');

const alert = (id, fields = {}) =>
  createAlert(
    {
      id,
      source: id.split(':')[0],
      kind: 'weather',
      severity: 'moderate',
      agency: 'Fixture Agency',
      headline: `Headline ${id}`,
      regions: ['los-angeles'],
      issued: NOW - 60_000,
      area: { type: 'Point', coordinates: [-118.25, 34.05] },
      ...fields,
    },
    { fetchedAt: NOW },
  );

/** A source with its own governor, answering from `load`. */
function source(id, load, extra = {}) {
  const definition = {
    id,
    label: `${id} label`,
    home: `https://${id}.example/`,
    licence: 'Fixture licence',
    refreshMs: 60_000,
    staleMaxMs: 10 * 60_000,
    budgetPerHour: 10,
    load,
    ...extra,
  };
  return {
    ...definition,
    governor: createFeedGovernor({
      id,
      ttlMs: definition.refreshMs,
      staleMaxMs: definition.staleMaxMs,
      budgetPerHour: definition.budgetPerHour,
      now: () => NOW,
    }),
  };
}

function fixtureSources() {
  return [
    source('nws', async () => ({
      alerts: [
        alert('nws:la', { severity: 'severe' }),
        alert('nws:bay', { regions: ['sf-bay-area'], severity: 'minor' }),
      ],
    })),
    source('caltrans', async () => ({
      partial: true,
      alerts: [
        alert('caltrans:7:1', { kind: 'road', severity: 'minor' }),
        alert('nws:la', { kind: 'road' }),
      ],
    })),
    source('faa', async () => ({
      updatedAt: '2026-11-01T16:59:00.000Z',
      events: [
        { airport: 'SFO', status: 'ground_delay', avgDelay: '1 hour' },
        { airport: 'LAS', status: 'restriction' },
        { airport: 'LAS', status: 'delay', type: 'Arrival' },
        { airport: 'JFK', status: 'ground_stop' },
      ],
      alerts: [
        alert('faa:SFO:ground_delay:all', {
          kind: 'airport',
          regions: ['sf-bay-area'],
        }),
      ],
    })),
    source('broken', async () => {
      throw new UpstreamError(
        'Upstream said: <html>key=SECRET https://upstream.example/</html>',
      );
    }),
    source('json-broken', async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    }),
    source('keyed', async () => ({ alerts: [alert('keyed:1')] }), {
      envVar: 'FIXTURE_KEY',
      keyMissing: () => true,
    }),
  ];
}

function request(url, method = 'GET', headers = {}) {
  const req = new EventEmitter();
  Object.assign(req, {
    method,
    url,
    headers: { host: 'localhost:4173', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = new EventEmitter();
  const out = { status: null, headers: null, body: '' };
  Object.assign(res, {
    destroyed: false,
    statusCode: 200,
    writeHead(status, written) {
      out.status = status;
      out.headers = written;
    },
    setHeader(name, value) {
      out.headers = { ...(out.headers || {}), [name]: value };
    },
    end(body) {
      out.status ??= res.statusCode;
      out.body = body || '';
    },
  });
  return { req, res, out };
}

test('assembly merges feeds worst first, once each, with feed states as codes', async () => {
  const payload = await assembleAlerts(fixtureSources(), { now: () => NOW });
  assert.equal(payload.schemaVersion, 1);
  assert.deepEqual(
    payload.alerts.map((entry) => entry.id),
    ['nws:la', 'faa:SFO:ground_delay:all', 'caltrans:7:1', 'nws:bay'],
  );
  assert.ok(payload.alerts.every((entry) => entry.freshness === 'live'));
  const states = Object.fromEntries(
    payload.sources.map((entry) => [entry.id, entry]),
  );
  assert.equal(states.nws.status, 'ok');
  assert.equal(states.nws.count, 2);
  assert.equal(states.caltrans.partial, true);
  assert.equal(states.broken.status, 'unavailable');
  assert.equal(states.broken.error, 'unavailable');
  assert.equal(states['json-broken'].error, 'invalid_payload');
  assert.equal(states.keyed.status, 'key-required');
  assert.equal(states.keyed.envVar, 'FIXTURE_KEY');
  assert.equal(payload.stale, true, 'a failed feed marks the payload stale');
  assert.doesNotMatch(
    JSON.stringify(payload),
    /SECRET|upstream\.example|Unexpected token/,
  );
  assert.deepEqual(
    payload.regions.map((region) => region.id),
    ['los-angeles', 'sonoma-county', 'sf-bay-area', 'las-vegas'],
  );
});

test('queries narrow by region, kind and minimum severity, or are refused', async () => {
  const payload = await assembleAlerts(fixtureSources(), { now: () => NOW });
  const query = (text) => parseAlertsQuery(new URLSearchParams(text));
  assert.deepEqual(
    query('region=SF-Bay-Area&kind=road,weather&severity=minor'),
    {
      region: 'sf-bay-area',
      kinds: ['road', 'weather'],
      minSeverity: 'minor',
    },
  );
  assert.equal(query('region=atlantis').error, 'unknown_region');
  assert.equal(query('kind=volcano').error, 'unknown_kind');
  assert.equal(query('severity=awful').error, 'unknown_severity');
  const bay = narrowAlertsPayload(payload, query('region=sf-bay-area'));
  assert.equal(bay.region, 'sf-bay-area');
  assert.deepEqual(
    bay.alerts.map((entry) => entry.id),
    ['faa:SFO:ground_delay:all', 'nws:bay'],
  );
  assert.equal(bay.sources.find((entry) => entry.id === 'nws').count, 1);
  const severe = narrowAlertsPayload(payload, query('severity=severe'));
  assert.deepEqual(
    severe.alerts.map((entry) => entry.id),
    ['nws:la'],
  );
  const roads = narrowAlertsPayload(payload, query('kind=road'));
  assert.deepEqual(
    roads.alerts.map((entry) => entry.id),
    ['caltrans:7:1'],
  );
  assert.equal(narrowAlertsPayload(payload, query('')), payload);
});

test('airport status lists the regions’ airports and every FAA event', async () => {
  const [, , faa] = fixtureSources();
  const result = {
    value: await faa.load(),
    fetchedAt: NOW,
    stale: false,
    status: 'ok',
    error: null,
  };
  const payload = airportsPayload(result);
  const byCode = Object.fromEntries(
    payload.airports.map((entry) => [entry.code, entry]),
  );
  assert.equal(byCode.SFO.status, 'ground_delay');
  assert.equal(
    byCode.LAS.status,
    'restriction',
    'the worse of restriction and delay',
  );
  assert.equal(byCode.LAX.status, 'normal');
  assert.deepEqual(byCode.STS.regions, ['sonoma-county']);
  const jfk = payload.events.find((event) => event.airport === 'JFK');
  assert.equal(jfk.lat, null);
  assert.deepEqual(jfk.regions, []);
  assert.equal(
    airportsPayload({ value: null, status: 'unavailable', fetchedAt: null })
      .airports[0].status,
    'unknown',
  );
});

test('the routes serve, narrow and refuse without repeating upstream text', async () => {
  const plugin = alertsProxy({ sources: fixtureSources(), now: () => NOW });
  let handler;
  plugin.configureServer({
    middlewares: {
      use: (path, fn) => {
        assert.equal(path, '/api/alerts');
        handler = fn;
      },
    },
  });
  let call = request('/?region=los-angeles');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 200);
  assert.equal(call.out.headers['Cache-Control'], 'no-store');
  assert.equal(call.out.headers['X-Data-Stale'], 'true');
  const payload = JSON.parse(call.out.body);
  assert.equal(payload.region, 'los-angeles');
  assert.deepEqual(
    payload.alerts.map((entry) => entry.id),
    ['nws:la', 'caltrans:7:1'],
  );
  assert.doesNotMatch(call.out.body, /SECRET|upstream\.example/);

  for (const [url, status, error] of [
    ['/?region=atlantis', 400, 'unknown_region'],
    ['/?kind=volcano', 400, 'unknown_kind'],
    ['/nope', 404, 'unknown_route'],
    ['/airnow', 503, 'no_key'],
  ]) {
    call = request(url);
    await handler(call.req, call.res);
    assert.equal(call.out.status, status, url);
    assert.equal(JSON.parse(call.out.body).error, error, url);
  }
  call = request('/', 'POST');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 405);
  call = request('/', 'GET', {
    origin: 'https://elsewhere.example',
    'sec-fetch-site': 'cross-site',
  });
  await handler(call.req, call.res);
  assert.equal(call.out.status, 403);

  call = request('/airports');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 200);
  assert.equal(JSON.parse(call.out.body).events.length, 4);
  call = request('/status');
  await handler(call.req, call.res);
  const status = JSON.parse(call.out.body);
  const broken = status.sources.find((entry) => entry.id === 'broken');
  assert.equal(broken.lastError, 'unavailable');
  assert.equal(
    status.sources.find((entry) => entry.id === 'keyed').keyRequired,
    true,
  );
  assert.doesNotMatch(
    call.out.body,
    /SECRET|upstream\.example|Unexpected token/,
  );
  const snapshot = await plugin.snapshot({ region: 'sf-bay-area' });
  assert.equal(snapshot.alerts.length, 2);
  assert.ok(ALERTS_ASSEMBLY_TTL_MS > 0);
});

test('the AirNow route serves readings once its key is set', async () => {
  const env = {};
  const rows = [
    {
      Latitude: 36.1,
      Longitude: -115.1,
      UTC: '2026-11-01T16:00',
      Parameter: 'OZONE',
      AQI: 155,
      Category: 4,
      SiteName: 'Fixture',
      FullAQSCode: '1',
    },
  ];
  const plugin = alertsProxy({
    env,
    now: () => NOW,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.startsWith('https://www.airnowapi.org/'))
        return new Response(JSON.stringify(rows));
      return new Response('unavailable', { status: 503 });
    },
  });
  let handler;
  plugin.configureServer({ middlewares: { use: (_, fn) => (handler = fn) } });
  let call = request('/airnow');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 503);
  env.AIRNOW_API_KEY = 'fixture-key';
  call = request('/airnow');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 200);
  const payload = JSON.parse(call.out.body);
  assert.equal(payload.readings.length, 1);
  assert.equal(payload.readings[0].region, 'las-vegas');
  assert.doesNotMatch(call.out.body, /fixture-key/);
  call = request('/?region=las-vegas&kind=air');
  await handler(call.req, call.res);
  const alerts = JSON.parse(call.out.body);
  assert.deepEqual(
    alerts.alerts.map((entry) => entry.severity),
    ['severe'],
  );
  const airnow = alerts.sources.find((entry) => entry.id === 'airnow');
  assert.equal(airnow.status, 'ok');
  assert.ok(
    alerts.sources
      .filter((entry) => entry.id !== 'airnow')
      .every((entry) => entry.status !== 'ok' || entry.count === 0),
  );
  assert.doesNotMatch(call.out.body, /fixture-key/);
});

test('every feed is constructed with a governor and its key state', () => {
  const sources = createAlertFeedSources({
    env: {},
    fetchImpl: async () => new Response(''),
  });
  assert.deepEqual(
    sources.map((entry) => entry.id),
    [
      'nws',
      'calfire',
      'caltrans',
      'faa',
      'airnow',
      'bart',
      'sf511',
      'lametro-bus',
      'lametro-rail',
      'rtc',
      'caloes',
      'socoemergency',
      'lafd',
    ],
  );
  for (const entry of sources) {
    assert.equal(typeof entry.governor.acquire, 'function', entry.id);
    assert.ok(entry.budgetPerHour > 0 && entry.refreshMs > 0, entry.id);
  }
  const keyed = sources.filter((entry) => entry.keyMissing?.());
  assert.deepEqual(
    keyed.map((entry) => entry.envVar),
    [
      'AIRNOW_API_KEY',
      'BAY_AREA_511_API_KEY',
      'SWIFTLY_API_KEY',
      'SWIFTLY_API_KEY',
      'SWIFTLY_API_KEY',
    ],
  );
});
