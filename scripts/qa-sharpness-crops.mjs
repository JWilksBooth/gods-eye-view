#!/usr/bin/env node
/**
 * qa-sharpness-crops — 100% crops of fixed San Francisco and Las Vegas views
 * under each Performance preset, so the sharpness of two builds can be
 * compared pixel for pixel.
 *
 * It opens the app with the preset remembered in localStorage before the
 * first script runs (the same route a returning visitor takes, so a build
 * without `?quality=` is measured the same way), hides the UI chrome, turns
 * every data layer off, parks the camera on each view, waits until the globe
 * and any 3D tileset report every tile loaded, then crops the middle of the
 * viewport at device resolution. It is a capture tool, not a pass/fail gate.
 *
 * The views read the keyless globe (Esri World Imagery) unless the dev
 * server has map keys, so run every build under comparison the same way.
 *
 * Usage:
 *   node scripts/qa-sharpness-crops.mjs --url http://127.0.0.1:4173 --label after
 *     [--presets balanced,quality] [--views sf,lv] [--out docs/media/perf]
 *     [--crop 320x200] [--dpr 1] [--gpu] [--chrome /path/to/chrome]
 *     [--full qa-shots/sharpness]
 *
 * Writes `<view>-<preset>-<label>.png` crops to --out, and the full frames
 * plus a JSON record of the render settings each crop was taken at to --full.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
const list = (value) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const rawUrl = arg('--url', 'http://127.0.0.1:4173');
const url = `${rawUrl.replace(/\/$/, '')}/?welcome=0`;
const label = arg('--label', 'capture');
const presets = list(arg('--presets', 'balanced,quality'));
const viewIds = list(arg('--views', 'sf,lv'));
const outDir = path.resolve(arg('--out', 'docs/media/perf'));
const fullDir = path.resolve(arg('--full', 'qa-shots/sharpness'), label);
const [cropWidth, cropHeight] = arg('--crop', '320x200')
  .split('x')
  .map((n) => Number(n) || 0);
const deviceScaleFactor = Number(arg('--dpr', '1')) || 1;
const useGpu = flag('--gpu');
const VIEWPORT = { width: 1600, height: 900 };
const PRESET_STORAGE_KEY = 'gev:performance-preset:v1';

/**
 * Oblique views over detailed imagery: the middle of the frame sits a few
 * hundred metres out at a glancing angle, where imagery level and texture
 * filtering both show.
 */
const VIEWS = {
  sf: {
    name: 'San Francisco, the Embarcadero toward the Financial District',
    lat: 37.7975,
    lon: -122.3895,
    height: 650,
    heading: 235,
    pitch: -32,
  },
  lv: {
    name: 'Las Vegas, the Strip looking north',
    lat: 36.0985,
    lon: -115.1735,
    height: 650,
    heading: 0,
    pitch: -32,
  },
};

const chromePath =
  arg('--chrome', null) ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  [
    '/opt/pw-browsers/chromium/chrome-linux64/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => existsSync(p)) ||
  undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });
