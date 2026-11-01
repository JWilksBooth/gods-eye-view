#!/usr/bin/env node
/**
 * qa-perf-presets — matched-scene frame-cost measurement for the Performance
 * presets (Quality / Balanced / Performance) and the per-frame layer work.
 *
 * This is a measurement harness, not a pass/fail gate. It follows the protocol
 * in docs/PERFORMANCE.md: a 1600 x 900 viewport at device pixel ratio 1, each
 * scene sampled for 5 seconds of scripted motion and then 5 seconds at rest,
 * live object counts recorded next to every number.
 *
 * Scenes:
 *   idle      — no data layers, camera parked over a city (map view)
 *   layers    — Flights + AIS vessels + CCTV enabled, same camera
 *   cockpit   — an airborne flight tracked, Cockpit entered
 *   traffic   — Street traffic enabled (needs a reachable road source; skipped
 *               when the layer reports no roads within its wait)
 *
 * Per window it records: scene frames (`postRender` fires), rAF ticks, the
 * main-thread cost of a frame (preUpdate → postRender, which also covers the
 * world-overlay paint that runs inside postRender), its p50/p95, the share of
 * wall time the main thread spent inside frames, the detection paint cost, the
 * JS heap, and the drawing-buffer size.
 *
 * `--synthetic` (default on) answers the Flights, Vessels and CCTV feed routes
 * and the imagery tile hosts from this process with generated populations
 * around San Francisco, Los Angeles and Las Vegas, so the scenes are
 * repeatable and run on a machine with no network access to the real feeds.
 * Pass `--no-synthetic` to measure against the live feeds instead (then the
 * counts in the report are the point-in-time populations).
 *
 * Usage:
 *   node scripts/qa-perf-presets.mjs [--url http://127.0.0.1:4173]
 *     [--presets baseline|quality,balanced,performance] [--scenes idle,layers,cockpit,traffic]
 *     [--out qa-shots/perf-presets] [--label name] [--no-synthetic]
 *     [--aircraft 2000] [--vessels 6000] [--cameras 4000] [--window 5000]
 *     [--chrome /path/to/chrome] [--gpu] [--dpr 1] [--profile] [--trace-readpixels]
 *
 * "baseline" measures whatever the app does with no preset selected (the
 * build's default). With `--gpu` the harness does not force SwiftShader, so a
 * desktop GPU is used when the browser can reach one. `--dpr 2` emulates a
 * HiDPI screen at the same 1600 x 900 CSS viewport, where the presets' device
 * pixel policies differ. `--profile` records a V8 CPU profile of every
 * sampled window and prints the top self-time functions and files, so a slow
 * scene can be attributed, not just scored.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import puppeteer from 'puppeteer';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : fallback;
};
const flag = (name) => argv.includes(name);

const rawUrl = arg('--url', 'http://127.0.0.1:4173');
const url = `${rawUrl.replace(/\/$/, '')}/?welcome=0`;
const presets = arg('--presets', 'baseline')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const scenes = arg('--scenes', 'idle,layers,cockpit')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const label = arg(
  '--label',
  new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'),
);
const outDir = path.resolve(arg('--out', 'qa-shots/perf-presets'), label);
const synthetic = !flag('--no-synthetic');
const aircraftCount = Number(arg('--aircraft', '2000')) || 2000;
const vesselCount = Number(arg('--vessels', '6000')) || 6000;
const cameraCount = Number(arg('--cameras', '4000')) || 4000;
const windowMs = Number(arg('--window', '5000')) || 5000;
const useGpu = flag('--gpu');
const deviceScaleFactor = Number(arg('--dpr', '1')) || 1;
const profile = flag('--profile');
const traceReadPixels = flag('--trace-readpixels');
mkdirSync(outDir, { recursive: true });

/**
 * Summarize a V8 CPU profile by self time: the functions and files the main
 * thread spent its samples in. Attribution for "what runs every frame".
 */
