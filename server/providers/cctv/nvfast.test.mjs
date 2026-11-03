import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NVFAST_CATALOG_URL,
  NVFAST_PROBE_CONCURRENCY,
  NVFAST_PROBE_MAX_PLAYLISTS,
  loadNvfastSources,
  nvfastRowToSource,
  nvfastStreamUrl,
  parseNvfastCatalogPage,
  probeNvfastVideo,
  resolveNvfastVideo,
  sampleNvfastPlaylists,
} from './nvfast.js';

/* Rows as the dashboard page embeds them (2026-11-02), with the leading
   space and the & escape the page really carries. */
const PAGE = `<html><script>var obj = eval({"TempTable":[[100," I-15 SB I-515 Interchange (dual)",36.1738413699812,-115.156049643255,"snapshot","https://d1wse1.its.nv.gov:443/vegasxcd04/i15_sb_i515_interchange_dual2_public.stream/playlist.m3u8"],[102,"I-15 NB Symphony",36.17085057,-115.1573358,"snapshot",null],[107,"107 I-15 NB Charleston On",36.16050888,-115.1599386,"snapshot",null],[50742," Green Valley \\u0026 I-215 WB Beltway",36.024799,-115.085297,"snapshot",null],[84002,"Las Vegas Blvd at Welcome Sign [stationary]",36.0811,-115.172699,"snapshot",null]]})</script><p>unrelated [1, 2]</p></html>`;

/** An NDOT playlist on host d1wse<n> for stream `name`, as the table names them. */
const playlist = (n, name) =>
  `https://d1wse${n}.its.nv.gov:443/vegasxcd0${n}/${name}_public.stream/playlist.m3u8`;
/** The same playlist as the pack registers it (the default port dropped). */
const registered = (n, name) => nvfastStreamUrl(playlist(n, name));
const NDOT_HOST = /^https:\/\/d1wse\d\.its\.nv\.gov\//;
/* Twelve valley rows: ten name a playlist (seven on d1wse1, two on d1wse2,
   one on d1wse3) and two are stills. */
const PROBE_ROWS = [
  ...Array.from({ length: 7 }, (_, i) => [
    201 + i,
    `I-15 NB ${i}`,
    36.1 + i * 0.01,
    -115.15,
    'snapshot',
    playlist(1, `a${i}`),
  ]),
  [301, 'US-95 SB Rancho', 36.19, -115.17, 'snapshot', playlist(2, 'b0')],
  [302, 'US-95 NB Jones', 36.2, -115.22, 'snapshot', playlist(2, 'b1')],
  [401, 'I-215 WB Eastern', 36.03, -115.11, 'snapshot', playlist(3, 'c0')],
  [501, 'Flamingo & Paradise', 36.115, -115.153, 'snapshot', null],
  [502, 'Tropicana & Koval', 36.1, -115.16, 'snapshot', ''],
];
const PROBE_PAGE = `<html><script>var obj = eval({"TempTable":${JSON.stringify(PROBE_ROWS)}})</script></html>`;
const M3U8 =
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nchunklist_w1.m3u8\n';

const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });
const m3u8 = () =>
  new Response(M3U8, {
    status: 200,
    headers: { 'content-type': 'application/vnd.apple.mpegurl' },
  });

function captureConsole(t) {
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'log', capture);
  t.mock.method(console, 'warn', capture);
  return lines;
}

/** Mock fetch for the test; `handler(url, init)` answers each request. */
function mockFetch(t, handler) {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return requested;
}

const probedUrls = (requested) =>
  requested.map((r) => r.url).filter((url) => url !== NVFAST_CATALOG_URL);

test('the camera table is cut out of the dashboard page and parsed as JSON', () => {
  const rows = parseNvfastCatalogPage(PAGE);
  assert.equal(rows.length, 5);
  assert.equal(rows[3][1], ' Green Valley & I-215 WB Beltway');
  assert.equal(rows[4][1], 'Las Vegas Blvd at Welcome Sign [stationary]');
  assert.throws(() => parseNvfastCatalogPage('<html>no table</html>'));
  assert.throws(() => parseNvfastCatalogPage('"TempTable":[[1,"x"'));
});

test('a row with an NDOT playlist becomes a live camera with the still as its snapshot', () => {
  const camera = nvfastRowToSource(parseNvfastCatalogPage(PAGE)[0]);
  assert.equal(camera.id, 'nvfast-100');
  assert.equal(camera.name, 'I-15 SB I-515 Interchange (dual)');
  assert.equal(camera.city, 'Las Vegas');
  assert.equal(camera.provider, 'RTC of Southern Nevada FAST');
  assert.equal(camera.feedType, 'hls');
  assert.equal(
    camera.url,
    'https://d1wse1.its.nv.gov/vegasxcd04/i15_sb_i515_interchange_dual2_public.stream/playlist.m3u8',
  );
  assert.equal(camera.snapshotUrl, 'https://bugatti.nvfast.org/Snapshots/100.jpeg');
  assert.equal(camera.headingDeg, 180);
  assert.equal(camera.headingConfidence, 'medium');
  assert.equal(camera.sourceKind, 'nvfast-dashboard');
  assert.equal(camera.groundElevationM, 620);
});

