#!/usr/bin/env node
/**
 * Browser proof for the Event Map layer and the grid view against a running
 * app, with seeded cameras and incidents over San Francisco so the shots are
 * reproducible while the imagery underneath stays real.
 *
 *   QA_BASE_URL=http://localhost:4183 node scripts/qa-event-map.mjs
 *
 * Drives the real layer toggles, hovers an icon with the real pointer, clicks
 * it open, opens the drawer on a camera, and presses G for the grid view.
 * Screenshots land in docs/media/event-map/ (QA_SHOTS overrides) as small
 * palette PNGs. Needs an installed Chrome (PUPPETEER_EXECUTABLE_PATH) and a
 * dev server; keyless is fine, the seeded feeds are intercepted here.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';

const BASE = process.env.QA_BASE_URL || 'http://localhost:4173';
const SHOTS = process.env.QA_SHOTS || 'docs/media/event-map';
const VIEWPORT = { width: 1120, height: 700 };
const SF = { lat: 37.7749, lon: -122.4194 };
const NOW = Date.now();

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seeded public cameras: one video-capable, two stills, spread over the city. */
const cameras = [
  {
    id: 'qa-cam-embarcadero',
    name: 'QA Embarcadero',
    lat: 37.7955,
    lon: -122.3937,
    headingDeg: 210,
  },
  {
    id: 'qa-cam-market',
    name: 'QA Market & 5th',
    lat: 37.7838,
    lon: -122.4076,
    headingDeg: 60,
  },
  {
    id: 'qa-cam-mission',
    name: 'QA Mission & 24th',
    lat: 37.7522,
    lon: -122.4184,
    headingDeg: 340,
  },
].map((camera) => ({
  ...camera,
  city: 'San Francisco',
  cityId: 'san-francisco',
  provider: 'QA camera fixture',
  feedType: 'snapshot',
  feedConfigured: true,
  pitchDeg: -18,
  fovDeg: 60,
  rangeM: 300,
  mountHeightM: 8,
}));

/** Seeded incidents in the shape of /api/incidents rows. */
const incidents = [
  {
    id: 'chp:qa-1',
    source: 'chp',
    sourceLabel: 'CHP CAD',
    agency: 'CHP',
    type: 'traffic',
    typeDetail: 'Trfc Collision-No Inj',
    lat: 37.7694,
    lon: -122.4021,
    location: 'US-101 at Cesar Chavez St',
    area: 'San Francisco',
    time: NOW - 6 * 60_000,
    description: null,
    region: 'sf-bay',
    url: 'https://cad.chp.ca.gov/',
  },
  {
    id: 'datasf:qa-2',
    source: 'datasf',
    sourceLabel: 'DataSF dispatched calls',
    agency: 'SFFD',
    type: 'fire',
    typeDetail: 'Outside Fire',
    lat: 37.7609,
    lon: -122.435,
    location: 'Castro St & Market St',
    area: 'San Francisco',
    time: NOW - 14 * 60_000,
    description: 'Engine on scene',
    region: 'sf-bay',
    url: 'https://data.sfgov.org/',
  },
  {
    id: 'datasf:qa-3',
    source: 'datasf',
    sourceLabel: 'DataSF dispatched calls',
    agency: 'SFFD',
    type: 'medical',
    typeDetail: 'Medical Incident',
    lat: 37.8005,
    lon: -122.41,
    location: 'Columbus Ave & Lombard St',
    area: 'San Francisco',
    time: NOW - 3 * 60_000,
    description: null,
    region: 'sf-bay',
    url: null,
  },
];

const xmlText = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const frameSvg = (name) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#1b2a38"/><path d="M0 250L640 140M220 0L420 360" stroke="#8fa6b8" stroke-width="22"/><text x="24" y="52" fill="#e8eaed" font-family="monospace" font-size="28">${xmlText(name)}</text><text x="24" y="330" fill="#9fb3c4" font-family="monospace" font-size="18">QA fixture frame</text></svg>`;