function summarizeProfile(cpuProfile, top = 30) {
  const nodes = new Map(cpuProfile.nodes.map((node) => [node.id, node]));
  const selfMs = new Map();
  const { samples, timeDeltas } = cpuProfile;
  for (let i = 0; i < samples.length; i++) {
    const delta = (timeDeltas[i] || 0) / 1000;
    selfMs.set(samples[i], (selfMs.get(samples[i]) || 0) + delta);
  }
  const byFunction = new Map();
  const byFile = new Map();
  let total = 0;
  for (const [id, ms] of selfMs) {
    const frame = nodes.get(id)?.callFrame || {};
    const file = (frame.url || '(native)')
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/\?.*$/, '');
    const name = `${frame.functionName || '(anonymous)'} ${file}:${(frame.lineNumber ?? -1) + 1}`;
    byFunction.set(name, (byFunction.get(name) || 0) + ms);
    byFile.set(file, (byFile.get(file) || 0) + ms);
    total += ms;
  }
  const rank = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([name, ms]) => ({
        name,
        ms: +ms.toFixed(1),
        pct: +((ms / total) * 100).toFixed(1),
      }));
  return {
    totalMs: +total.toFixed(1),
    functions: rank(byFunction),
    files: rank(byFile),
  };
}

const chromePath =
  arg('--chrome', null) ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  [
    '/opt/pw-browsers/chromium/chrome-linux64/chrome',
    '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => existsSync(p)) ||
  undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Synthetic populations ───────────────────────────────────────────────────
// Three generic metro areas; the camera parks over the first.
const CITIES = [
  { name: 'San Francisco', lat: 37.7749, lon: -122.4194, weight: 0.5 },
  { name: 'Los Angeles', lat: 34.0522, lon: -118.2437, weight: 0.3 },
  { name: 'Las Vegas', lat: 36.1699, lon: -115.1398, weight: 0.2 },
];
let seed = 1337;
const rand = () => {
  // Deterministic LCG so every run sees the same population.
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const pickCity = () => {
  const r = rand();
  let acc = 0;
  for (const city of CITIES) {
    acc += city.weight;
    if (r <= acc) return city;
  }
  return CITIES[0];
};
const spread = (center, kmLat, kmLon) => ({
  lat: center.lat + (rand() - 0.5) * 2 * (kmLat / 111),
  lon:
    center.lon +
    (rand() - 0.5) *
      2 *
      (kmLon / (111 * Math.cos((center.lat * Math.PI) / 180))),
});

const AIRCRAFT = Array.from({ length: aircraftCount }, (_, i) => {
  const city = pickCity();
  const pos = spread(city, 60, 60);
  const onGround = rand() < 0.12;
  return {
    icao24: (0xa00000 + i).toString(16),
    callsign: `SYN${String(i).padStart(4, '0')}`,
    lat: pos.lat,
    lon: pos.lon,
    altM: onGround ? 0 : 900 + rand() * 11000,
    onGround,
    speedMps: onGround ? 5 : 120 + rand() * 130,
    course: rand() * 360,
    verticalRate: (rand() - 0.5) * 6,
  };
});
const VESSELS = Array.from({ length: vesselCount }, (_, i) => {
  const city = pickCity();
  // Ships sit west of each city, off the coast / in the bay.
  const pos = spread({ lat: city.lat - 0.1, lon: city.lon - 0.6 }, 90, 90);
  return {
    mmsi: String(366000000 + i),
    name: `SYN VESSEL ${i}`,
    lat: pos.lat,
    lon: pos.lon,
    speed: 2 + rand() * 18,
    course: rand() * 360,
    type: 'Cargo',
  };
});
const CAMERAS = Array.from({ length: cameraCount }, (_, i) => {
  const city = pickCity();
  const pos = spread(city, 12, 12);
  return {
    id: `syn-cam-${i}`,
    name: `SYN CAM ${i}`,
    city: city.name,
    cityId: city.name.toLowerCase().replace(/\s+/g, '-'),
    provider: 'Synthetic QA',
    lat: pos.lat,
    lon: pos.lon,
    headingDeg: Math.round(rand() * 360),
    pitchDeg: -12,
    fovDeg: 60,
    rangeM: 120,
    mountHeightM: 8,
    feedType: 'image',
    url: `/api/cctv/frame/syn-cam-${i}`,
    snapshotUrl: `/api/cctv/frame/syn-cam-${i}`,
    license: 'synthetic',
    sourceKind: 'configured',
  };
});

function advance(track, speedMps, course, seconds) {
  const d = (speedMps * seconds) / 111_000;
  return {
    lat: track.lat + d * Math.cos((course * Math.PI) / 180),
    lon:
      track.lon +
      (d * Math.sin((course * Math.PI) / 180)) /
        Math.cos((track.lat * Math.PI) / 180),
  };
}
const startedAt = Date.now();
function flightsPayload() {
  const t = Math.floor(Date.now() / 1000);
  const elapsed = (Date.now() - startedAt) / 1000;
  return {
    time: t,
    states: AIRCRAFT.map((a) => {
      const p = advance(a, a.speedMps, a.course, elapsed);
      return [
        a.icao24,
        a.callsign,
        'United States',
        t,
        t,
        p.lon,
        p.lat,
        a.altM,
        a.onGround,
        a.speedMps,
        a.course,
        a.verticalRate,
        null,
        a.altM + 30,
        null,
        false,
        0,
        3,
      ];
    }),
  };
}
function vesselsPayload() {
  const t = Math.floor(Date.now() / 1000);
  const elapsed = (Date.now() - startedAt) / 1000;
  return {
    status: 'ok',
    newestPositionAt: t,
    rows: VESSELS.map((v) => {
      const p = advance(v, v.speed * 0.514444, v.course, elapsed);
      return {
        mmsi: v.mmsi,
        name: v.name,
        lat: p.lat,
        lon: p.lon,
        speed: v.speed,
        course: v.course,
        heading: v.course,
        last_position_epoch: t,
        type: v.type,
      };
    }),
  };
}

const TILE_PNG = await sharp({
  create: {
    width: 256,
    height: 256,
    channels: 3,
    background: { r: 70, g: 92, b: 60 },
  },
})
  .png()
  .toBuffer();
const FRAME_PNG = await sharp({
  create: {
    width: 64,
    height: 48,
    channels: 3,
    background: { r: 40, g: 40, b: 48 },
  },
})
  .png()
  .toBuffer();

const IMAGERY_HOSTS = [
  'services.arcgisonline.com',
  'tile.openstreetmap.org',
  'basemaps.cartocdn.com',
  'ecn.t',
  'virtualearth.net',
];
const requestCounts = {};
function installSyntheticRoutes(page) {
  return page.setRequestInterception(true).then(() => {
    page.on('request', (request) => {
      const requestUrl = request.url();
      let kind = null;
      try {
        const parsed = new URL(requestUrl);
        if (parsed.origin === new URL(rawUrl).origin) {
          const p = parsed.pathname;
          if (p === '/api/flights') kind = 'flights';
          else if (p === '/api/vessels') kind = 'vessels';
          else if (p === '/api/cctv/sources') kind = 'cctv-sources';
          else if (p === '/api/cctv/health') kind = 'cctv-health';
          else if (p.startsWith('/api/cctv/frame/')) kind = 'cctv-frame';
          else if (p.startsWith('/api/cctv/media/')) kind = 'cctv-media';
          else if (p === '/api/military') kind = 'military';
        } else if (
          IMAGERY_HOSTS.some((host) => parsed.hostname.includes(host))
        ) {
          kind = 'imagery';
        } else if (
          parsed.hostname.endsWith('googleapis.com') ||
          parsed.hostname.endsWith('gstatic.com')
        ) {
          kind = null; // leave Google routes alone
        } else if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
          kind = 'external';
        }
      } catch {
        kind = null;
      }
      if (kind) requestCounts[kind] = (requestCounts[kind] || 0) + 1;
      const json = (body, headers = {}) =>
        request.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*', ...headers },
          body: JSON.stringify(body),
        });
      switch (kind) {
        case 'flights':
          return json(flightsPayload(), {
            'x-feed-source': 'Synthetic QA',
            'x-flight-coverage': 'synthetic',
          });
        case 'vessels':
          return json(vesselsPayload(), { 'x-feed-source': 'Synthetic QA' });
        case 'military':
          return json(
            { now: Date.now() / 1000, aircraft: [] },
            { 'x-feed-source': 'Synthetic QA' },
          );
        case 'cctv-sources':
          return json({ sources: CAMERAS });
        case 'cctv-health':
          return json({ cameras: [] });
        case 'cctv-frame':
          return request.respond({
            status: 200,
            contentType: 'image/png',
            headers: {
              'x-cctv-source': 'upstream',
              'access-control-allow-origin': '*',
            },
            body: FRAME_PNG,
          });
        case 'cctv-media':
          return request.respond({
            status: 404,
            contentType: 'text/plain',
            body: 'no media',
          });
        case 'imagery':
          return request.respond({
            status: 200,
            contentType: 'image/png',
            headers: { 'access-control-allow-origin': '*' },
            body: TILE_PNG,
          });
        case 'external':
          return request.abort('blockedbyclient');
        default:
          return request.continue();
      }
    });
  });
}

