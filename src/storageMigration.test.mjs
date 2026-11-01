import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STORAGE_PREFIX,
  migrateBrowserStorage,
  migrateLegacyStorage,
} from './storageMigration.js';

const LEGACY = ['gods', 'EyeView.'].join('');

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    entries: () => Object.fromEntries(map),
  };
}

test('legacy keys move to the Osiris prefix and the old keys go away', () => {
  const storage = memoryStorage({
    [`${LEGACY}sceneProject.v2`]: '{"scenes":[]}',
    [`${LEGACY}v6.panelCollapsed.cctv-panel`]: '0',
    [`${LEGACY}voice.cloudAuth`]: 'oauth',
    unrelated: 'kept',
  });
  assert.equal(migrateLegacyStorage(storage), 3);
  assert.deepEqual(storage.entries(), {
    [`${STORAGE_PREFIX}sceneProject.v2`]: '{"scenes":[]}',
    [`${STORAGE_PREFIX}v6.panelCollapsed.cctv-panel`]: '0',
    [`${STORAGE_PREFIX}voice.cloudAuth`]: 'oauth',
    unrelated: 'kept',
  });
});

test('a value the renamed app already saved is not overwritten', () => {
  const storage = memoryStorage({
    [`${LEGACY}voiceCost.tier`]: 'standard',
    [`${STORAGE_PREFIX}voiceCost.tier`]: 'mini',
  });
  assert.equal(migrateLegacyStorage(storage), 0);
  assert.deepEqual(storage.entries(), {
    [`${STORAGE_PREFIX}voiceCost.tier`]: 'mini',
  });
});

test('a second run finds nothing to move', () => {
  const storage = memoryStorage({ [`${LEGACY}cctv.calibration.v2`]: '{}' });
  assert.equal(migrateLegacyStorage(storage), 1);
  assert.equal(migrateLegacyStorage(storage), 0);
});

test('missing or throwing storage leaves everything as it was', () => {
  assert.equal(migrateLegacyStorage(null), 0);
  assert.equal(migrateLegacyStorage(undefined), 0);
  const broken = {
    get length() {
      throw new Error('blocked');
    },
  };
  assert.equal(migrateLegacyStorage(broken), 0);
  const scope = {
    get localStorage() {
      throw new Error('blocked');
    },
    sessionStorage: memoryStorage({ [`${LEGACY}x`]: '1' }),
  };
  assert.equal(migrateBrowserStorage(scope), 1);
});