test('stills-only rows, repeated ids in names and the video switch', () => {
  const rows = parseNvfastCatalogPage(PAGE);
  const symphony = nvfastRowToSource(rows[1]);
  assert.equal(symphony.feedType, 'image');
  assert.equal(symphony.url, 'https://bugatti.nvfast.org/Snapshots/102.jpeg');
  assert.equal(symphony.headingDeg, 0);
  const charleston = nvfastRowToSource(rows[2]);
  assert.equal(charleston.name, 'I-15 NB Charleston On');
  const noVideo = nvfastRowToSource(rows[0], { video: false });
  assert.equal(noVideo.feedType, 'image');
  assert.equal(noVideo.url, noVideo.snapshotUrl);
  const sign = nvfastRowToSource(rows[4]);
  assert.equal(sign.headingConfidence, 'low');
});

test('rows with a bad id, no position, or a point outside Clark County are dropped', () => {
  assert.equal(nvfastRowToSource(['abc', 'x', 36.1, -115.1, 'snapshot', null]), null);
  assert.equal(nvfastRowToSource([5, 'x', 'n/a', -115.1, 'snapshot', null]), null);
  assert.equal(nvfastRowToSource([5, 'x', 39.5, -119.8, 'snapshot', null]), null);
  assert.equal(nvfastRowToSource('not a row'), null);
  assert.equal(nvfastRowToSource([5, 'Laughlin', 35.17, -114.57, 'snapshot', null]).city, 'Clark County');
});

test('only NDOT playlists on its own hosts are accepted as streams', () => {
  const good = 'https://d1wse2.its.nv.gov:443/vegasxcd05/i-15_nb_oakey_public.stream/playlist.m3u8';
  assert.equal(
    nvfastStreamUrl(good),
    'https://d1wse2.its.nv.gov/vegasxcd05/i-15_nb_oakey_public.stream/playlist.m3u8',
  );
  for (const bad of [
    null,
    '',
    'http://d1wse1.its.nv.gov/vegasxcd04/x.stream/playlist.m3u8',
    'https://evil.invalid/vegasxcd04/x.stream/playlist.m3u8',
    'https://d1wse1.its.nv.gov:8443/vegasxcd04/x.stream/playlist.m3u8',
    'https://user:pw@d1wse1.its.nv.gov/vegasxcd04/x.stream/playlist.m3u8',
    'https://d1wse1.its.nv.gov/vegasxcd04/x.stream/playlist.m3u8?token=1',
    'https://d1wse1.its.nv.gov/vegasxcd04/x.stream/chunklist.m3u8',
    'https://d1wse1.its.nv.gov/x.stream/playlist.m3u8',
  ])
    assert.equal(nvfastStreamUrl(bad), null, String(bad));
});

test('the probe sample takes turns across NDOT hosts and spaces its picks through each host', () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => [300 + i, `A ${i}`, 36.1, -115.1, 'snapshot', playlist(1, `a${i}`)]),
    [401, 'B 0', 36.1, -115.1, 'snapshot', playlist(2, 'b0')],
    [402, 'B 1', 36.1, -115.1, 'snapshot', playlist(2, 'b1')],
    [501, 'C 0', 36.1, -115.1, 'snapshot', playlist(3, 'c0')],
    [502, 'C again', 36.1, -115.1, 'snapshot', playlist(3, 'c0')],
    [601, 'still', 36.1, -115.1, 'snapshot', null],
    [602, 'foreign', 36.1, -115.1, 'snapshot', 'https://evil.invalid/vegasxcd04/x.stream/playlist.m3u8'],
    'not a row',
  ];
  const picks = sampleNvfastPlaylists(rows);
  assert.equal(picks.length, NVFAST_PROBE_MAX_PLAYLISTS);
  assert.equal(new Set(picks).size, picks.length);
  const hosts = picks.map((url) => new URL(url).hostname);
  assert.equal(hosts.filter((host) => host === 'd1wse1.its.nv.gov').length, 3);
  assert.equal(hosts.filter((host) => host === 'd1wse2.its.nv.gov').length, 2);
  assert.equal(hosts.filter((host) => host === 'd1wse3.its.nv.gov').length, 1);
  // Hosts alternate, so the requests in flight at any moment spread across them.
  assert.deepEqual(hosts.slice(0, 3), ['d1wse1.its.nv.gov', 'd1wse2.its.nv.gov', 'd1wse3.its.nv.gov']);
  // Within a host the picks are spaced through its list, not its first rows.
  assert.deepEqual(
    picks.filter((url) => url.includes('d1wse1')),
    [registered(1, 'a0'), registered(1, 'a3'), registered(1, 'a6')],
  );
  assert.deepEqual(sampleNvfastPlaylists(rows, 2), [registered(1, 'a0'), registered(2, 'b0')]);
  assert.deepEqual(sampleNvfastPlaylists(rows, 0), []);
  assert.deepEqual(sampleNvfastPlaylists([[1, 'x', 36.1, -115.1, 'snapshot', null]]), []);
  assert.deepEqual(sampleNvfastPlaylists('nope'), []);
});

