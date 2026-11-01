import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { liveOpsRegion } from '../../src/data/liveOpsRegions.js';
import {
  STREAM_STALE_MAX_MS,
  createStreamStore,
  streamSources,
  streamsProxy,
} from './streams.js';
import {
  REGISTRY_DIRECTORY,
  loadRegistryStreams,
  parseRegistryFile,
} from './streams/registry.js';
import { SCANNER_SOURCE, scannerStreams } from './streams/scanners.js';
import {
  YOUTUBE_CACHE_MAX_AGE_MS,
  YOUTUBE_REGION_CACHE_MS,
  createYoutubeDiscovery,
  parseYoutubeSearch,
  youtubeDailyBudget,
  youtubeSearchUrl,
} from './streams/youtube.js';
import {
  WINDY_IMAGE_FRESH_MS,
  WINDY_REGION_CACHE_MS,
  createWindyDiscovery,
  parseWindyWebcams,
  windyWebcamsUrl,
} from './streams/windy.js';
import { regionRadiusKm } from './streams/common.js';

const vegas = liveOpsRegion('las-vegas');
const sonoma = liveOpsRegion('sonoma-county');

const REGISTRY_FILE = {
  region: 'las-vegas',
  entries: [
    {
      id: 'lv-test',
      title: 'Test cam',
      lat: 36.11,
      lon: -115.17,
      kind: 'youtube',
      videoId: 'KJuGU7v5oYw',
      owner: 'EarthCam',
      terms: 'Public stream',
      placement: 'exact',
      verified_at: '2026-10-31',
      tags: ['strip'],
    },
    {
      id: 'lv-hls',
      title: 'Traffic cam',
      lat: 36.1,
      lon: -115.1,
      kind: 'hls',
      url: 'https://wzmedia.dot.ca.gov/D4/x.stream/playlist.m3u8',
      poster: 'https://cwwp2.dot.ca.gov/data/d4/cctv/image/x/x.jpg',
      owner: 'Caltrans',
      verified_at: '2026-10-31',
    },
    {
      id: 'lv-broken',
      title: 'No id',
      lat: 36,
      lon: -115,
      kind: 'youtube',
      videoId: 'nope',
    },
    {
      id: 'lv-test',
      title: 'Duplicate',
      lat: 36,
      lon: -115,
      kind: 'youtube',
      videoId: 'KJuGU7v5oYw',
    },
  ],
};

const YOUTUBE_PAYLOAD = {
  items: [
    {
      id: { kind: 'youtube#video', videoId: 'n37j-Zl1Lc4' },
      snippet: {
        title: 'Strip stream',
        channelTitle: 'LV Strip Cam',
        liveBroadcastContent: 'live',
        thumbnails: {
          high: {
            url: 'https://i.ytimg.com/vi/n37j-Zl1Lc4/hqdefault_live.jpg',
          },
        },
      },
    },
    {
      id: { kind: 'youtube#video', videoId: 'KJuGU7v5oYw' },
      snippet: {
        title: 'Also curated',
        channelTitle: 'EarthCam',
        liveBroadcastContent: 'live',
      },
    },
    {
      id: { kind: 'youtube#video', videoId: 'upcoming0000' },
      snippet: { title: 'Later', liveBroadcastContent: 'upcoming' },
    },
    {
      id: { kind: 'youtube#channel', channelId: 'UC123' },
      snippet: { title: 'A channel' },
    },
  ],
};

const WINDY_PAYLOAD = {
  total: 2,
  webcams: [
    {
      webcamId: 1234567890,
      title: 'Strip view',
      status: 'active',
      lastUpdatedOn: '2026-10-31T12:00:00.000Z',
      location: {
        city: 'Las Vegas',
        region: 'Nevada',
        latitude: 36.12,
        longitude: -115.17,
      },
      images: {
        current: {
          preview:
            'https://images-webcams.windy.com/90/1234567890/current/preview/1234567890.jpg?tok=abc',
        },
      },
      player: {
        live: 'https://webcams.windy.com/webcams/public/embed/player/1234567890/live',
      },
      urls: { detail: 'https://windy.com/webcams/1234567890' },
      categories: [{ id: 'city', name: 'City' }],
    },
    {
      webcamId: 42,
      title: 'Too far',
      status: 'active',
      location: { latitude: 39.5, longitude: -119.8 },
      player: {
        live: 'https://webcams.windy.com/webcams/public/embed/player/42/live',
      },
    },
  ],
};