// ── Browser ─────────────────────────────────────────────────────────────────
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: chromePath,
  protocolTimeout: 600_000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1600,900',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--ignore-gpu-blocklist',
    ...(useGpu
      ? []
      : [
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
        ]),
  ],
});

const results = {
  label,
  url,
  synthetic,
  windowMs,
  deviceScaleFactor,
  presets: {},
  population: {
    aircraft: aircraftCount,
    vessels: vesselCount,
    cameras: cameraCount,
  },
  renderer: null,
};

const CAMERA = {
  // Map view over the first city: an oblique look across the downtown core.
  lat: CITIES[0].lat,
  lon: CITIES[0].lon,
  height: 1800,
  heading: 25,
  pitch: -38,
};

async function openApp() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor });
  page.on('pageerror', (error) =>
    console.warn('  [page error]', error.message),
  );
  if (synthetic) await installSyntheticRoutes(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, {
    timeout: 120_000,
  });
  await sleep(12_000); // boot flyTo + deferred init
  if (synthetic) {
    // The synthetic imagery route answers plain tile requests; the OSM stack
    // needs no provider metadata, so it is the one that draws under the
    // synthetic feeds. A real-feed run keeps whatever stack the app chose.
    await page.evaluate(async () => {
      await window.__godsEyeView.mapStackController?.setStack?.('osm', {
        silent: true,
      });
    });
    await sleep(3000);
  }
  if (traceReadPixels) {
    // Count synchronous GPU read-backs (scene picks, height samples) by the
    // application frames that issued them. readPixels is a pipeline stall on
    // every GPU, and under SwiftShader it is where the frame goes.
    await page.evaluate(() => {
      const counts = new Map();
      const wrap = (proto) => {
        if (!proto?.readPixels || proto.readPixels.__traced) return;
        const original = proto.readPixels;
        const traced = function (...args) {
          const stack = (new Error().stack || '')
            .split('\n')
            .slice(2)
            .filter(
              (line) => line.includes('/src/') || line.includes('cesium.js'),
            )
            .slice(0, 6)
            .map((line) =>
              line
                .trim()
                .replace(/^at /, '')
                .replace(/https?:\/\/[^/]+/, ''),
            )
            .join(' <- ');
          counts.set(stack, (counts.get(stack) || 0) + 1);
          return original.apply(this, args);
        };
        traced.__traced = true;
        proto.readPixels = traced;
      };
      wrap(globalThis.WebGL2RenderingContext?.prototype);
      wrap(globalThis.WebGLRenderingContext?.prototype);
      window.__perfReadPixels = (reset = true) => {
        const rows = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([stack, n]) => ({ n, stack }));
        if (reset) counts.clear();
        return rows;
      };
    });
  }
  await page.evaluate(() => {
    const gev = window.__godsEyeView;
    // The frame-rate readout the owner uses in the field (backtick key).
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '`',
        code: 'Backquote',
        bubbles: true,
      }),
    );
    window.__perfSample = (ms) =>
      new Promise((resolve) => {
        const scene = gev.viewer.scene;
        let renders = 0;
        let rafs = 0;
        let frameStart = 0;
        const frameMs = [];
        const gaps = [];
        let lastPost = 0;
        const removePre = scene.preUpdate.addEventListener(() => {
          frameStart = performance.now();
        });
        const removePost = scene.postRender.addEventListener(() => {
          const now = performance.now();
          renders += 1;
          if (frameStart) frameMs.push(now - frameStart);
          if (lastPost) gaps.push(now - lastPost);
          lastPost = now;
        });
        const paintBefore =
          gev.styleManager.getDetectionDiagnostics?.() || null;
        const t0 = performance.now();
        const tick = () => {
          rafs += 1;
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else {
            removePre();
            removePost();
            const elapsed = performance.now() - t0;
            const sorted = frameMs.slice().sort((a, b) => a - b);
            const q = (p) =>
              sorted.length
                ? sorted[
                    Math.min(sorted.length - 1, Math.floor(p * sorted.length))
                  ]
                : null;
            const busyMs = frameMs.reduce((a, b) => a + b, 0);
            const paintAfter =
              gev.styleManager.getDetectionDiagnostics?.() || null;
            resolve({
              elapsedMs: Math.round(elapsed),
              renders,
              rafs,
              fps: +(renders / (elapsed / 1000)).toFixed(1),
              rafHz: +(rafs / (elapsed / 1000)).toFixed(1),
              frameMsMean: frameMs.length
                ? +(busyMs / frameMs.length).toFixed(2)
                : null,
              frameMsP50: q(0.5) == null ? null : +q(0.5).toFixed(2),
              frameMsP95: q(0.95) == null ? null : +q(0.95).toFixed(2),
              mainThreadBusyPct: +((busyMs / elapsed) * 100).toFixed(1),
              detectionPaintMs:
                paintAfter?.lastPaintMs ?? paintAfter?.paintMs ?? null,
              detectionFrames:
                paintAfter?.frameCount != null &&
                paintBefore?.frameCount != null
                  ? paintAfter.frameCount - paintBefore.frameCount
                  : null,
              heapMiB: performance.memory
                ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1)
                : null,
              drawingBuffer: `${gev.viewer.canvas.width}x${gev.viewer.canvas.height}`,
              resolutionScale: gev.viewer.resolutionScale,
              // The preset's own account: pixel ratio, globe and tile
              // detail (builds without the snapshot report null).
              preset: gev.describePerformancePreset?.() ?? null,
              msaa: gev.viewer.scene.msaaSamples,
              fxaa: gev.viewer.scene.postProcessStages.fxaa.enabled,
              requestRenderMode: scene.requestRenderMode,
              holds: gev.getRenderGovernorDiagnostics?.().holds || [],
              fpsReadout:
                document.querySelector('.frame-rate-readout')?.textContent ||
                null,
            });
          }
        };
        requestAnimationFrame(tick);
      });
    window.__perfMotion = (ms) =>
      new Promise((resolve) => {
        const camera = gev.viewer.camera;
        const t0 = performance.now();
        let phase = 0;
        const step = () => {
          // A slow pan with a heading sweep: every frame moves the camera, so
          // requestRenderMode renders every frame, as a user drag would.
          camera.moveRight(1.5);
          camera.lookRight(0.0012);
          phase += 1;
          if (phase % 240 === 0) camera.moveUp(0);
          if (performance.now() - t0 < ms) requestAnimationFrame(step);
          else resolve(true);
        };
        requestAnimationFrame(step);
      });
    window.__perfPark = ({ lat, lon, height, heading, pitch }) => {
      const v = gev.viewer;
      v.camera.cancelFlight();
      v.camera.setView({
        destination: window.Cesium
          ? window.Cesium.Cartesian3.fromDegrees(lon, lat, height)
          : v.scene.globe.ellipsoid.cartographicToCartesian({
              longitude: (lon * Math.PI) / 180,
              latitude: (lat * Math.PI) / 180,
              height,
            }),
        orientation: {
          heading: (heading * Math.PI) / 180,
          pitch: (pitch * Math.PI) / 180,
          roll: 0,
        },
      });
    };
    window.__perfCounts = () => {
      const out = {};
      for (const [id, entry] of gev.dataManager.layers) {
        if (!entry.enabled) continue;
        try {
          const stats = entry.module.getStats?.();
          out[id] = stats?.count ?? null;
        } catch {
          out[id] = null;
        }
      }
      return out;
    };
  });
  return page;
}

