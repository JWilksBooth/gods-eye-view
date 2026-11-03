import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../cctv.js';
import {
  STREAM_PROBE_LIMITS,
  createStreamHealth,
  createStreamProbe,
  hlsPlaylistUrl,
  sampleStreamSources,
} from './streamHealth.js';
import {
  CCTV_STREAM_FAILURE_WINDOW_MS,
  CCTV_STREAM_OK_WINDOW_MS,
} from '../../../src/sources/cctvStreamHealth.js';

const PLAYLIST =
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nchunklist.m3u8\n';
const hls = (id, pack = 'caltrans', host = 'wzmedia.dot.ca.gov') => ({
  id,
  pack,
  provider: pack,
  feedType: 'hls',
  url: `https://${host}/D7/${id}.stream/playlist.m3u8`,
  snapshotUrl: `https://cwwp2.dot.ca.gov/data/d7/cctv/image/${id}/${id}.jpg`,
});

function clock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, tick: (ms) => (now += ms) };
}

test('the record keeps both timestamps and the failure count; a success forgets the failures', () => {
  const time = clock();
  const health = createStreamHealth({ now: time.now });
  assert.equal(health.state('a'), 'unknown');
  health.recordFailure('a');
  assert.deepEqual(health.get('a'), { ok: 0, fail: time.now(), failures: 1 });
  assert.equal(health.state('a'), 'down');
  time.tick(1_000);
  health.recordFailure('a');
  assert.equal(health.get('a').failures, 2);
  time.tick(1_000);
  health.recordSuccess('a');
  assert.deepEqual(health.get('a'), {
    ok: time.now(),
    fail: time.now() - 1_000,
    failures: 0,
  });
  assert.equal(health.state('a'), 'ok');
  time.tick(CCTV_STREAM_OK_WINDOW_MS);
  assert.equal(health.state('a'), 'unknown');
  health.recordFailure('a');
  time.tick(CCTV_STREAM_FAILURE_WINDOW_MS);
  assert.equal(health.state('a'), 'unknown');
  assert.equal(health.recordSuccess(''), null);
  assert.equal(health.recordFailure(null), null);
  assert.equal(health.get('nope'), null);
});

test('the snapshot is compact, only cameras with a record, or only the ids asked for', () => {
  const time = clock();
  const health = createStreamHealth({ now: time.now });
  health.recordSuccess('a');
  time.tick(5);
  health.recordFailure('b');
  assert.deepEqual(health.snapshot(), {
    a: { ok: time.now() - 5, fail: 0 },
    b: { ok: 0, fail: time.now() },
  });
  assert.deepEqual(health.snapshot(['b', 'zzz', ' a ']), {
    b: { ok: 0, fail: time.now() },
    a: { ok: time.now() - 5, fail: 0 },
  });
  assert.equal(health.size, 2);
});

test('the record is bounded: the camera untouched for longest is evicted first', () => {
  const health = createStreamHealth({ maxEntries: 3 });
  health.recordSuccess('a');
  health.recordSuccess('b');
  health.recordSuccess('c');
  health.recordFailure('a'); // a is the most recently touched now
  health.recordSuccess('d'); // evicts b
  assert.deepEqual(Object.keys(health.snapshot()), ['c', 'a', 'd']);
  assert.equal(health.get('b'), null);
  assert.equal(health.size, 3);
});

test('only a live HLS camera with a registered playlist can be probed', () => {
  assert.equal(hlsPlaylistUrl(hls('x')), hls('x').url);
  assert.equal(
    hlsPlaylistUrl({ feedType: 'stream', url: 'http://h.example/a.m3u8?x=1' }),
    'http://h.example/a.m3u8?x=1',
  );
  for (const bad of [
    null,
    { feedType: 'image', url: 'https://h.example/a.m3u8' },
    { feedType: 'hls', url: 'https://h.example/live.mp4' },
    { feedType: 'hls', url: 'ftp://h.example/a.m3u8' },
    { feedType: 'hls', url: '' },
    { feedType: 'mp4', url: 'https://h.example/a.m3u8' },
  ])
    assert.equal(hlsPlaylistUrl(bad), null, JSON.stringify(bad));
});