test('registry files normalize their entries and skip what cannot play', () => {
  const warnings = [];
  const rows = parseRegistryFile(REGISTRY_FILE, {
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ['registry:lv-test', 'registry:lv-hls'],
  );
  assert.equal(rows[0].region, 'las-vegas');
  assert.equal(rows[0].sourceLabel, 'Curated live cameras');
  assert.equal(rows[0].verifiedAt, '2026-10-31');
  assert.deepEqual(rows[0].tags, ['strip']);
  assert.equal(rows[1].kind, 'hls');
  assert.equal(
    rows[1].poster,
    'https://cwwp2.dot.ca.gov/data/d4/cctv/image/x/x.jpg',
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /lv-broken/);
  assert.match(warnings[1], /duplicate entry registry:lv-test/);
  assert.deepEqual(parseRegistryFile({ region: 'mars', entries: [] }, {}), []);
});

test('the shipped registry has verified entries for every region', async () => {
  const warnings = [];
  const rows = await loadRegistryStreams({
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(warnings, []);
  const byRegion = new Map();
  for (const row of rows)
    byRegion.set(row.region, (byRegion.get(row.region) || 0) + 1);
  for (const region of [
    'los-angeles',
    'sonoma-county',
    'sf-bay-area',
    'las-vegas',
  ]) {
    assert.ok(
      (byRegion.get(region) || 0) >= 6,
      `${region} has ${byRegion.get(region) || 0} entries`,
    );
  }
  for (const row of rows) {
    assert.equal(row.source, 'registry');
    assert.match(row.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(row.owner, `${row.id} names its owner`);
    assert.ok(row.terms, `${row.id} carries a terms note`);
    const region = liveOpsRegion(row.region);
    const [west, south, east, north] = region.bbox;
    assert.ok(
      row.lat >= south &&
        row.lat <= north &&
        row.lon >= west &&
        row.lon <= east,
      `${row.id} inside ${region.id}`,
    );
  }
  assert.ok(
    new Set(rows.map((row) => row.embed.videoId || row.embed.url)).size ===
      rows.length,
    'no duplicate media',
  );
  assert.match(REGISTRY_DIRECTORY, /registry$/);
});

test('scanner directories are link-outs placed in their regions', () => {
  const rows = scannerStreams();
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.equal(row.source, SCANNER_SOURCE.id);
    assert.equal(row.kind, 'link');
    assert.match(
      row.embed.url,
      /^https:\/\/www\.broadcastify\.com\/listen\/ctid\/\d+$/,
    );
    assert.ok(liveOpsRegion(row.region));
    assert.match(row.terms, /forbid relaying/);
  }
  assert.deepEqual(
    rows.filter((row) => row.region === 'sf-bay-area').length,
    5,
  );
});

test('YouTube searches ask for live, embeddable videos around a region within its radius', () => {
  const url = new URL(youtubeSearchUrl({ key: 'k', region: vegas }));
  assert.equal(
    url.origin + url.pathname,
    'https://www.googleapis.com/youtube/v3/search',
  );
  assert.equal(url.searchParams.get('eventType'), 'live');
  assert.equal(url.searchParams.get('type'), 'video');
  assert.equal(url.searchParams.get('videoEmbeddable'), 'true');
  assert.equal(url.searchParams.get('location'), '36.1699,-115.1398');
  assert.equal(
    url.searchParams.get('locationRadius'),
    `${regionRadiusKm(vegas)}km`,
  );
  assert.ok(regionRadiusKm(vegas) >= 30 && regionRadiusKm(vegas) <= 60);
  assert.equal(regionRadiusKm(sonoma, { max: 20 }), 20);
  assert.equal(url.searchParams.get('key'), 'k');
  assert.equal(youtubeDailyBudget({}), 90);
  assert.equal(youtubeDailyBudget({ YOUTUBE_SEARCH_DAILY_BUDGET: '40' }), 40);
  assert.equal(youtubeDailyBudget({ YOUTUBE_SEARCH_DAILY_BUDGET: '500' }), 100);
  assert.equal(youtubeDailyBudget({ YOUTUBE_SEARCH_DAILY_BUDGET: 'lots' }), 90);
});

test('YouTube answers become region-centre rows; upcoming and non-video items are dropped', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const rows = parseYoutubeSearch(YOUTUBE_PAYLOAD, { region: vegas, now });
  assert.deepEqual(
    rows.map((row) => row.id),
    ['youtube:n37j-Zl1Lc4', 'youtube:KJuGU7v5oYw'],
  );
  assert.equal(rows[0].lat, vegas.center.lat);
  assert.equal(rows[0].lon, vegas.center.lon);
  assert.equal(rows[0].placement, 'region-centre');
  assert.match(rows[0].description, /region centre/);
  assert.equal(
    rows[0].poster,
    'https://i.ytimg.com/vi/n37j-Zl1Lc4/hqdefault_live.jpg',
  );
  assert.equal(rows[0].owner, 'LV Strip Cam');
  assert.equal(rows[0].verifiedAt, '2026-10-31');
  assert.throws(
    () => parseYoutubeSearch({ error: {} }, { region: vegas, now }),
    /no items/,
  );
});

test('YouTube discovery caches each region hourly, spends a daily budget, and persists', async () => {
  let clock = Date.parse('2026-10-31T23:30:00Z');
  const calls = [];
  const disk = new Map();
  const warnings = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url).searchParams.get('location'));
    return new Response(JSON.stringify(YOUTUBE_PAYLOAD), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const options = {
    cachePath: 'memory.json',
    now: () => clock,
    warn: (...args) => warnings.push(args.join(' ')),
    budgetLimit: 5,
    readFile: async (file) => {
      if (!disk.has(file))
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return disk.get(file);
    },
    writeFile: async (file, text) => {
      disk.set(file, text);
    },
  };
  const env = { YOUTUBE_API_KEY: 'k' };
  const discovery = createYoutubeDiscovery(options);
  await assert.rejects(
    discovery.load({ fetchImpl, env: {}, now: clock }),
    (error) => error.code === 'no_key',
  );
  const first = await discovery.load({ fetchImpl, env, now: clock });
  assert.equal(calls.length, 4, 'one search per region');
  assert.equal(first.length, 8);
  assert.equal(discovery.status(env).budget.used, 4);
  assert.equal(discovery.status(env).budget.day, '2026-10-31');
  // Within the hour nothing is searched again.
  clock += 10 * 60_000;
  await discovery.load({ fetchImpl, env, now: clock });
  assert.equal(calls.length, 4);
  // The next day resets the budget, but only one call fits the remaining hour.
  clock += YOUTUBE_REGION_CACHE_MS;
  await discovery.load({ fetchImpl, env, now: clock });
  assert.equal(discovery.status(env).budget.day, '2026-11-01');
  assert.equal(calls.length, 8);
  // A restart restores the cache and the budget from disk.
  const restarted = createYoutubeDiscovery(options);
  const restored = await restarted.load({ fetchImpl, env, now: clock });
  assert.equal(calls.length, 8, 'nothing searched again after a restart');
  assert.equal(restored.length, 8);
  assert.equal(restarted.status(env).budget.used, 4);
  // Once the budget is spent, regions keep serving their cached result.
  clock += YOUTUBE_REGION_CACHE_MS;
  const spent = await restarted.load({ fetchImpl, env, now: clock });
  assert.equal(calls.length, 9, 'one call left in the budget of five');
  assert.equal(spent.length, 8);
  assert.equal(restarted.status(env).budget.used, 5);
  // Cached data older than 30 days is deleted, not served.
  clock += YOUTUBE_CACHE_MAX_AGE_MS + 1;
  const expired = createYoutubeDiscovery({ ...options, budgetLimit: 0 });
  assert.deepEqual(await expired.load({ fetchImpl, env, now: clock }), []);
  assert.deepEqual(warnings, []);
});

test('YouTube failures keep the last answer and never surface upstream text', async () => {
  let clock = Date.parse('2026-10-31T12:00:00Z');
  let fail = false;
  const warnings = [];
  const fetchImpl = async () =>
    fail
      ? new Response('{"error":{"message":"secret quota detail"}}', {
          status: 403,
        })
      : new Response(JSON.stringify(YOUTUBE_PAYLOAD), { status: 200 });
  const discovery = createYoutubeDiscovery({
    cachePath: null,
    now: () => clock,
    warn: (...args) => warnings.push(args.join(' ')),
    budgetLimit: 50,
  });
  const env = { YOUTUBE_API_KEY: 'k' };
  assert.equal(
    (await discovery.load({ fetchImpl, env, now: clock })).length,
    8,
  );
  fail = true;
  clock += YOUTUBE_REGION_CACHE_MS;
  assert.equal(
    (await discovery.load({ fetchImpl, env, now: clock })).length,
    8,
  );
  assert.equal(warnings.length, 4);
  for (const warning of warnings) {
    assert.match(warning, /HTTP 403/);
    assert.doesNotMatch(warning, /secret/);
  }
});

test('Windy webcams inside a region link to the player and keep their preview only while fresh', () => {
  const url = new URL(windyWebcamsUrl({ region: vegas }));
  assert.equal(
    url.origin + url.pathname,
    'https://api.windy.com/webcams/api/v3/webcams',
  );
  assert.match(url.searchParams.get('nearby'), /^36\.1699,-115\.1398,\d+$/);
  assert.equal(
    url.searchParams.get('include'),
    'location,images,player,urls,categories',
  );
  const now = Date.parse('2026-10-31T12:00:00Z');
  const rows = parseWindyWebcams(WINDY_PAYLOAD, { region: vegas, now });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'windy:1234567890');
  assert.equal(rows[0].kind, 'link');
  assert.equal(
    rows[0].embed.url,
    'https://webcams.windy.com/webcams/public/embed/player/1234567890/live',
  );
  assert.equal(rows[0].pageUrl, 'https://windy.com/webcams/1234567890');
  assert.match(rows[0].poster, /^https:\/\/images-webcams\.windy\.com\//);
  assert.equal(rows[0].owner, 'windy.com');
  assert.equal(rows[0].description, 'Las Vegas, Nevada');
  assert.deepEqual(rows[0].tags, ['City']);
  assert.equal(rows[0].time, Date.parse('2026-10-31T12:00:00.000Z'));
  assert.throws(
    () => parseWindyWebcams({}, { region: vegas, now }),
    /no webcams/,
  );
});

test('Windy discovery refreshes hourly and strips expired image URLs', async () => {
  let clock = Date.parse('2026-10-31T12:00:00Z');
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(init.headers['x-windy-api-key'], 'w');
    return new Response(JSON.stringify(WINDY_PAYLOAD), { status: 200 });
  };
  const discovery = createWindyDiscovery({ now: () => clock, warn: () => {} });
  const env = { WINDY_WEBCAMS_API_KEY: 'w' };
  await assert.rejects(
    discovery.load({ fetchImpl, env: {}, now: clock }),
    (error) => error.code === 'no_key',
  );
  const fresh = await discovery.load({ fetchImpl, env, now: clock });
  assert.equal(calls, 4);
  assert.equal(fresh.length, 1, 'the fixture webcam lies in one region only');
  assert.ok(fresh[0].poster);
  clock += WINDY_IMAGE_FRESH_MS + 1;
  const aged = await discovery.load({ fetchImpl, env, now: clock });
  assert.equal(calls, 4, 'metadata is still cached');
  assert.equal(
    aged[0].poster,
    null,
    'an image URL past its life is never served',
  );
  assert.equal(discovery.present(fresh, clock)[0].poster, null);
  clock += WINDY_REGION_CACHE_MS;
  const refreshed = await discovery.load({ fetchImpl, env, now: clock });
  assert.equal(calls, 8);
  assert.ok(refreshed[0].poster);
});

