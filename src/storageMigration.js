/**
 * Browser storage written before the project became Osiris used keys under
 * the previous product name. The app now writes `osiris.<feature>.<field>`.
 * Each old key is moved to its new name once, so saved panel layouts, Director
 * scenes, camera calibrations and voice preferences survive the rename, and
 * the old key is removed. Run before anything reads storage.
 *
 * This is the one place in the code that still spells the old prefix; it can
 * go once a release has passed.
 */

// i18n-ignore: storage keys
const LEGACY_PREFIX = 'godsEyeView.';
export const STORAGE_PREFIX = 'osiris.';

/**
 * Move every legacy key in `storage` to its Osiris name. A key that already
 * exists under the new name wins, so a setting saved by the renamed app is
 * never overwritten by a stale one. Returns how many keys were moved.
 * Storage that is missing or throws (private windows, blocked site data)
 * leaves nothing changed.
 * @param {Storage | null | undefined} storage
 * @returns {number}
 */
export function migrateLegacyStorage(storage) {
  if (!storage) return 0;
  let moved = 0;
  try {
    const legacyKeys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === 'string' && key.startsWith(LEGACY_PREFIX))
        legacyKeys.push(key);
    }
    for (const key of legacyKeys) {
      const renamed = STORAGE_PREFIX + key.slice(LEGACY_PREFIX.length);
      if (storage.getItem(renamed) === null) {
        storage.setItem(renamed, storage.getItem(key));
        moved += 1;
      }
      storage.removeItem(key);
    }
  } catch {
    // Storage unavailable: the app runs with defaults, as it would without it.
  }
  return moved;
}

/** Migrate the page's local and session storage. */
export function migrateBrowserStorage(scope = globalThis) {
  let moved = 0;
  for (const name of ['localStorage', 'sessionStorage']) {
    let storage = null;
    try {
      storage = scope[name];
    } catch {
      storage = null;
    }
    moved += migrateLegacyStorage(storage);
  }
  return moved;
}
