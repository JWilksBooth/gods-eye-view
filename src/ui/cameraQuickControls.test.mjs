import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAMERA_QUICK_PANEL_ID,
  CameraQuickControls,
  QUICK_RERANK_MS,
  QUICK_STREAM_PROBE_DELAY_MS,
  QUICK_STREAM_PROBE_MEMORY_MS,
  QUICK_THUMB_IN_FLIGHT_MAX,
  QUICK_THUMB_TICK_MS,
} from './cameraQuickControls.js';
import { liveOpsRegion } from '../data/liveOpsRegions.js';
import { createFakeDocument, createFakeTimers } from '../testSupport/panelDom.mjs';

const DOWNTOWN_LA = { lat: 34.0537, lon: -118.2428 };

const CATALOG = [
  { id: 'far', name: 'SR-14 at Agua Dulce', city: 'Los Angeles', provider: 'Caltrans', lat: 34.5, lon: -118.3, feedType: 'image', isVideo: false },
  { id: 'live', name: 'US-101 at Alameda', city: 'Los Angeles', provider: 'Caltrans', lat: 34.06, lon: -118.25, feedType: 'hls', isVideo: true },
  { id: 'near', name: 'I-110 at 6th', city: 'Los Angeles', provider: 'Caltrans', lat: 34.05, lon: -118.24, feedType: 'image', isVideo: false },
  { id: 'mid', name: 'Hwy 101 at Vermont', city: 'Los Angeles', provider: 'Caltrans', lat: 34.1, lon: -118.3, feedType: 'image', isVideo: false },
  { id: 'vegas', name: 'Las Vegas Blvd at Flamingo', city: 'Las Vegas', provider: 'RTC of Southern Nevada FAST', lat: 36.1, lon: -115.17, feedType: 'image', isVideo: false },
];

function panelDom(document) {
  const root = document.createElement('section');
  root.id = CAMERA_QUICK_PANEL_ID;
  root.classList.add('panel-collapsible');
  const body = document.createElement('div');
  root.appendChild(body);
  const make = (tag, id, extra = {}) => {
    const node = document.createElement(tag);
    node.id = id;
    Object.assign(node, extra);
    body.appendChild(node);
    return node;
  };
  make('input', 'camera-quick-search');
  const newest = make('button', 'camera-quick-order-newest');
  newest.dataset.quickOrder = 'newest';
  const nearest = make('button', 'camera-quick-order-nearest');
  nearest.dataset.quickOrder = 'nearest';
  make('button', 'camera-quick-region', { hidden: true });
  make('button', 'camera-quick-enable', { hidden: true });
  make('button', 'camera-quick-wall', { disabled: true });
  make('div', 'camera-quick-status');
  make('ul', 'camera-quick-list');
  document.body.appendChild(root);
  return root;
}

function harness({
  enabled = true,
  catalog = CATALOG,
  collapsed = false,
  center = DOWNTOWN_LA,
  streamHealth = null,
} = {}) {
  const document = createFakeDocument();
  const timers = createFakeTimers();
  const root = panelDom(document);
  if (collapsed) root.classList.add('collapsed');
  const calls = { opened: [], enabled: 0, collapsed: [], wall: [], probed: [], unsubscribed: 0 };
  let cctvListener = null;
  let settled = null;
  let layerEnabled = enabled;
  let health = streamHealth;
  const cctv = {
    subscribe(listener) {
      cctvListener = listener;
      listener({ enabled: layerEnabled, count: catalog.length, activeCameraId: null });
      return () => {
        calls.unsubscribed += 1;
      };
    },
    getCameraCatalog: () => catalog,
    getStreamHealth: () => health,
    probeStreams: async (ids) => {
      calls.probed.push(ids);
      return { probed: ids.length, streams: {} };
    },
    getFrameUrl: (camera, refreshMs) => `/api/cctv/frame/${camera.id}?r=${refreshMs}`,
  };
  const controls = new CameraQuickControls({
    root,
    cctv,
    document,
    timers,
    now: timers.now,
    actions: {
      isEnabled: () => layerEnabled,
      enableLayer: () => {
        calls.enabled += 1;
        layerEnabled = true;
        cctvListener?.({ enabled: true, count: catalog.length, activeCameraId: null });
      },
      openCamera: async (cameraId) => {
        calls.opened.push(cameraId);
        return true;
      },
      readViewCenter: () => center,
      subscribeViewSettled: (listener) => {
        settled = listener;
        return () => {};
      },
      setPanelCollapsed: (panelId, value, options) => {
        calls.collapsed.push([panelId, value, options?.explicit]);
        root.classList.toggle('collapsed', value);
        controls.onDisclosure(value, options);
      },
      openWall: (options) => calls.wall.push(options),
    },
  });
  controls.connect();
  const byId = (id) => root.querySelector(`#${id}`);
  return {
    controls,
    calls,
    byId,
    document,
    timers,
    root,
    rows: () => byId('camera-quick-list').children,
    rowIds: () => byId('camera-quick-list').children.map((row) => row.dataset.cameraId),
    notify: (state) => cctvListener?.(state),
    settle: () => settled?.(),
    search: () => byId('camera-quick-search'),
    setHealth: (next) => {
      health = next;
    },
    badge: (id) => byId('camera-quick-list').children.find((row) => row.dataset.cameraId === id).children[0].children[1],
  };
}