mkdirSync(fullDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: chromePath,
  protocolTimeout: 600_000,
  args: [
    '--no-sandbox',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
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

/** Poll until the globe and the 3D tileset report all tiles loaded. */
async function waitForTiles(
  page,
  { timeoutMs = 90_000, settleMs = 2500 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let loadedSince = 0;
  while (Date.now() < deadline) {
    const loaded = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      gev.requestRender?.('sharpness-crop');
      const scene = gev.viewer.scene;
      const globeDone = !scene.globe.show || scene.globe.tilesLoaded;
      const tileset = gev.tileset;
      const tilesetDone =
        !tileset || !tileset.show || tileset.tilesLoaded !== false;
      return globeDone && tilesetDone;
    });
    if (loaded) {
      loadedSince ||= Date.now();
      if (Date.now() - loadedSince >= settleMs) return true;
    } else loadedSince = 0;
    await sleep(250);
  }
  return false;
}

const record = {
  label,
  url,
  deviceScaleFactor,
  viewport: VIEWPORT,
  crop: { width: cropWidth, height: cropHeight },
  captures: [],
};

try {
  for (const preset of presets) {
    const page = await browser.newPage();
    page.on('pageerror', (error) =>
      console.warn('  [page error]', error.message),
    );
    await page.evaluateOnNewDocument(
      (key, id) => {
        try {
          localStorage.setItem(key, id);
        } catch {
          /* storage unavailable */
        }
      },
      PRESET_STORAGE_KEY,
      preset,
    );
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__godsEyeView?.viewer, {
      timeout: 180_000,
    });
    await sleep(12_000); // boot flyTo + deferred init
    const settings = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      for (const [id, entry] of gev.dataManager.layers)
        if (entry.enabled)
          await gev.dataManager
            .setEnabled(id, false, { origin: 'programmatic' })
            .catch(() => {});
      gev.styleManager.setCleanView?.(true);
      const gl = gev.viewer.scene.context._gl;
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: info
          ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        preset: gev.styleManager.getPerformancePreset?.() ?? null,
        mapStack: gev.mapStackController?.getActiveId?.() ?? null,
      };
    });
    console.log(`== ${preset}: ${JSON.stringify(settings)}`);
    for (const id of viewIds) {
      const view = VIEWS[id];
      if (!view) throw new Error(`unknown view ${id}`);
      await page.evaluate((v) => {
        const gev = window.__godsEyeView;
        const camera = gev.viewer.camera;
        camera.cancelFlight();
        const toRad = Math.PI / 180;
        camera.setView({
          destination: gev.viewer.scene.globe.ellipsoid.cartographicToCartesian(
            {
              longitude: v.lon * toRad,
              latitude: v.lat * toRad,
              height: v.height,
            },
          ),
          orientation: {
            heading: v.heading * toRad,
            pitch: v.pitch * toRad,
            roll: 0,
          },
        });
        gev.requestRender?.('sharpness-crop');
      }, view);
      const settled = await waitForTiles(page);
      const render = await page.evaluate(() => {
        const gev = window.__godsEyeView;
        const { viewer } = gev;
        return {
          snapshot: gev.describePerformancePreset?.() ?? null,
          drawingBuffer: {
            width: viewer.canvas.width,
            height: viewer.canvas.height,
          },
          msaaSamples: viewer.scene.msaaSamples,
          fxaa: viewer.scene.postProcessStages.fxaa.enabled,
          globeMaximumScreenSpaceError:
            viewer.scene.globe.maximumScreenSpaceError,
          globeTileCacheSize: viewer.scene.globe.tileCacheSize,
          resolutionScale: viewer.resolutionScale,
          useBrowserRecommendedResolution:
            viewer.useBrowserRecommendedResolution,
        };
      });
      const full = path.join(fullDir, `${id}-${preset}.png`);
      await page.screenshot({ path: full });
      // The middle of the viewport, at device pixels: a 100% crop.
      const scale = deviceScaleFactor;
      const left = Math.round(((VIEWPORT.width - cropWidth) / 2) * scale);
      const top = Math.round(((VIEWPORT.height - cropHeight) / 2) * scale);
      const crop = path.join(outDir, `${id}-${preset}-${label}.png`);
      await sharp(full)
        .extract({
          left,
          top,
          width: Math.round(cropWidth * scale),
          height: Math.round(cropHeight * scale),
        })
        .png({ compressionLevel: 9, effort: 10 })
        .toFile(crop);
      record.captures.push({
        view: id,
        viewName: view.name,
        preset,
        settled,
        crop: path.relative(process.cwd(), crop),
        ...settings,
        render,
      });
      console.log(
        `  ${id}: ${settled ? 'tiles loaded' : 'TIMED OUT waiting for tiles'}; buffer ${render.drawingBuffer.width}x${render.drawingBuffer.height}, MSAA ${render.msaaSamples}, globe SSE ${render.globeMaximumScreenSpaceError} -> ${path.relative(process.cwd(), crop)}`,
      );
    }
    await page.close();
  }
} finally {
  await browser.close();
  writeFileSync(
    path.join(fullDir, 'crops.json'),
    JSON.stringify(record, null, 2),
  );
}
console.log(`record: ${path.join(fullDir, 'crops.json')}`);
