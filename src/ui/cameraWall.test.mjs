import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAMERA_WALL_ID,
  WALL_HOVER_DELAY_MS,
  WALL_HOVER_GRACE_MS,
  WALL_REFUSED_MS,
  createCameraWall,
} from './cameraWall.js';
import { createFakeDocument, createFakeTimers } from '../testSupport/panelDom.mjs';

const entry = (id, live, km = 1) => ({
  camera: {
    id,
    name: `Camera ${id}`,
    city: 'Los Angeles',
    provider: 'Caltrans',
    lat: 34,
    lon: -118,
    feedType: live ? 'hls' : 'image',
    isVideo: live,
  },
  distanceKm: km,
  live,
  frameStamp: 0,
});

const ENTRIES = [
  entry('a', true, 0.3),
  entry('b', true, 0.8),
  entry('c', true, 1.2),
  entry('d', false, 2),
  entry('e', true, 3),
];

function harness({ layerState = { enabled: true, activeCamera: null, activeCameraId: null }, limit = 2 } = {}) {
  const document = createFakeDocument();
  const timers = createFakeTimers();
  const players = [];
  let cctvListener = null;
  const cctv = {
    getUIState: () => layerState,
    subscribe(listener) {
      cctvListener = listener;
      return () => {
        cctvListener = null;
      };
    },
    getFrameUrl: (camera, refreshMs) => `/api/cctv/frame/${camera.id}?r=${refreshMs}`,
    getMediaUrl: (camera) => `/api/cctv/media/${camera.id}?ts=1`,
  };
  const opened = [];
  const wall = createCameraWall({
    documentRef: document,
    cctv,
    timers,
    now: timers.now,
    limit,
    actions: { openOnGlobe: (id) => opened.push(id) },
    attachVideo: (video, url, feedType, { onFailure }) => {
      const player = { video, url, feedType, disposed: 0, onFailure, dispose() { this.disposed += 1; } };
      players.push(player);
      return player;
    },
  });
  const tiles = () => wall.dialog.querySelectorAll('figure');
  const tile = (id) => tiles().find((figure) => figure.dataset.cameraId === id);
  // The wall's own view: a failed playback disposes itself before calling
  // back, so the fake player's dispose count says nothing about that case.
  const playing = () => wall.readState().playing;
  return { wall, document, timers, players, opened, tiles, tile, playing, notify: (state) => cctvListener?.(state) };
}

test('opening shows the requested number of tiles as snapshots, with names, badges and the hint', () => {
  const h = harness();
  h.wall.open({ entries: ENTRIES, label: 'Los Angeles', size: 4 });
  assert.equal(h.wall.isOpen, true);
  assert.equal(h.wall.dialog.id, CAMERA_WALL_ID);
  assert.equal(h.wall.dialog.getAttribute('data-panel-surface'), '');
  assert.deepEqual(h.tiles().map((figure) => figure.dataset.cameraId), ['a', 'b', 'c', 'd']);
  assert.equal(
    h.wall.dialog.querySelector('.camera-wall-grid').style.properties.get('--camera-wall-columns'),
    '2',
  );
  const [a, , , d] = h.tiles().map((figure) => figure.querySelector('.camera-wall-badge'));
  assert.equal(a.textContent, 'LIVE');
  assert.equal(d.textContent, 'STILL');
  assert.equal(h.tile('a').querySelector('.camera-wall-name').textContent, 'Camera a');
  assert.match(h.wall.dialog.querySelector('.camera-wall-hint').textContent, /2 live feeds at a time$/);
  // Snapshots: two in flight at once, the rest as they land.
  const stills = () => h.tiles().map((figure) => figure.querySelector('img').src);
  assert.equal(stills().filter(Boolean).length, 2);
  h.tile('a').querySelector('img').dispatch('load');
  assert.equal(stills().filter(Boolean).length, 3);
  assert.equal(h.players.length, 0);
  h.wall.close();
  assert.equal(h.wall.isOpen, false);
});

test('a hovered live tile plays after the delay and stops after the grace; a still never does', () => {
  const h = harness();
  h.wall.open({ entries: ENTRIES, size: 6 });
  h.tile('a').dispatch('pointerenter', { pointerType: 'mouse' });
  assert.deepEqual(h.playing(), []);
  h.timers.advance(WALL_HOVER_DELAY_MS);
  assert.deepEqual(h.playing(), ['a']);
  assert.equal(h.players[0].url, '/api/cctv/media/a?ts=1');
  assert.equal(h.players[0].feedType, 'hls');
  assert.equal(h.tile('a').dataset.video, 'true');
  assert.equal(h.tile('a').querySelector('video').hidden, false);
  h.tile('a').dispatch('pointerleave');
  h.timers.advance(WALL_HOVER_GRACE_MS - 1);
  assert.deepEqual(h.playing(), ['a']);
  h.timers.advance(1);
  assert.deepEqual(h.playing(), []);
  assert.equal(h.tile('a').querySelector('video').hidden, true);
  h.tile('d').dispatch('pointerenter', { pointerType: 'mouse' });
  h.timers.advance(WALL_HOVER_DELAY_MS * 2);
  assert.deepEqual(h.playing(), []);
  h.wall.close();
});