test('an expanded panel lists the nearest cameras with name, distance and badge, newest first', () => {
  const h = harness();
  // Everything is "near" to a 24-row list; Las Vegas simply comes last.
  assert.deepEqual(h.rowIds(), ['live', 'near', 'mid', 'far', 'vegas']);
  const [live, near] = h.rows();
  assert.equal(live.getAttribute('role'), 'option');
  assert.equal(live.dataset.live, 'true');
  // Nobody has checked the stream yet: live by the catalog, not proven.
  assert.equal(live.dataset.stream, 'unknown');
  assert.equal(live.children[0].children[1].textContent, 'LIVE?');
  assert.equal(near.children[0].children[1].textContent, 'STILL');
  assert.equal(near.dataset.stream, 'none');
  assert.equal(near.children[1].children[0].textContent, 'I-110 at 6th');
  assert.match(near.children[1].children[1].textContent, /^Los Angeles · \d+ m$/);
  assert.match(live.children[1].children[1].textContent, /km$/);
  assert.equal(h.byId('camera-quick-status').textContent, '5 cameras');
  assert.equal(h.byId('camera-quick-wall').disabled, false);
  assert.equal(h.byId('camera-quick-enable').hidden, true);
  h.controls.destroy();
});

test('thumbnails are paced: two in flight, the next starts as one lands, on the frame cadence', () => {
  const h = harness();
  const srcs = () => h.rows().map((row) => row.children[0].children[0].src);
  assert.equal(srcs().filter(Boolean).length, QUICK_THUMB_IN_FLIGHT_MAX);
  assert.match(srcs()[0], /\/api\/cctv\/frame\/live\?r=30000$/);
  assert.match(srcs()[1], /\/api\/cctv\/frame\/near\?r=180000$/);
  h.rows()[0].children[0].children[0].dispatch('load');
  assert.equal(srcs().filter(Boolean).length, 3);
  assert.equal(h.rows()[0].children[0].children[0].dataset.ready, 'true');
  h.rows()[1].children[0].children[0].dispatch('error');
  assert.equal(srcs().filter(Boolean).length, 4);
  // Nothing re-requests before the cadence: a tick finds every row fresh or pending.
  h.rows()[2].children[0].children[0].dispatch('load');
  h.rows()[3].children[0].children[0].dispatch('load');
  h.rows()[4].children[0].children[0].dispatch('load');
  const before = srcs();
  h.timers.advance(QUICK_THUMB_TICK_MS * 3);
  assert.deepEqual(srcs(), before);
  h.controls.destroy();
});