test('the load-time sample takes a few of each provider, spread along its list', () => {
  const sources = [
    ...Array.from({ length: 40 }, (_, i) => hls(`ca-${i}`, 'caltrans')),
    ...Array.from({ length: 3 }, (_, i) => hls(`de-${i}`, 'deldot')),
    { id: 'still', pack: 'caltrans', feedType: 'image', url: 'https://x/a.jpg' },
    hls('no-pack', ''),
  ];
  const sample = sampleStreamSources(sources, 4);
  assert.deepEqual(
    sample.map((source) => source.id),
    ['ca-0', 'ca-10', 'ca-20', 'ca-30', 'de-0', 'de-1', 'de-2', 'no-pack'],
  );
  assert.equal(sampleStreamSources(sources, 0).length, 0);
  assert.equal(
    sampleStreamSources(sources).length,
    STREAM_PROBE_LIMITS.perProvider + 3 + 1,
  );
});

test('a probe records a playlist that answers as a success and anything else as a failure', async () => {
  const time = clock();
  const health = createStreamHealth({ now: time.now });
  const calls = [];
  const probe = createStreamProbe({
    health,
    now: time.now,
    limits: { ...STREAM_PROBE_LIMITS, timeoutMs: 50 },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/good.')) return new Response(PLAYLIST);
      if (url.includes('/bom.')) return new Response('﻿' + PLAYLIST);
      if (url.includes('/gone.')) return new Response('', { status: 404 });
      if (url.includes('/html.'))
        return new Response('<html>not a playlist</html>');
      if (url.includes('/away.'))
        return new Response('', {
          status: 302,
          headers: { location: 'https://elsewhere.example/playlist.m3u8' },
        });
      if (url.includes('/home.') && !url.includes('/moved/'))
        return new Response('', {
          status: 302,
          headers: { location: '/moved/home.stream/playlist.m3u8' },
        });
      if (url.includes('/moved/')) return new Response(PLAYLIST);
      if (url.includes('/throws.')) throw new Error('connection reset');
      if (url.includes('/slow.'))
        return new Promise((_, reject) =>
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        );
      return new Response('', { status: 500 });
    },
  });
  const sources = [
    hls('good'),
    hls('bom'),
    hls('gone'),
    hls('html'),
    hls('away'),
    hls('home'),
    hls('throws'),
    hls('slow'),
    { id: 'still', feedType: 'image', url: 'https://x/a.jpg' },
  ];
  const report = await probe.probe(sources);
  assert.deepEqual(report, {
    requested: 8,
    probed: 8,
    ok: 3,
    failed: 5,
    skipped: 0,
    ms: 0,
  });
  const states = Object.fromEntries(
    sources.map((source) => [source.id, health.state(source.id)]),
  );
  assert.deepEqual(states, {
    good: 'ok',
    bom: 'ok',
    gone: 'down',
    html: 'down',
    away: 'down',
    home: 'ok',
    throws: 'down',
    slow: 'down',
    still: 'unknown',
  });
  assert.ok(calls.length >= 9);
  for (const { init } of calls) {
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['User-Agent'], 'osiris-cctv-proxy/1.0');
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls.some(({ url }) => url.includes('elsewhere')), false);
});

test('a probe skips cameras with a fresh verdict, dedupes ids, bounds the batch and shares in-flight requests', async () => {
  const time = clock();
  const health = createStreamHealth({ now: time.now });
  let fetches = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const probe = createStreamProbe({
    health,
    now: time.now,
    fetchImpl: async () => {
      fetches += 1;
      await gate;
      return new Response(PLAYLIST);
    },
  });
  health.recordFailure('known');
  const first = probe.probe([hls('a'), hls('a'), hls('known'), hls('b')], {
    limit: 2,
  });
  const second = probe.probe([hls('a')]);
  assert.equal(probe.inFlight, 2);
  release();
  assert.deepEqual(await first, {
    requested: 3,
    probed: 2,
    ok: 2,
    failed: 0,
    skipped: 1,
    ms: 0,
  });
  assert.equal((await second).probed, 1);
  assert.equal(fetches, 2);
  assert.equal(probe.inFlight, 0);
  assert.deepEqual(await probe.probe([hls('a'), hls('known')]), {
    requested: 2,
    probed: 0,
    ok: 0,
    failed: 0,
    skipped: 2,
    ms: 0,
  });
});