function fakeSources(loaders, extra = {}) {
  return Object.entries(loaders).map(([id, load]) => ({
    id,
    label: id,
    refreshMs: 60_000,
    enabled: () => true,
    load,
    ...(extra[id] || {}),
  }));
}

const row = (source, id, region, extra = {}) => ({
  id: `${source}:${id}`,
  source,
  sourceLabel: source,
  title: id,
  lat: 36,
  lon: -115,
  region,
  kind: 'youtube',
  embed: { type: 'youtube', videoId: 'KJuGU7v5oYw' },
  pageUrl: null,
  poster: null,
  owner: null,
  terms: null,
  placement: 'exact',
  verifiedAt: null,
  time: null,
  description: null,
  tags: [],
  ...extra,
});

test('the store merges sources, treats a missing key as keyless, and keeps curated positions', async () => {
  let clock = 10_000_000;
  let loads = 0;
  let registryFails = false;
  const store = createStreamStore({
    now: () => clock,
    warn: () => {},
    sources: fakeSources(
      {
        registry: async () => {
          loads += 1;
          if (registryFails) throw new Error('EACCES');
          return [row('registry', 'a', 'las-vegas')];
        },
        youtube: async () => {
          throw Object.assign(new Error('no_key'), { code: 'no_key' });
        },
        windy: async () => [
          row('windy', 'w', 'sonoma-county', {
            kind: 'link',
            embed: { type: 'link', url: 'https://windy.com/webcams/1' },
            poster: 'https://images-webcams.windy.com/x.jpg',
          }),
        ],
        scanner: async () => [
          row('scanner', 's', 'las-vegas', {
            kind: 'link',
            embed: {
              type: 'link',
              url: 'https://www.broadcastify.com/listen/ctid/1745',
            },
          }),
        ],
      },
      {
        windy: {
          present: (rows) => rows.map((entry) => ({ ...entry, poster: null })),
        },
      },
    ),
  });
  const first = await store.snapshot();
  assert.deepEqual(
    first.rows.map((entry) => entry.id),
    ['registry:a', 'windy:w', 'scanner:s'],
  );
  assert.equal(first.rows[1].poster, null, 'present() ran before answering');
  assert.equal(first.stale, false);
  const youtube = first.sources.find((entry) => entry.id === 'youtube');
  assert.equal(youtube.ok, false);
  assert.equal(youtube.keyRequired, true);
  assert.equal(youtube.error, 'no_key');
  assert.equal(youtube.stale, false);
  const vegasOnly = await store.snapshot({ region: 'las-vegas', kind: 'link' });
  assert.deepEqual(
    vegasOnly.rows.map((entry) => entry.id),
    ['scanner:s'],
  );
  assert.equal(vegasOnly.region, 'las-vegas');
  const onlyWindy = await store.snapshot({ source: 'windy' });
  assert.deepEqual(
    onlyWindy.rows.map((entry) => entry.id),
    ['windy:w'],
  );
  assert.equal(loads, 1, 'nothing is reloaded within the refresh interval');
  clock += 61_000;
  registryFails = true;
  const stale = await store.snapshot({ region: 'las-vegas' });
  assert.equal(loads, 2);
  const registry = stale.sources.find((entry) => entry.id === 'registry');
  assert.equal(registry.ok, false);
  assert.equal(registry.stale, true);
  assert.deepEqual(
    stale.rows.map((entry) => entry.id),
    ['registry:a', 'scanner:s'],
  );
  clock += STREAM_STALE_MAX_MS + 1;
  const dropped = await store.snapshot({ region: 'las-vegas' });
  assert.deepEqual(
    dropped.rows.map((entry) => entry.id),
    ['scanner:s'],
  );
});