async function describeRenderer(page) {
  return page.evaluate(() => {
    const gl = window.__godsEyeView.viewer.scene.context._gl;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info
      ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  });
}

async function setAllLayers(page, enabledIds) {
  await page.evaluate(async (ids) => {
    const gev = window.__godsEyeView;
    for (const [id, entry] of gev.dataManager.layers) {
      const want = ids.includes(id);
      if (entry.enabled !== want) {
        try {
          await gev.dataManager.setEnabled(id, want, {
            origin: 'programmatic',
          });
        } catch (error) {
          console.warn('setEnabled failed', id, error?.message);
        }
      }
    }
  }, enabledIds);
}

async function waitForCounts(page, ids, minimum, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let counts = {};
  while (Date.now() < deadline) {
    counts = await page.evaluate(() => window.__perfCounts());
    if (ids.every((id) => (counts[id] || 0) >= minimum)) return counts;
    await sleep(1000);
  }
  return counts;
}

async function applyPreset(page, preset) {
  return page.evaluate((name) => {
    const gev = window.__godsEyeView;
    if (name === 'baseline')
      return {
        applied: 'baseline',
        current: gev.styleManager.getPerformancePreset?.() ?? null,
      };
    if (typeof gev.styleManager.setPerformancePreset !== 'function')
      return { applied: null, error: 'no preset API in this build' };
    gev.styleManager.setPerformancePreset(name);
    return {
      applied: name,
      current: gev.styleManager.getPerformancePreset?.() ?? null,
    };
  }, preset);
}

