import test from 'node:test';
import assert from 'node:assert/strict';
import { ShareLinkManager } from './sharelink.js';
import {
  fromLegacyShareState,
  toLegacyShareState,
} from './share/legacyShareState.js';
import {
  SHARE_VIEW_FLAGS,
  decodeShareView,
  encodeShareView,
} from './share/viewCodec.js';

function makeManager(hash = '') {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = {
    replaceState(_state, _title, next) {
      window.location.hash = new URL(next, window.location.href).hash;
    },
  };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer);
}

test('the long form carries gv only while the grid view is on, and parses its absence as off', () => {
  const manager = makeManager();
  assert.equal(
    manager._buildHashParams().has('gv'),
    false,
    'a fresh session writes no gv',
  );
  manager.onToggleChange(false, true, { gridView: true });
  assert.equal(manager._buildHashParams().get('gv'), '1');
  manager.onToggleChange(false, true, { gridView: false });
  assert.equal(manager._buildHashParams().has('gv'), false);
  clearTimeout(manager._debounceTimer);
  manager.destroy();

  assert.equal(
    makeManager('#v=2&lat=10&lon=20&gv=1').parseInitialHash().gridView,
    true,
  );
  assert.equal(
    makeManager('#v=2&lat=10&lon=20&gv=0').parseInitialHash().gridView,
    false,
  );
  assert.equal(
    makeManager('#v=2&lat=10&lon=20').parseInitialHash().gridView,
    false,
  );
});

test('applyState hands gridView to the visual restore', async () => {
  const manager = makeManager('#v=2&lat=10&lon=20&gv=1');
  const restored = [];
  manager._onRestore = async (state) => restored.push(state);
  const parsed = manager.parseInitialHash();
  await manager.applyState(parsed, { applyCamera: false });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].gridView, true);
  clearTimeout(manager._debounceTimer);
  manager.destroy();
});

test('the compact form stores the grid view as flag bit 5 and older payloads decode as off', () => {
  const flag = SHARE_VIEW_FLAGS.find((entry) => entry.key === 'gridView');
  assert.deepEqual(flag, { bit: 5, key: 'gridView', default: false });
  const parsed = makeManager('#v=2&lat=10&lon=20&gv=1').parseInitialHash();
  const view = fromLegacyShareState(parsed);
  assert.equal(view.gridView, true);
  const code = encodeShareView(view);
  const decoded = decodeShareView(code);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.state.gridView, true);
  assert.equal(toLegacyShareState(decoded.state).gridView, true);
  const off = decodeShareView(
    encodeShareView(
      fromLegacyShareState(
        makeManager('#v=2&lat=10&lon=20').parseInitialHash(),
      ),
    ),
  );
  assert.equal(off.state.gridView, false);
  assert.equal(
    decodeShareView('AQc').state.gridView,
    false,
    'the all-default view is off',
  );
});
