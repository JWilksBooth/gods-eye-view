import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import { createTransitService } from 'osiris/sources/transit-service';
import { createTransitSource } from 'osiris/layers/transit/source';

const request = (path, method = 'GET') => ({
  url: `https://example.test${path}`,
  method,
});

test('portable service confines requests to registered feeds and GET', async (t) => {
  let calls = 0;
  const service = createTransitService({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  t.after(service.close);
  for (const path of [
    '/other',
    '/api/transit/vehicles/unknown',
    '/api/transit/vehicles/https%3A%2F%2Fexample.test',
  ]) {
    assert.equal((await service.handle(request(path))).status, 404);
  }
  for (const method of ['POST', 'HEAD', 'TRACE']) {
    assert.equal(
      (await service.handle(request('/api/transit/feeds', method))).status,
      405,
    );
  }
  const response = await service.handle(request('/api/transit/feeds'));
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).feeds.some((feed) => feed.id === 'mbta'));
  assert.equal(calls, 0);
  service.close();
  assert.equal(
    (await service.handle(request('/api/transit/feeds'))).status,
    503,
  );
});

test('source sends snapshots and bounded history through the supplied transport', async () => {
  const calls = [];
  const controller = new AbortController();
  const payload = {
    version: 1,
    feedId: 'mbta',
    vehicleId: 'bus 1',
    fixes: [],
    epochs: [],
  };
  const source = createTransitSource({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(url.includes('/trail/') ? payload : { count: 0 });
    },
  });
  assert.deepEqual(
    await (
      await source.requestSnapshot('mbta', { signal: controller.signal })
    ).json(),
    { count: 0 },
  );
  assert.deepEqual(
    await source.getHistory('mbta', 'bus 1', { signal: controller.signal }),
    payload,
  );
  assert.deepEqual(
    calls.map(({ url }) => url),
    ['/api/transit/vehicles/mbta', '/api/transit/trail/mbta/bus%201'],
  );
  assert.ok(calls.every(({ init }) => init.signal === controller.signal));
  controller.abort();
  assert.throws(
    () => source.requestSnapshot('mbta', { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.throws(
    () => source.getHistory('mbta', 'bus 1', { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls.length, 2);
});

test('source retains history validation and never retries through another transport', async () => {
  let calls = 0;
  const source = createTransitSource({
    fetchImpl: async () => {
      calls++;
      return Response.json({
        version: 1,
        feedId: 'wrong',
        vehicleId: 'bus',
        fixes: [],
        epochs: [],
      });
    },
  });
  await assert.rejects(
    source.getHistory('mbta', 'bus'),
    /Invalid transit history response/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    source.getHistory('mbta', '../bus'),
    /Invalid transit vehicle identifier/,
  );
  assert.equal(calls, 1);
});

test('snapshot cancellation covers headers and body parsing', async () => {
  for (const phase of ['headers', 'body']) {
    const controller = new AbortController();
    const source = createTransitSource({
      fetchImpl: async () => {
        if (phase === 'headers') controller.abort();
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => {
            controller.abort();
            return { vehicles: [] };
          },
        };
      },
    });
    await assert.rejects(
      async () => {
        const response = await source.requestSnapshot('mbta', {
          signal: controller.signal,
        });
        await response.json();
      },
      { name: 'AbortError' },
    );
  }
});

/** A full-dataset FeedMessage with one vehicle at the given place. */
function oneVehicleFeed(id, lat, lon, timestamp = 1_700_000_000) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(2, 0);
  header.writeVarintField(3, timestamp);
  writer.writeBytesField(1, header.finish());
  const entity = new PbfWriter();
  entity.writeStringField(1, id);
  const vehicle = new PbfWriter();
  const position = new PbfWriter();
  position.writeFloatField(1, lat);
  position.writeFloatField(2, lon);
  vehicle.writeBytesField(2, position.finish());
  vehicle.writeVarintField(5, timestamp);
  const descriptor = new PbfWriter();
  descriptor.writeStringField(1, id);
  vehicle.writeBytesField(8, descriptor.finish());
  entity.writeBytesField(4, vehicle.finish());
  writer.writeBytesField(2, entity.finish());
  return writer.finish();
}

function protobufResponse(bytes) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: null,
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
  };
}