async function profiled(page, name, run) {
  if (!profile) return run();
  const client = await page.createCDPSession();
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 500 });
  await client.send('Profiler.start');
  try {
    return await run();
  } finally {
    const { profile: cpuProfile } = await client.send('Profiler.stop');
    await client.detach();
    const summary = summarizeProfile(cpuProfile);
    writeFileSync(
      path.join(outDir, `${name}.cpuprofile`),
      JSON.stringify(cpuProfile),
    );
    writeFileSync(
      path.join(outDir, `${name}.profile.json`),
      JSON.stringify(summary, null, 2),
    );
    console.log(
      `    profile ${name}: ${summary.totalMs} ms sampled; top files:`,
    );
    for (const row of summary.files.slice(0, 8))
      console.log(`      ${row.pct}% ${row.ms} ms ${row.name}`);
    console.log('    top functions:');
    for (const row of summary.functions.slice(0, 12))
      console.log(`      ${row.pct}% ${row.ms} ms ${row.name}`);
  }
}

async function sampleScene(page, name) {
  await page.evaluate((camera) => window.__perfPark(camera), CAMERA);
  await sleep(4000); // tiles + settle
  const countsBefore = await page.evaluate(() => window.__perfCounts());
  const motion = await profiled(page, `${name}-motion`, () =>
    Promise.all([
      page.evaluate((ms) => window.__perfSample(ms), windowMs),
      page.evaluate((ms) => window.__perfMotion(ms), windowMs),
    ]).then(([sample]) => sample),
  );
  await sleep(1500);
  const rest = await profiled(page, `${name}-rest`, () =>
    page.evaluate((ms) => window.__perfSample(ms), windowMs),
  );
  const counts = await page.evaluate(() => window.__perfCounts());
  const shot = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: shot });
  return { motion, rest, counts: { ...countsBefore, ...counts } };
}