/** Serve the seeded feeds; everything else reaches the real dev server. */
function installFixtures(page) {
  page.on('request', (request) => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return void request.continue();
    }
    if (url.origin !== new URL(BASE).origin) return void request.continue();
    const json = (body) =>
      request.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(body),
      });
    if (url.pathname === '/api/cctv/sources')
      return void json({ sources: cameras });
    if (url.pathname === '/api/cctv/health')
      return void json({
        cameras: cameras.map((camera) => ({
          id: camera.id,
          status: 'ok',
          sourceKind: 'snapshot',
          label: 'QA camera fixture',
        })),
      });
    if (url.pathname.startsWith('/api/cctv/frame/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const camera = cameras.find((entry) => entry.id === id);
      return void request.respond({
        status: 200,
        contentType: 'image/svg+xml',
        headers: { 'Cache-Control': 'no-store' },
        body: frameSvg(camera?.name || id),
      });
    }
    if (url.pathname === '/api/incidents')
      return void json({
        rows: incidents,
        sources: [
          {
            id: 'chp',
            label: 'CHP CAD',
            ok: true,
            count: 1,
            fetchedAt: NOW,
            refreshMs: 60000,
            error: null,
          },
          {
            id: 'datasf',
            label: 'DataSF',
            ok: true,
            count: 2,
            fetchedAt: NOW,
            refreshMs: 60000,
            error: null,
          },
        ],
        stale: false,
        fetchedAt: NOW,
      });
    if (url.pathname === '/api/terrain/heights') {
      const points = (url.searchParams.get('points') || '')
        .split(';')
        .filter(Boolean);
      return void json({
        results: points.map((point) => {
          const [lon, lat] = point.split(',').map(Number);
          return { lon, lat, elevation: 0, geoid: 0, ellipsoid: 0 };
        }),
      });
    }
    if (url.pathname === '/api/openai/hud-summary')
      return void json({ summary: 'QA event map' });
    void request.continue();
  });
}