test('the probe never has more playlists in flight than its concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return m3u8();
  };
  const urls = Array.from({ length: 8 }, (_, i) => registered(1, `s${i}`));
  const result = await probeNvfastVideo(urls, { fetchImpl });
  assert.equal(peak, NVFAST_PROBE_CONCURRENCY);
  assert.deepEqual(result, { answered: 8, probed: 8, refused: null });
  assert.deepEqual([...asked].sort(), [...urls].sort());
  peak = 0;
  const narrow = await probeNvfastVideo(urls.slice(0, 5), { fetchImpl, concurrency: 2 });
  assert.equal(peak, 2);
  assert.equal(narrow.probed, 5);
  assert.deepEqual(await probeNvfastVideo([], { fetchImpl }), { answered: 0, probed: 0, refused: null });
});

test('only a 200 whose body starts #EXTM3U counts as an answer', async () => {
  const answers = {
    s0: ['<html>not a playlist</html>', 200],
    s1: ['', 404],
    s2: ['', 302],
    s3: [M3U8, 200],
    s4: ['﻿#EXTM3U\n#EXT-X-VERSION:3\n', 200],
    s5: [M3U8, 500],
  };
  const fetchImpl = async (url) => {
    const [body, status] = answers[/\/(s\d)_public/.exec(String(url))[1]];
    return new Response(body, { status });
  };
  const result = await probeNvfastVideo(
    Object.keys(answers).map((name) => registered(1, name)),
    { fetchImpl },
  );
  assert.deepEqual(result, { answered: 2, probed: 6, refused: null });
});

test('a playlist that never answers is silent after the deadline, not an error', async () => {
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener(
        'abort',
        () => reject(init.signal.reason ?? new Error('aborted')),
        { once: true },
      );
    });
  const started = Date.now();
  const result = await probeNvfastVideo([registered(1, 'slow')], { fetchImpl, timeoutMs: 30 });
  assert.deepEqual(result, { answered: 0, probed: 1, refused: null });
  assert.ok(Date.now() - started < 2000);
  const broken = await probeNvfastVideo([registered(1, 'down')], {
    fetchImpl: () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.deepEqual(broken, { answered: 0, probed: 1, refused: null });
});

test('a 403 ends the probe for the load and is named in the verdict', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    return new Response('', { status: 403 });
  };
  const urls = Array.from({ length: 6 }, (_, i) => registered(1, `s${i}`));
  const result = await probeNvfastVideo(urls, { fetchImpl, concurrency: 1 });
  assert.deepEqual(result, { answered: 0, probed: 1, refused: 403 });
  assert.equal(asked.length, 1);
  const rows = urls.map((url, i) => [700 + i, `S ${i}`, 36.1, -115.1, 'snapshot', url]);
  const decision = await resolveNvfastVideo(rows, {}, { fetchImpl, concurrency: 1 });
  assert.deepEqual(decision, {
    video: false,
    note: 'probe 0/1 playlists answered, stopped at HTTP 403, registering stills',
  });
});

test('a table without playlists is stills with no probe request', async () => {
  const fetchImpl = async () => {
    throw new Error('must not be called');
  };
  assert.deepEqual(
    await resolveNvfastVideo([[1, 'x', 36.1, -115.1, 'snapshot', null]], {}, { fetchImpl }),
    { video: false, note: 'no row names an NDOT playlist' },
  );
});

test('the loader fetches the page once, dedupes ids, ranks the valley first and caps', async (t) => {
  captureConsole(t);
  const requested = mockFetch(t, () =>
    html(PAGE.replace('[84002,', '[102,"dup",36.1,-115.1,"snapshot",null],[84002,')),
  );
  const cameras = await loadNvfastSources({}, { CCTV_NVFAST_MAX_SOURCES: '20', CCTV_NVFAST_VIDEO: '0' });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, NVFAST_CATALOG_URL);
  assert.equal(requested[0].init.redirect, 'manual');
  assert.equal(cameras.length, 5);
  assert.ok(cameras.every((camera, i, all) => all.findIndex((c) => c.id === camera.id) === i));
  assert.equal(cameras[0].city, 'Las Vegas');
  assert.ok(cameras.every((camera) => camera.feedType === 'image'));
});