async function runScene(page, scene) {
  if (scene === 'idle') {
    await setAllLayers(page, []);
    await sleep(3000);
    return sampleScene(page, 'idle');
  }
  if (scene === 'layers') {
    const ids = ['flights', 'ais-live-vessels', 'cctv'];
    await setAllLayers(page, ids);
    await page.evaluate((camera) => window.__perfPark(camera), CAMERA);
    const counts = await waitForCounts(page, ids, 1, 90_000);
    console.log('    layer populations:', JSON.stringify(counts));
    await sleep(6000);
    return sampleScene(page, 'layers');
  }
  if (scene === 'cockpit') {
    // Cockpit entry is gated on Contacts context with Flights AND Military on
    // (src/contextModePolicy.js), the same route scripts/qa-cockpit-utility.mjs
    // takes: track a flight, select the Contacts mode, then enter.
    await setAllLayers(page, [
      'flights',
      'military',
      'ais-live-vessels',
      'cctv',
    ]);
    await page.evaluate((camera) => window.__perfPark(camera), CAMERA);
    await waitForCounts(page, ['flights'], 1, 90_000);
    const entered = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const flights = gev.dataManager.layers.get('flights')?.module;
      try {
        await Promise.race([
          gev.styleManager._contextControls?._selectContextMode?.('flights'),
          new Promise((r) => setTimeout(r, 30_000)),
        ]);
      } catch (error) {
        console.warn('Contacts mode failed', error?.message);
      }
      const candidates = flights?.getAllPositions?.(500) || [];
      const airborne =
        candidates.find((c) => Number(c.altitudeM) > 1500) || candidates[0];
      if (!airborne) return { ok: false, reason: 'no aircraft' };
      const tracked = flights.trackById?.(airborne.id);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !gev.viewer.trackedEntity?.position)
        await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1500));
      const view = gev.styleManager.cockpitView;
      view?.syncEntry?.();
      const result = view?.enter?.();
      return {
        ok: Boolean(result),
        tracked: Boolean(tracked),
        id: airborne.id,
        active: view?.active,
        entryAllowed: view?.isEntryAllowed?.(),
        hasInfo: Boolean(view?.readAircraftInfo?.()),
        hasTrackedEntity: Boolean(gev.viewer.trackedEntity?.position),
      };
    });
    console.log('    cockpit entry:', JSON.stringify(entered));
    await sleep(5000);
    // Cockpit owns the camera, so the "motion" window is the cockpit's own
    // flight; the scripted pan is not applied.
    const motion = await profiled(page, 'cockpit-a', () =>
      page.evaluate((ms) => window.__perfSample(ms), windowMs),
    );
    await sleep(1000);
    const rest = await profiled(page, 'cockpit-b', () =>
      page.evaluate((ms) => window.__perfSample(ms), windowMs),
    );
    const counts = await page.evaluate(() => window.__perfCounts());
    await page.screenshot({ path: path.join(outDir, 'cockpit.png') });
    await page.evaluate(() => {
      const gev = window.__godsEyeView;
      gev.styleManager.cockpitView?.exit?.();
      gev.dataManager.layers.get('flights')?.module?.stopTracking?.();
    });
    await sleep(2000);
    return { motion, rest, counts, entered };
  }
  if (scene === 'traffic') {
    await setAllLayers(page, ['traffic']);
    await page.evaluate(
      (camera) => window.__perfPark({ ...camera, height: 900 }),
      CAMERA,
    );
    const counts = await waitForCounts(page, ['traffic'], 1, 45_000);
    if (!counts.traffic) {
      console.log(
        '    traffic: no roads loaded (source unreachable) — skipped',
      );
      await setAllLayers(page, []);
      return { skipped: 'no roads' };
    }
    await sleep(4000);
    const sampled = await sampleScene(page, 'traffic');
    await setAllLayers(page, []);
    return sampled;
  }
  throw new Error(`unknown scene ${scene}`);
}