test('probe requests share one concurrency budget', async () => {
  const health = createStreamHealth();
  let active = 0;
  let peak = 0;
  const probe = createStreamProbe({
    health,
    limits: { ...STREAM_PROBE_LIMITS, concurrency: 2 },
    fetchImpl: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(PLAYLIST);
    },
  });
  await Promise.all([
    probe.probe([hls('a'), hls('b'), hls('c')]),
    probe.probe([hls('d'), hls('e')]),
  ]);
  assert.equal(peak, 2);
  assert.equal(health.size, 5);
});

test('seeding probes the per-provider sample only', async () => {
  const health = createStreamHealth();
  const urls = [];
  const probe = createStreamProbe({
    health,
    limits: { ...STREAM_PROBE_LIMITS, perProvider: 2 },
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(PLAYLIST);
    },
  });
  const report = await probe.seed([
    ...Array.from({ length: 10 }, (_, i) => hls(`ca-${i}`, 'caltrans')),
    hls('nv-1', 'nvfast'),
  ]);
  assert.equal(report.probed, 3);
  assert.deepEqual(
    urls.map((url) => url.split('/')[4]),
    ['ca-0.stream', 'ca-5.stream', 'nv-1.stream'],
  );
});

// --- The proxy routes -------------------------------------------------------

function install(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  return async (url) => {
    const res = {
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url, method: 'GET', headers: {} }, res);
    return res;
  };
}

function withEnv(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

function emptyRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'osiris-stream-health-'));
  mkdirSync(path.join(root, 'config'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const CATALOG = JSON.stringify([
  { ...hls('up'), name: 'Up', lat: 34.05, lon: -118.24 },
  { ...hls('dead'), name: 'Dead', lat: 34.06, lon: -118.25 },
  {
    id: 'still',
    name: 'Still',
    lat: 34.07,
    lon: -118.26,
    feedType: 'image',
    url: 'https://cwwp2.dot.ca.gov/data/d7/cctv/image/still/still.jpg',
  },
]);

test('the proxy probes the cameras a request names, publishes the verdicts on /health and never re-probes a fresh one', async (t) => {
  withEnv(t, {
    CCTV_SOURCES_JSON: CATALOG,
    CCTV_SOURCES_FILE: undefined,
    CCTV_FORCE_AUSTIN: undefined,
    CCTV_STREAM_PROBE: undefined,
  });
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetched.push(String(url));
    if (String(url).includes('/up.')) return new Response(PLAYLIST);
    return new Response('', { status: 404 });
  });
  const request = install(cctvProxy({ sourceRoot: emptyRoot(t) }));
  const probed = await request(
    '/stream-probe?id=up&id=dead&id=still&id=unknown-camera',
  );
  assert.equal(probed.status, 200);
  assert.equal(probed.headers['Cache-Control'], 'no-store');
  const body = JSON.parse(probed.body);
  assert.equal(body.probed, 2);
  assert.deepEqual(Object.keys(body.streams).sort(), ['dead', 'up']);
  assert.ok(body.streams.up.ok > 0);
  assert.equal(body.streams.up.fail, 0);
  assert.ok(body.streams.dead.fail > 0);
  assert.equal(body.streams.dead.ok, 0);
  // Only playlists were fetched, each once, whoever asked (the load-time
  // sample and the request shared them).
  assert.deepEqual(fetched.sort(), [hls('dead').url, hls('up').url]);
  const health = JSON.parse((await request('/health')).body);
  assert.deepEqual(health.streams, body.streams);
  assert.ok(Array.isArray(health.cameras));
  const again = JSON.parse((await request('/stream-probe?id=up&id=dead')).body);
  assert.equal(again.probed, 0);
  assert.deepEqual(again.streams, body.streams);
  assert.equal(fetched.length, 2);
});

test('CCTV_STREAM_PROBE=0 leaves every playlist alone; leases alone teach the record', async (t) => {
  withEnv(t, {
    CCTV_SOURCES_JSON: CATALOG,
    CCTV_SOURCES_FILE: undefined,
    CCTV_FORCE_AUSTIN: undefined,
    CCTV_STREAM_PROBE: '0',
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('must not fetch');
  });
  const request = install(cctvProxy({ sourceRoot: emptyRoot(t) }));
  const probed = JSON.parse((await request('/stream-probe?id=up&id=dead')).body);
  assert.deepEqual(probed, { probed: 0, streams: {} });
  assert.deepEqual(JSON.parse((await request('/health')).body).streams, {});
});
