import { msg } from '../../i18n/marker.js';

/** Data-manager id of the event map layer. */
export const EVENTS_LAYER_ID = 'events';

/** Pick-id prefix every event billboard and cluster carries. */
export const EVENT_PICK_PREFIX = 'event:';

/** Pick id of a cluster billboard; the entities ride on the id object. */
export const EVENT_CLUSTER_PICK_PREFIX = 'event:cluster:';

/**
 * Every kind an adapter may publish. Icons, theme tokens and hover labels
 * are keyed by kind, so a source that needs a new kind adds it here and in
 * `src/ui/styles/events.css` (`--event-<kind>`), and the icon set.
 */
export const EVENT_KINDS = Object.freeze([
  'camera',
  'stream',
  'fire',
  'quake',
  'aircraft',
  'vessel',
  'incident',
  'alert',
]);

/** English kind labels, translated where they are shown. */
export const EVENT_KIND_LABELS = Object.freeze({
  camera: msg('Camera'),
  stream: msg('Live stream'),
  fire: msg('Active fire'),
  quake: msg('Earthquake'),
  aircraft: msg('Aircraft'),
  vessel: msg('Vessel'),
  incident: msg('Incident'),
  alert: msg('Alert'),
});

/** Events one adapter may contribute per refresh unless it asks for less. */
export const DEFAULT_ADAPTER_LIMIT = 400;

/** Events the layer keeps on the globe at once, nearest the camera first. */
export const EVENT_COHORT_LIMIT = 1500;

/** Screen-space cluster radius and the smallest group that collapses. */
export const CLUSTER_PIXEL_RANGE = 44;
export const CLUSTER_MIN_SIZE = 3;

/** Icon size on screen (CSS px); constant at every distance. */
export const ICON_SIZE_PX = 28;
export const CLUSTER_SIZE_PX = 36;

/** Ground events float this far above the cached floor so they never sink. */
export const ICON_LIFT_M = 4;

/** Icons shrink a little from far away but never below this scale. */
export const ICON_FAR_SCALE = 0.72;
export const ICON_NEAR_DISTANCE_M = 120_000;
export const ICON_FAR_DISTANCE_M = 8_000_000;

/** Hover picking: at most one scene.pick every throttle, never per frame. */
export const HOVER_PICK_THROTTLE_MS = 120;
/** The card lingers this long after the pointer leaves an icon. */
export const HOVER_RELEASE_MS = 220;

/** Data changes and camera stops are coalesced before a refresh. */
export const DATA_REFRESH_DEBOUNCE_MS = 400;
export const MOVE_END_DEBOUNCE_MS = 150;

/** The manager's periodic refresh; adapters without change events ride it. */
export const EVENTS_UPDATE_INTERVAL_MS = 60_000;

/** Observations older than this are shown as stale in the hover card. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Cameras the fire and quake feeds list as "nearest", and how far. */
export const NEAREST_CAMERA_LIMIT = 5;
export const NEAREST_CAMERA_MAX_KM = 60;