function fmt(sample) {
  if (!sample) return '—';
  return `${sample.fps} fps (${sample.renders} frames), frame ${sample.frameMsMean} ms mean / p95 ${sample.frameMsP95} ms, busy ${sample.mainThreadBusyPct}%`;
}

try {
  for (const preset of presets) {
    console.log(`\n== preset: ${preset} ==`);
    const page = await openApp();
    results.renderer ??= await describeRenderer(page);
    console.log('  renderer:', results.renderer);
    const applied = await applyPreset(page, preset);
    console.log('  preset:', JSON.stringify(applied));
    await sleep(2000);
    const presetResult = { applied, scenes: {} };
    for (const scene of scenes) {
      const started = performance.now();
      console.log(`  -- scene: ${scene}`);
      try {
        presetResult.scenes[scene] = await runScene(page, scene);
      } catch (error) {
        console.warn(`    scene ${scene} failed:`, error?.message || error);
        presetResult.scenes[scene] = { error: String(error?.message || error) };
      }
      const r = presetResult.scenes[scene];
      if (traceReadPixels && r) {
        r.readPixels = await page.evaluate(
          () => window.__perfReadPixels?.(true) || [],
        );
        const total = r.readPixels.reduce((a, row) => a + row.n, 0);
        console.log(`    readPixels calls during scene: ${total}`);
        for (const row of r.readPixels.slice(0, 8))
          console.log(`      ${row.n} × ${row.stack}`);
      }
      if (r?.motion) {
        console.log(`    motion: ${fmt(r.motion)}`);
        console.log(`    rest:   ${fmt(r.rest)}`);
        console.log(
          `    buffer ${r.motion.drawingBuffer} scale ${r.motion.resolutionScale} msaa ${r.motion.msaa} fxaa ${r.motion.fxaa} globe SSE ${r.motion.preset?.globe?.maximumScreenSpaceError ?? '-'} holds ${JSON.stringify(r.rest.holds)} heap ${r.rest.heapMiB} MiB counts ${JSON.stringify(r.counts)} (${Math.round((performance.now() - started) / 1000)} s)`,
        );
      }
    }
    results.presets[preset] = presetResult;
    writeFileSync(
      path.join(outDir, 'results.json'),
      JSON.stringify({ ...results, requestCounts }, null, 2),
    );
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\nresults: ${path.join(outDir, 'results.json')}`);
console.log('synthetic request counts:', JSON.stringify(requestCounts));