test('typing narrows the list; Enter opens the first match; Escape clears, then leaves closing to the chrome', async () => {
  const h = harness();
  const search = h.search();
  search.value = '101';
  search.dispatch('input');
  assert.deepEqual(h.rowIds(), ['live', 'mid']);
  assert.equal(h.byId('camera-quick-status').textContent, '“101” · 2 cameras');
  const enter = search.dispatch('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  await Promise.resolve();
  assert.deepEqual(h.calls.opened, ['live']);
  const clear = search.dispatch('keydown', { key: 'Escape' });
  assert.equal(clear.defaultPrevented, true);
  assert.equal(clear.propagationStopped, true);
  assert.equal(search.value, '');
  assert.equal(h.rows().length, 5);
  const close = search.dispatch('keydown', { key: 'Escape' });
  assert.equal(close.defaultPrevented, false);
  search.value = 'golden gate';
  search.dispatch('input');
  assert.equal(h.rows().length, 0);
  assert.equal(h.byId('camera-quick-status').textContent, 'No cameras match');
  h.controls.destroy();
});

test('arrow keys move the highlight and Enter opens it; a click opens a row', async () => {
  const h = harness();
  const search = h.search();
  search.dispatch('keydown', { key: 'ArrowDown' });
  search.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(h.rows()[1].getAttribute('aria-selected'), 'true');
  assert.equal(h.rows()[0].getAttribute('aria-selected'), 'false');
  assert.equal(search.getAttribute('aria-activedescendant'), h.rows()[1].id);
  search.dispatch('keydown', { key: 'Enter' });
  await Promise.resolve();
  assert.deepEqual(h.calls.opened, ['near']);
  h.rows()[3].click();
  await Promise.resolve();
  assert.deepEqual(h.calls.opened, ['near', 'far']);
  assert.equal(h.rows()[3].getAttribute('aria-selected'), 'true');
  h.controls.destroy();
});

test('the LIVE OPS region expands the panel, limits the rows to the region and shows a chip to clear it', () => {
  const h = harness();
  h.controls.showRegion(liveOpsRegion('las-vegas'));
  assert.deepEqual(h.calls.collapsed, [[CAMERA_QUICK_PANEL_ID, false, true]]);
  assert.deepEqual(h.rowIds(), ['vegas']);
  const chip = h.byId('camera-quick-region');
  assert.equal(chip.hidden, false);
  assert.equal(chip.textContent, 'Las Vegas ×');
  assert.equal(h.byId('camera-quick-status').textContent, 'Las Vegas · 1 camera');
  chip.click();
  assert.equal(chip.hidden, true);
  assert.equal(h.rows().length, 5);
  h.controls.destroy();
});

test('nearest order follows distance; newest re-sorts on the cadence once frames land', () => {
  const h = harness();
  h.byId('camera-quick-order-nearest').click();
  assert.deepEqual(h.rowIds(), ['near', 'live', 'mid', 'far', 'vegas']);
  h.byId('camera-quick-order-newest').click();
  assert.deepEqual(h.rowIds(), ['live', 'near', 'mid', 'far', 'vegas']);
  // The 'mid' still lands a frame; 'near' has none yet: after the re-rank tick
  // the fresher still moves ahead, the live feed stays first.
  const midImg = h.rows()[2].children[0].children[0];
  h.rows()[0].children[0].children[0].dispatch('error');
  h.rows()[1].children[0].children[0].dispatch('error');
  midImg.dispatch('load');
  h.timers.advance(QUICK_RERANK_MS);
  assert.deepEqual(h.rowIds(), ['live', 'mid', 'near', 'far', 'vegas']);
  h.controls.destroy();
});

test('a collapsed panel defers its work; an explicit expand with the layer off turns it on', () => {
  const h = harness({ enabled: false, catalog: [], collapsed: true });
  assert.equal(h.rows().length, 0);
  assert.equal(h.timers.count, 0);
  h.root.classList.remove('collapsed');
  h.controls.onDisclosure(false, { explicit: false });
  assert.equal(h.calls.enabled, 0);
  assert.equal(h.byId('camera-quick-status').textContent, 'Cameras are off');
  assert.equal(h.byId('camera-quick-enable').hidden, false);
  h.controls.onDisclosure(false, { explicit: true });
  assert.equal(h.calls.enabled, 1);
  assert.ok(h.timers.count > 0);
  h.controls.onDisclosure(true);
  assert.equal(h.timers.count, 0);
  h.controls.destroy();
});

test('the view settling re-centres the list, and the wall gets the current rows', () => {
  let center = DOWNTOWN_LA;
  const h = harness({ center });
  h.byId('camera-quick-order-nearest').click();
  assert.equal(h.rowIds()[0], 'near');
  h.controls.actions.readViewCenter = () => ({ lat: 36.1, lon: -115.17 });
  h.settle();
  assert.equal(h.rowIds()[0], 'vegas');
  h.byId('camera-quick-wall').click();
  assert.equal(h.calls.wall.length, 1);
  assert.equal(h.calls.wall[0].entries[0].camera.id, 'vegas');
  assert.equal(h.calls.wall[0].label, 'Nearest cameras');
  h.controls.destroy();
  assert.equal(h.calls.unsubscribed, 1);
});

test('the active camera is marked on its row as the layer reports it', () => {
  const h = harness();
  h.notify({ enabled: true, count: CATALOG.length, activeCameraId: 'mid' });
  const marks = Object.fromEntries(h.rows().map((row) => [row.dataset.cameraId, row.dataset.active]));
  assert.equal(marks.mid, 'true');
  assert.equal(marks.live, 'false');
  h.controls.destroy();
});

test('the LIVE badge means the stream answered: unchecked streams read LIVE?, failed ones STREAM DOWN, and the order follows', () => {
  const h = harness();
  assert.equal(h.badge('live').textContent, 'LIVE?');
  assert.equal(h.badge('near').textContent, 'STILL');
  const now = h.timers.now();
  const state = { enabled: true, count: CATALOG.length, activeCameraId: null };
  h.setHealth(new Map([['live', { ok: now - 5_000, fail: 0 }]]));
  h.notify(state);
  assert.equal(h.badge('live').textContent, 'LIVE');
  assert.equal(h.badge('live').dataset.stream, 'ok');
  assert.equal(h.rowIds()[0], 'live');
  h.setHealth(new Map([['live', { ok: now - 5_000, fail: now - 1_000 }]]));
  h.notify(state);
  assert.equal(h.badge('live').textContent, 'STREAM DOWN');
  assert.equal(h.badge('live').dataset.stream, 'down');
  const row = h.rows().find((node) => node.dataset.cameraId === 'live');
  assert.equal(row.dataset.live, 'false');
  assert.equal(row.dataset.stream, 'down');
  // A down stream is a still for now: it takes its place by distance.
  assert.deepEqual(h.rowIds(), ['near', 'live', 'mid', 'far', 'vegas']);
  h.notify(state);
  assert.deepEqual(h.rowIds(), ['near', 'live', 'mid', 'far', 'vegas']);
  h.controls.destroy();
});

test('unchecked streams in the list go to the proxy for one probe, a moment after the list settles', async () => {
  const h = harness();
  assert.deepEqual(h.calls.probed, []);
  h.timers.advance(QUICK_STREAM_PROBE_DELAY_MS - 1);
  assert.deepEqual(h.calls.probed, []);
  h.timers.advance(1);
  assert.deepEqual(h.calls.probed, [['live']]);
  await new Promise((resolve) => setImmediate(resolve));
  // Re-listing the same camera asks nothing more.
  h.search().value = '101';
  h.search().dispatch('input');
  h.timers.advance(QUICK_STREAM_PROBE_DELAY_MS);
  assert.deepEqual(h.calls.probed, [['live']]);
  // Once the memory lapses and the camera is still unchecked, it is asked about again.
  h.timers.advance(QUICK_STREAM_PROBE_MEMORY_MS);
  h.search().value = '';
  h.search().dispatch('input');
  h.timers.advance(QUICK_STREAM_PROBE_DELAY_MS);
  assert.deepEqual(h.calls.probed, [['live'], ['live']]);
  await new Promise((resolve) => setImmediate(resolve));
  // A verdict, whichever way, ends the asking.
  h.setHealth(new Map([['live', { ok: 0, fail: h.timers.now() }]]));
  h.notify({ enabled: true, count: CATALOG.length, activeCameraId: null });
  h.timers.advance(QUICK_STREAM_PROBE_MEMORY_MS + QUICK_STREAM_PROBE_DELAY_MS);
  assert.equal(h.calls.probed.length, 2);
  h.controls.destroy();
});