test('a keyed feed without its key is answered without asking the operator, and the catalog says so', async (t) => {
  let upstreamCalls = 0;
  const service = createTransitService({
    fetchImpl: async () => {
      upstreamCalls += 1;
      throw new Error('must not be asked');
    },
    env: {},
  });
  t.after(service.close);
  const catalog = (
    await (await service.handle(request('/api/transit/feeds'))).json()
  ).feeds;
  const sf511 = catalog.find((feed) => feed.id === 'sf511-bay-area');
  assert.equal(sf511.keyRequired, true);
  assert.equal(sf511.envVar, 'BAY_AREA_511_API_KEY');
  assert.equal(catalog.find((feed) => feed.id === 'octa').keyRequired, false);
  for (const id of ['sf511-bay-area', 'lametro-bus', 'metrolink']) {
    const response = await service.handle(
      request(`/api/transit/vehicles/${id}`),
    );
    assert.equal(response.status, 503, `${id} answers 503`);
    assert.equal(response.headers.get('X-Transit-Backoff'), 'key-required');
    assert.equal(response.headers.get('Retry-After'), null, 'not a cooldown');
    const body = await response.json();
    assert.equal(body.keyRequired, true);
    assert.equal(body.feedId, id);
    assert.ok(body.envVar);
  }
  assert.equal(upstreamCalls, 0);
});

test('with its key configured a feed is fetched with the key where the operator wants it', async (t) => {
  const calls = [];
  const service = createTransitService({
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return protobufResponse(
        url.includes('511.org')
          ? oneVehicleFeed('SF:1234', 37.75, -122.42)
          : oneVehicleFeed('6502', 34.09, -118.33),
      );
    },
    env: { BAY_AREA_511_API_KEY: 'bay-token', SWIFTLY_API_KEY: 'swift-key' },
  });
  t.after(service.close);
  const catalog = (
    await (await service.handle(request('/api/transit/feeds'))).json()
  ).feeds;
  assert.equal(
    catalog.find((feed) => feed.id === 'sf511-bay-area').keyRequired,
    false,
  );
  assert.equal(
    catalog.find((feed) => feed.id === 'metrolink').keyRequired,
    true,
  );
  assert.equal(JSON.stringify(catalog).includes('bay-token'), false);

  const bay = await service.handle(
    request('/api/transit/vehicles/sf511-bay-area'),
  );
  assert.equal(bay.status, 200);
  const bayBody = await bay.text();
  assert.equal(JSON.parse(bayBody).vehicles[0].id, 'SF:1234');
  assert.equal(bayBody.includes('bay-token'), false, 'no key in the body');
  assert.equal(
    calls[0].url,
    'https://api.511.org/transit/vehiclepositions?agency=RG&api_key=bay-token',
  );
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.match(calls[0].headers.Accept, /x-google-protobuf/);
  assert.equal(bay.headers.get('Cache-Control'), 'public, max-age=80');

  const la = await service.handle(request('/api/transit/vehicles/lametro-bus'));
  assert.equal(la.status, 200);
  assert.equal(
    calls[1].url,
    'https://api.goswift.ly/real-time/lametro/gtfs-rt-vehicle-positions',
  );
  assert.equal(calls[1].headers.Authorization, 'swift-key');
  assert.equal(la.headers.get('Cache-Control'), 'public, max-age=30');
});

test('a feed polled on an operator allowance is served from cache for its whole window', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  let upstreamCalls = 0;
  const service = createTransitService({
    fetchImpl: async () => {
      upstreamCalls += 1;
      return protobufResponse(
        oneVehicleFeed('SF:1', 37.75, -122.42, Math.floor(Date.now() / 1000)),
      );
    },
    env: { BAY_AREA_511_API_KEY: 'bay-token' },
  });
  t.after(service.close);
  const poll = () =>
    service.handle(request('/api/transit/vehicles/sf511-bay-area'));
  assert.equal((await poll()).headers.get('X-GEV-Cache'), 'MISS');
  // Five more polls on the browser's 15 s grid all hit the cache.
  for (let i = 1; i <= 5; i += 1) {
    t.mock.timers.setTime(Date.now() + 15_000);
    assert.equal((await poll()).headers.get('X-GEV-Cache'), 'HIT', `poll ${i}`);
  }
  assert.equal(upstreamCalls, 1);
  // The sixth, ninety seconds on, is past the eighty-second window.
  t.mock.timers.setTime(Date.now() + 15_000);
  assert.equal((await poll()).headers.get('X-GEV-Cache'), 'MISS');
  assert.equal(upstreamCalls, 2);
});

test('the service reads a key saved after it started', async (t) => {
  const env = {};
  let upstreamCalls = 0;
  const service = createTransitService({
    fetchImpl: async () => {
      upstreamCalls += 1;
      return protobufResponse(oneVehicleFeed('T-1', 34.0, -118.1));
    },
    env,
  });
  t.after(service.close);
  assert.equal(
    (await service.handle(request('/api/transit/vehicles/metrolink'))).status,
    503,
  );
  env.METROLINK_API_KEY = 'later';
  assert.equal(
    (await service.handle(request('/api/transit/vehicles/metrolink'))).status,
    200,
  );
  assert.equal(upstreamCalls, 1);
});