test('a discovered video already in the registry keeps its curated position', async () => {
  const store = createStreamStore({
    now: () => 1,
    warn: () => {},
    sources: fakeSources({
      registry: async () => [row('registry', 'curated', 'las-vegas')],
      youtube: async () => [
        row('youtube', 'KJuGU7v5oYw', 'las-vegas', {
          placement: 'region-centre',
        }),
        row('youtube', 'other', 'las-vegas', {
          embed: { type: 'youtube', videoId: 'n37j-Zl1Lc4' },
        }),
      ],
    }),
  });
  const snapshot = await store.snapshot();
  assert.deepEqual(
    snapshot.rows.map((entry) => entry.id),
    ['registry:curated', 'youtube:other'],
  );
});

test('the real source list reads keys from the environment', async () => {
  const sources = streamSources({ env: {} });
  assert.deepEqual(
    sources.map((source) => source.id),
    ['registry', 'youtube', 'windy', 'scanner'],
  );
  assert.equal(sources[1].keyEnv, 'YOUTUBE_API_KEY');
  assert.equal(sources[2].keyEnv, 'WINDY_WEBCAMS_API_KEY');
  const disabled = streamSources({ env: { STREAMS_SCANNERS_ENABLED: '0' } });
  assert.equal(disabled[3].enabled(), false);
  assert.equal(disabled[0].enabled(), true);
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

test('the /api/streams route validates its query, serves the snapshot and a key status', async () => {
  const plugin = streamsProxy({
    now: () => 10_000_000,
    warn: () => {},
    env: { YOUTUBE_API_KEY: 'k' },
    sources: fakeSources(
      {
        registry: async () => [row('registry', '1', 'los-angeles')],
        youtube: async () => {
          throw new Error('ECONNRESET');
        },
      },
      {
        youtube: {
          keyEnv: 'YOUTUBE_API_KEY',
          status: () => ({ budget: { used: 1, limit: 90 } }),
        },
      },
    ),
  });
  let handler;
  plugin.configureServer({
    middlewares: {
      use: (path, fn) => {
        assert.equal(path, '/api/streams');
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
  call = request('/?kind=rtsp');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 400);
  call = request('/?source=pigeon');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 400);
  call = request('/', 'POST');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 405);
  call = request('/nope');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 404);
  call = request('/?region=los-angeles&kind=youtube');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 200);
  const payload = JSON.parse(call.out.body);
  assert.equal(payload.region, 'los-angeles');
  assert.equal(payload.rows.length, 1);
  assert.equal(call.out.headers['Cache-Control'], 'no-store');
  const youtube = payload.sources.find((entry) => entry.id === 'youtube');
  assert.equal(youtube.ok, false);
  assert.equal(
    youtube.error,
    'ECONNRESET',
    'a local failure code, never an upstream body',
  );
  call = request('/status');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 200);
  const status = JSON.parse(call.out.body);
  assert.equal(status.youtube.hasKey, true);
  assert.equal(status.youtube.budget.limit, 90);
  assert.doesNotMatch(call.out.body, /"k"/);
});