test('CCTV_NVFAST_VIDEO=1 and =0 decide without a probe', async (t) => {
  const lines = captureConsole(t);
  const requested = mockFetch(t, () => html(PROBE_PAGE));
  const on = await loadNvfastSources({}, { CCTV_NVFAST_VIDEO: '1' });
  assert.equal(requested.length, 1);
  assert.equal(on.length, 12);
  assert.equal(on.filter((camera) => camera.feedType === 'hls').length, 10);
  assert.ok(
    lines.some((line) =>
      line.includes('(using nearest 12, 10 with NDOT video; CCTV_NVFAST_VIDEO=1, registering NDOT video unprobed)'),
    ),
    lines.join('\n'),
  );
  requested.length = 0;
  lines.length = 0;
  const off = await loadNvfastSources({}, { CCTV_NVFAST_VIDEO: '0' });
  assert.equal(requested.length, 1);
  assert.ok(off.every((camera) => camera.feedType === 'image'));
  assert.ok(
    lines.some((line) => line.includes('0 with NDOT video; CCTV_NVFAST_VIDEO=0, registering stills)')),
    lines.join('\n'),
  );
});

test('with the switch unset a probe that hears NDOT registers video for every row with a playlist', async (t) => {
  const lines = captureConsole(t);
  const requested = mockFetch(t, (url) => (url === NVFAST_CATALOG_URL ? html(PROBE_PAGE) : m3u8()));
  const cameras = await loadNvfastSources({}, {});
  const probed = probedUrls(requested);
  assert.equal(probed.length, NVFAST_PROBE_MAX_PLAYLISTS);
  assert.ok(probed.every((url) => NDOT_HOST.test(url)), probed.join('\n'));
  assert.equal(new Set(probed.map((url) => new URL(url).hostname)).size, 3);
  // Probe requests follow the pack's own rules.
  for (const { url, init } of requested.filter((r) => r.url !== NVFAST_CATALOG_URL)) {
    assert.equal(init.headers['User-Agent'], 'osiris-cctv-proxy/1.0', url);
    assert.equal(init.redirect, 'manual', url);
    assert.ok(init.signal instanceof AbortSignal, url);
  }
  assert.equal(cameras.length, 12);
  assert.equal(cameras.filter((camera) => camera.feedType === 'hls').length, 10);
  const live = cameras.find((camera) => camera.id === 'nvfast-201');
  assert.equal(live.url, registered(1, 'a0'));
  assert.equal(live.snapshotUrl, 'https://bugatti.nvfast.org/Snapshots/201.jpeg');
  const still = cameras.find((camera) => camera.id === 'nvfast-501');
  assert.equal(still.feedType, 'image');
  assert.equal(still.url, still.snapshotUrl);
  assert.ok(
    lines.some((line) =>
      line.includes('(using nearest 12, 10 with NDOT video; probe 6/6 playlists answered, registering NDOT video)'),
    ),
    lines.join('\n'),
  );
});

test('with the switch unset a probe that hears nothing registers stills and says so', async (t) => {
  const lines = captureConsole(t);
  const requested = mockFetch(t, (url) =>
    url === NVFAST_CATALOG_URL ? html(PROBE_PAGE) : html('<html>Not Found</html>', 404),
  );
  const cameras = await loadNvfastSources({}, {});
  assert.equal(probedUrls(requested).length, NVFAST_PROBE_MAX_PLAYLISTS);
  assert.equal(cameras.length, 12);
  assert.ok(cameras.every((camera) => camera.feedType === 'image'));
  assert.ok(cameras.every((camera) => camera.url === camera.snapshotUrl));
  assert.ok(
    lines.some((line) =>
      line.includes('(using nearest 12, 0 with NDOT video; probe 0/6 playlists answered, registering stills)'),
    ),
    lines.join('\n'),
  );
  assert.ok(!lines.some((line) => line.includes('download error')), lines.join('\n'));
});

test('a probe whose requests fail degrades to stills, never to an empty pack', async (t) => {
  const lines = captureConsole(t);
  mockFetch(t, (url) => {
    if (url === NVFAST_CATALOG_URL) return html(PROBE_PAGE);
    throw new Error('ECONNRESET');
  });
  const cameras = await loadNvfastSources({}, {});
  assert.equal(cameras.length, 12);
  assert.ok(cameras.every((camera) => camera.feedType === 'image'));
  assert.ok(lines.some((line) => line.includes('probe 0/6 playlists answered, registering stills')), lines.join('\n'));
  assert.ok(!lines.some((line) => line.includes('download error')), lines.join('\n'));
});

test('an upstream failure yields an empty pack, never a throw', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  assert.deepEqual(await loadNvfastSources({}, {}), []);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await loadNvfastSources({}, {}), []);
});