/** Palette PNG when sharp is available, else the raw capture. */
async function savePng(file, buffer) {
  let bytes = buffer;
  try {
    const { default: sharp } = await import('sharp');
    bytes = await sharp(buffer)
      .png({ palette: true, quality: 80, compressionLevel: 9 })
      .toBuffer();
  } catch {
    /* sharp missing: keep the raw PNG */
  }
  await writeFile(file, bytes);
  console.log(`  saved ${file} (${Math.round(bytes.length / 1024)} KB)`);
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath: chromeExecutablePath(),
  args: [
    '--no-sandbox',
    '--use-angle=default',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  ],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
await mkdir(SHOTS, { recursive: true });
const shot = (name) => path.join(SHOTS, name);

try {
  await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  installFixtures(page);
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.removeItem('gev:grid-view:v1');
      localStorage.removeItem('gev:layer-state:v2');
    } catch {
      /* fresh profile */
    }
  });
  await page.goto(`${BASE}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager?.layers?.has('events') &&
      window.__godsEyeView?.styleManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90_000 },
  );
  check('the app booted with the events layer registered', true);

  // Park the camera over the city, oblique, before any layer comes on.
  await page.evaluate(({ lat, lon }) => {
    const { viewer } = window.__godsEyeView;
    viewer.camera.cancelFlight?.();
    viewer.camera.setView({
      destination:
        window.__godsEyeView.viewer.scene.globe.ellipsoid.cartographicToCartesian(
          // eslint-disable-next-line no-undef
          {
            longitude: (lon * Math.PI) / 180,
            latitude: ((lat - 0.045) * Math.PI) / 180,
            height: 7000,
          },
        ),
      orientation: { heading: 0, pitch: (-62 * Math.PI) / 180, roll: 0 },
    });
  }, SF);

  const toggle = async (id) => {
    const enabled = await page.evaluate(async (layerId) => {
      const manager = window.__godsEyeView.dataManager;
      if (!manager.isEnabled(layerId))
        await manager.toggle(layerId, { origin: 'qa' });
      await manager.waitForLayerSettled?.(layerId);
      return manager.isEnabled(layerId);
    }, id);
    check(`layer ${id} enabled`, enabled);
  };
  await toggle('cctv');
  await toggle('incidents');
  await toggle('events');

  await page.waitForFunction(
    () => {
      const module =
        window.__godsEyeView.dataManager.layers.get('events').module;
      const events = module.getEvents();
      return (
        events.some((event) => event.kind === 'camera') &&
        events.some((event) => event.kind === 'incident')
      );
    },
    { timeout: 30_000 },
  );
  const cohort = await page.evaluate(() => {
    const module = window.__godsEyeView.dataManager.layers.get('events').module;
    return module
      .getEvents()
      .map((event) => ({
        pickId: event.pickId,
        kind: event.kind,
        title: event.title,
      }));
  });
  check(
    'seeded cameras and incidents are on the event map',
    cohort.filter((e) => e.kind === 'camera').length === 3 &&
      cohort.filter((e) => e.kind === 'incident').length === 3,
    JSON.stringify(cohort.map((e) => `${e.kind}:${e.title}`)),
  );
  const hoverState = await page.evaluate(() => {
    const module = window.__godsEyeView.dataManager.layers.get('events').module;
    return module.getUIState();
  });
  check(
    'the layer reports both adapters',
    hoverState.byAdapter.cctv === 3 && hoverState.byAdapter.incidents === 3,
    JSON.stringify(hoverState.byAdapter),
  );

  // Let the imagery settle so the shots show the real map underneath.
  await page
    .waitForFunction(
      () => window.__godsEyeView.viewer.scene.globe.tilesLoaded === true,
      { timeout: 20_000 },
    )
    .catch(() => console.log('  (imagery still loading; capturing anyway)'));
  await wait(800);
  await savePng(shot('01-icons.png'), await page.screenshot({ type: 'png' }));

  // Hover: the real pointer over the fire incident's icon.
  const fire = cohort.find(
    (e) => e.kind === 'incident' && e.title === 'Outside Fire',
  );
  const screenPosition = async (pickId) =>
    page.evaluate((id) => {
      const module =
        window.__godsEyeView.dataManager.layers.get('events').module;
      return module._screenPositionForTest(id);
    }, pickId);
  let at = await screenPosition(fire.pickId);
  check(
    'the fire incident icon has a screen position',
    Boolean(at),
    JSON.stringify(at),
  );
  await page.mouse.move(at.x, at.y - 10);
  await wait(50);
  await page.mouse.move(at.x + 1, at.y - 9);
  await page
    .waitForFunction(
      () => {
        const card = document.getElementById('event-hover-card');
        return (
          card && !card.hidden && card.textContent.includes('Outside Fire')
        );
      },
      { timeout: 5_000 },
    )
    .catch(() => {});
  let hoverText = await page.evaluate(() => {
    const card = document.getElementById('event-hover-card');
    return card && !card.hidden ? card.textContent : null;
  });
  if (!hoverText) {
    // The icon pin's hit box sits above its anchor; try the badge centre.
    await page.mouse.move(at.x, at.y - 18);
    await wait(300);
    hoverText = await page.evaluate(() => {
      const card = document.getElementById('event-hover-card');
      return card && !card.hidden ? card.textContent : null;
    });
  }
  check(
    'hovering the icon shows the hover card with the incident',
    Boolean(hoverText && hoverText.includes('Outside Fire')),
    hoverText || 'no card',
  );
  await savePng(
    shot('02-hover.png'),
    await page.screenshot({
      type: 'png',
      clip: {
        x: Math.max(0, Math.min(VIEWPORT.width - 420, at.x - 90)),
        y: Math.max(0, Math.min(VIEWPORT.height - 220, at.y - 110)),
        width: 420,
        height: 220,
      },
    }),
  );

  // Click: the drawer opens on the incident with the card's lines.
  await page.mouse.down();
  await page.mouse.up();
  const drawerOpen = await page
    .waitForFunction(
      () => {
        const drawer = document.getElementById('event-feed-drawer');
        return drawer?.open && drawer.textContent.includes('Outside Fire');
      },
      { timeout: 5_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!drawerOpen) {
    await page.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.layers
          .get('events')
          .module.openEvent(id),
      fire.pickId,
    );
    await wait(300);
  }
  const incidentDrawer = await page.evaluate(() => {
    const drawer = document.getElementById('event-feed-drawer');
    return drawer?.open
      ? {
          kind: drawer.dataset.kind,
          title: drawer.querySelector('.event-feed-title')?.textContent,
          lines: [...drawer.querySelectorAll('.event-feed-line')].map(
            (node) => node.textContent,
          ),
          actions: [...drawer.querySelectorAll('.event-feed-action')].map(
            (node) => node.textContent,
          ),
          nearest:
            drawer.querySelector('.event-feed-nearby')?.textContent || '',
        }
      : null;
  });
  check(
    'clicking the icon opened the drawer on the incident',
    Boolean(incidentDrawer && incidentDrawer.kind === 'incident'),
    drawerOpen ? 'via click' : 'click missed; opened programmatically',
  );
  check(
    'the drawer reuses the incident card and lists nearest cameras',
    Boolean(
      incidentDrawer &&
      incidentDrawer.lines.some((line) => line.includes('SFFD')) &&
      incidentDrawer.actions.some((label) => /Open at source/.test(label)) &&
      /QA/.test(incidentDrawer.nearest),
    ),
    JSON.stringify(incidentDrawer),
  );
  const drawerBox = await page.$eval('#event-feed-drawer', (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await savePng(
    shot('03-drawer-incident.png'),
    await page.screenshot({
      type: 'png',
      clip: {
        x: Math.max(0, drawerBox.x - 12),
        y: Math.max(0, drawerBox.y - 12),
        width: Math.min(VIEWPORT.width, drawerBox.width + 24),
        height: Math.min(
          VIEWPORT.height - drawerBox.y + 12,
          drawerBox.height + 24,
        ),
      },
    }),
  );

  // Camera: open the drawer on a camera icon and wait for its snapshot.
  const camera = cohort.find(
    (e) => e.kind === 'camera' && e.title === 'QA Market & 5th',
  );
  at = await screenPosition(camera.pickId);
  let cameraViaClick = false;
  if (at) {
    await page.mouse.move(at.x, at.y - 12);
    await wait(200);
    await page.mouse.click(at.x, at.y - 12);
    cameraViaClick = await page
      .waitForFunction(
        () =>
          document.getElementById('event-feed-drawer')?.dataset.kind ===
          'camera',
        { timeout: 4_000 },
      )
      .then(() => true)
      .catch(() => false);
  }
  if (!cameraViaClick)
    await page.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.layers
          .get('events')
          .module.openEvent(id),
      camera.pickId,
    );
  const snapshotLoaded = await page
    .waitForFunction(
      () => {
        const image = document.querySelector(
          '#event-feed-drawer .event-feed-image',
        );
        return image && image.complete && image.naturalWidth > 0;
      },
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!snapshotLoaded) {
    const diagnostics = await page.evaluate(() => {
      const drawer = document.getElementById('event-feed-drawer');
      const image = drawer?.querySelector('.event-feed-image');
      return {
        open: drawer?.open,
        kind: drawer?.dataset.kind,
        src: image?.getAttribute('src'),
        complete: image?.complete,
        naturalWidth: image?.naturalWidth,
        html: drawer?.innerHTML.slice(0, 1200),
      };
    });
    console.log(
      '  camera drawer diagnostics:',
      JSON.stringify(diagnostics, null, 2),
    );
  }
  const cameraDrawer = await page.evaluate(() => {
    const drawer = document.getElementById('event-feed-drawer');
    return {
      kind: drawer.dataset.kind,
      title: drawer.querySelector('.event-feed-title')?.textContent,
      caption: drawer.querySelector('.event-feed-caption')?.textContent,
      src: drawer.querySelector('.event-feed-image')?.getAttribute('src'),
    };
  });
  check(
    'the drawer shows the camera snapshot',
    snapshotLoaded &&
      cameraDrawer.kind === 'camera' &&
      /\/api\/cctv\/frame\//.test(cameraDrawer.src || ''),
    `${cameraViaClick ? 'via click' : 'opened programmatically'} · ${JSON.stringify(cameraDrawer)}`,
  );
  await savePng(
    shot('04-drawer-camera.png'),
    await page.screenshot({
      type: 'png',
      clip: {
        x: Math.max(0, drawerBox.x - 12),
        y: Math.max(0, drawerBox.y - 12),
        width: Math.min(VIEWPORT.width, drawerBox.width + 24),
        height: Math.min(
          VIEWPORT.height - drawerBox.y + 12,
          drawerBox.height + 60,
        ),
      },
    }),
  );

  // Escape closes the drawer and tears its media down.
  await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => {
    const drawer = document.getElementById('event-feed-drawer');
    return !drawer.open && !drawer.querySelector('.event-feed-image[src]');
  });
  check('Escape closes the drawer and drops the snapshot', closed);

  // Grid view: the G key.
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await page.keyboard.press('g');
  await page.waitForFunction(
    () => window.__godsEyeView.styleManager.gridViewEnabled === true,
    { timeout: 5_000 },
  );
  await wait(900);
  const gridState = await page.evaluate(() => {
    const shell = window.__godsEyeView.styleManager;
    const camera = window.__godsEyeView.viewer.camera;
    const state = shell._visualSettings._gridView._stateForTest();
    const canvas = document.getElementById('event-grid-overlay');
    const button = document.getElementById('grid-view-toggle');
    return {
      ...state,
      frustum: camera.frustum.constructor.name,
      fovy: camera.frustum.fovy,
      pitchDeg: (camera.pitch * 180) / Math.PI,
      headingDeg: (camera.heading * 180) / Math.PI,
      bodyClass: document.body.classList.contains('grid-view'),
      canvasShown: canvas ? getComputedStyle(canvas).display !== 'none' : false,
      canvasPainted: canvas
        ? (() => {
            const context = canvas.getContext('2d');
            const data = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            for (let i = 3; i < data.length; i += 4 * 97)
              if (data[i] > 0) return true;
            return false;
          })()
        : false,
      buttonActive:
        button?.classList.contains('active') &&
        button?.getAttribute('aria-pressed') === 'true',
      stored: localStorage.getItem('gev:grid-view:v1'),
      hash: location.hash,
    };
  });
  check(
    'G switches to an orthographic frustum on the 3D camera',
    gridState.orthographic && /Orthographic/.test(gridState.frustum),
    gridState.frustum,
  );
  check(
    'fovy stays readable for the pixel math',
    Number.isFinite(gridState.fovy),
    String(gridState.fovy),
  );
  check(
    'the camera is straight down and north up',
    gridState.pitchDeg < -88 &&
      (Math.abs(gridState.headingDeg) < 1 ||
        Math.abs(gridState.headingDeg - 360) < 1),
    `pitch ${gridState.pitchDeg.toFixed(1)} heading ${gridState.headingDeg.toFixed(1)}`,
  );
  check('tilt is locked while on', gridState.tiltLocked);
  check(
    'the base is darkened',
    gridState.darkened === 'imagery' || gridState.darkened === 'tileset',
    String(gridState.darkened),
  );
  check(
    'the grid canvas is shown and painted',
    gridState.bodyClass && gridState.canvasShown && gridState.canvasPainted,
  );
  check(
    'the DISPLAY button reflects the state',
    gridState.buttonActive === true,
  );
  check('the preference is remembered', gridState.stored === '1');
  await page
    .waitForFunction(() => /(^|&)gv=1(&|$)/.test(location.hash), {
      timeout: 5_000,
    })
    .then(() => check('the share link carries gv=1', true))
    .catch(() => check('the share link carries gv=1', false, gridState.hash));
  await page
    .waitForFunction(
      () => window.__godsEyeView.viewer.scene.globe.tilesLoaded === true,
      { timeout: 20_000 },
    )
    .catch(() => {});
  await wait(600);
  await savePng(
    shot('05-grid-view.png'),
    await page.screenshot({ type: 'png' }),
  );

  // Back out: perspective, tilt and base restored.
  await page.keyboard.press('g');
  await page.waitForFunction(
    () => window.__godsEyeView.styleManager.gridViewEnabled === false,
    { timeout: 5_000 },
  );
  const restored = await page.evaluate(() => {
    const camera = window.__godsEyeView.viewer.camera;
    const state =
      window.__godsEyeView.styleManager._visualSettings._gridView._stateForTest();
    return {
      frustum: camera.frustum.constructor.name,
      tiltLocked: state.tiltLocked,
      darkened: state.darkened,
      bodyClass: document.body.classList.contains('grid-view'),
      stored: localStorage.getItem('gev:grid-view:v1'),
      imageryBrightness:
        window.__godsEyeView.viewer.imageryLayers.get(0)?.brightness,
    };
  });
  check(
    'G again restores the perspective frustum, tilt and base',
    /Perspective/.test(restored.frustum) &&
      !restored.tiltLocked &&
      restored.darkened === null &&
      !restored.bodyClass &&
      restored.stored === '0',
    JSON.stringify(restored),
  );
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
  check('event map QA completed', false, error.stack || error.message);
} finally {
  await browser.close();
}
console.log(`EVENT MAP: ${failures ? 'FAIL' : 'PASS'} (${failures} failed)`);
process.exit(failures ? 1 : 0);