test('clicks pin tiles within the proxy budget; the oldest pin gives way and a hover never evicts one', () => {
  const h = harness();
  h.wall.open({ entries: ENTRIES, size: 9 });
  h.tile('a').click();
  h.tile('b').click();
  assert.deepEqual(h.playing().sort(), ['a', 'b']);
  assert.equal(h.tile('a').querySelector('.camera-wall-badge').textContent, 'LIVE · PINNED');
  h.tile('c').dispatch('pointerenter', { pointerType: 'mouse' });
  h.timers.advance(WALL_HOVER_DELAY_MS);
  assert.deepEqual(h.playing().sort(), ['a', 'b']);
  assert.equal(h.tile('c').querySelector('.camera-wall-badge').textContent, 'LIVE SLOTS FULL');
  h.tile('c').dispatch('pointerleave');
  h.timers.advance(WALL_HOVER_GRACE_MS);
  h.tile('c').click();
  assert.deepEqual(h.playing().sort(), ['b', 'c']);
  assert.deepEqual(h.wall.readState().pinned, ['b', 'c']);
  assert.equal(h.tile('a').dataset.pinned, 'false');
  h.tile('b').click();
  assert.deepEqual(h.playing(), ['c']);
  h.wall.close();
  assert.ok(h.players.every((player) => player.disposed === 1));
});

test('the layer’s own live camera holds a slot unless the wall shows it too', () => {
  const held = harness({
    layerState: { enabled: true, activeCameraId: 'z', activeCamera: { id: 'z', isVideo: true } },
  });
  held.wall.open({ entries: ENTRIES, size: 4 });
  assert.match(held.wall.dialog.querySelector('.camera-wall-hint').textContent, /1 live feed at a time$/);
  held.tile('a').click();
  held.tile('b').click();
  assert.deepEqual(held.playing(), ['b']);
  // The layer moves to a camera on the wall: the shared session frees a slot.
  held.notify({ enabled: true, activeCameraId: 'b', activeCamera: { id: 'b', isVideo: true } });
  assert.match(held.wall.dialog.querySelector('.camera-wall-hint').textContent, /2 live feeds at a time$/);
  held.tile('a').click();
  assert.deepEqual(held.playing().sort(), ['a', 'b']);
  held.wall.close();
});

test('a refused stream falls back to the still and is not asked again for a while', () => {
  const h = harness();
  h.wall.open({ entries: ENTRIES, size: 4 });
  h.tile('a').click();
  assert.deepEqual(h.playing(), ['a']);
  h.players[0].onFailure();
  assert.deepEqual(h.playing(), []);
  assert.equal(h.tile('a').querySelector('.camera-wall-badge').textContent, 'LIVE UNAVAILABLE');
  h.tile('a').click();
  assert.deepEqual(h.playing(), []);
  h.timers.advance(WALL_REFUSED_MS);
  h.tile('a').click();
  assert.deepEqual(h.playing(), ['a']);
  h.wall.close();
});

test('OPEN ON GLOBE hands the camera to the globe and closes; Escape and GLOBE close too', () => {
  const h = harness();
  h.wall.open({ entries: ENTRIES, size: 4 });
  h.tile('b').click();
  h.tile('b').querySelector('.camera-wall-open').click();
  assert.deepEqual(h.opened, ['b']);
  assert.equal(h.wall.isOpen, false);
  assert.ok(h.players.every((player) => player.disposed === 1));
  h.wall.open({ entries: ENTRIES, size: 4 });
  h.wall.dialog.dispatch('cancel');
  assert.equal(h.wall.isOpen, false);
  h.wall.open({ entries: ENTRIES, size: 4 });
  h.wall.dialog.querySelector('.camera-wall-globe').click();
  assert.equal(h.wall.isOpen, false);
  h.wall.destroy();
  assert.equal(h.wall.dialog, null);
});

test('changing the size re-renders the tiles and drops players for tiles that leave', () => {
  const h = harness();
  h.wall.open({ entries: ENTRIES, size: 9 });
  assert.equal(h.tiles().length, 5);
  h.tile('e').click();
  assert.deepEqual(h.playing(), ['e']);
  h.wall.dialog.querySelectorAll('.camera-wall-size')[0].click();
  assert.equal(h.tiles().length, 4);
  assert.equal(h.wall.size, 4);
  assert.deepEqual(h.playing(), []);
  h.wall.close();
});
