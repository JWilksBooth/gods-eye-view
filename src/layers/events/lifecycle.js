import { greatCircleKm } from '../../geoDistance.js';
import { msg } from '../../i18n/marker.js';
import { listEventAdapters, subscribeEventAdapters } from './adapters.js';
import { createEventIconCache, readEventTheme } from './icons.js';
import {
  describeEvent,
  nearestEvents,
  normalizeEvent,
  parseEventPickId,
  rankEvents,
} from './model.js';
import {
  DATA_REFRESH_DEBOUNCE_MS,
  DEFAULT_ADAPTER_LIMIT,
  EVENT_COHORT_LIMIT,
  EVENTS_LAYER_ID,
  EVENTS_UPDATE_INTERVAL_MS,
  MOVE_END_DEBOUNCE_MS,
  NEAREST_CAMERA_LIMIT,
  NEAREST_CAMERA_MAX_KM,
} from './policy.js';

/** The data-manager module: lifecycle, refresh scheduling and public queries. */
export function createLifecycle({ state, services, parts }) {
  const { readCameraCenter } = services.camera;

  function notifyListeners() {
    const snapshot = uiState();
    for (const listener of state._listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[Events] listener error:', error);
      }
    }
  }

  function uiState() {
    return {
      enabled: state._enabled,
      count: state._count,
      lastUpdate: state._lastUpdate,
      error: state._lastError,
      byAdapter: Object.fromEntries(state._countsByAdapter),
      adapterErrors: Object.fromEntries(state._adapterErrors),
      hoverKey: state._hoverKey,
    };
  }

  function adapterIsReadable(adapter) {
    if (!adapter.layerId) return true;
    const manager = state._dataManager;
    if (!manager?.isEnabled) return true;
    return manager.isEnabled(adapter.layerId);
  }

  /** Read every readable adapter once; a failing adapter contributes nothing. */
  function collect() {
    const center = readCameraCenter(state._viewer);
    const now = Date.now();
    const events = [];
    state._countsByAdapter.clear();
    state._adapterErrors.clear();
    for (const adapter of listEventAdapters()) {
      if (!adapterIsReadable(adapter)) continue;
      let rows;
      try {
        rows = adapter.getEvents({ limit: DEFAULT_ADAPTER_LIMIT, center, now });
      } catch (error) {
        state._adapterErrors.set(adapter.id, String(error?.message || error));
        continue;
      }
      if (!Array.isArray(rows)) continue;
      let contributed = 0;
      for (const raw of rows.slice(0, DEFAULT_ADAPTER_LIMIT)) {
        const event = normalizeEvent(raw, adapter);
        if (!event) continue;
        events.push(event);
        contributed += 1;
      }
      state._countsByAdapter.set(adapter.id, contributed);
    }
    return rankEvents(events, { center, limit: EVENT_COHORT_LIMIT });
  }

  /** One refresh: read adapters, reconcile the globe, cull the horizon. */
  function refreshNow() {
    if (!state._enabled || !state._viewer || state._viewer.isDestroyed?.()) return;
    const generation = ++state._refreshGeneration;
    let events;
    try {
      events = collect();
      state._lastError = null;
    } catch (error) {
      state._lastError = String(error?.message || error);
      console.warn('[Events] refresh error:', error);
      return;
    }
    if (generation !== state._refreshGeneration) return;
    parts.rendering.reconcile(events);
    parts.rendering.applyHorizon({ force: true });
    state._count = events.length;
    state._lastUpdate = Date.now();
    if (state._hoverKey && !state._eventById.has(state._hoverKey))
      parts.interaction.clearHover();
    notifyListeners();
  }

  function scheduleRefresh(delayMs = DATA_REFRESH_DEBOUNCE_MS) {
    if (!state._enabled) return;
    if (state._refreshTimer) clearTimeout(state._refreshTimer);
    state._refreshTimer = setTimeout(() => {
      state._refreshTimer = 0;
      refreshNow();
    }, delayMs);
  }

  function cancelTimers() {
    if (state._refreshTimer) clearTimeout(state._refreshTimer);
    if (state._moveTimer) clearTimeout(state._moveTimer);
    state._refreshTimer = 0;
    state._moveTimer = 0;
  }

  function watchedLayerIds() {
    return new Set(
      listEventAdapters()
        .map((adapter) => adapter.layerId)
        .filter(Boolean),
    );
  }

  function subscribeSources() {
    unsubscribeSources();
    const manager = state._dataManager;
    if (manager?.subscribeActivity) {
      state._unsubscribes.push(
        manager.subscribeActivity((change) => {
          if (!state._enabled) return;
          if (change.type === 'data-updated' && watchedLayerIds().has(change.layerId))
            scheduleRefresh();
          else if (change.type === 'visibility-settled') scheduleRefresh();
        }),
      );
    }
    state._unsubscribes.push(
      subscribeEventAdapters(() => {
        syncAdapterSubscriptions();
        scheduleRefresh(0);
      }),
    );
    syncAdapterSubscriptions();
  }

  function syncAdapterSubscriptions() {
    const live = new Set();
    for (const adapter of listEventAdapters()) {
      live.add(adapter.id);
      if (typeof adapter.subscribe !== 'function') continue;
      if (state._adapterUnsubscribes.has(adapter.id)) continue;
      try {
        const unsubscribe = adapter.subscribe(() => scheduleRefresh());
        state._adapterUnsubscribes.set(
          adapter.id,
          typeof unsubscribe === 'function' ? unsubscribe : () => {},
        );
      } catch (error) {
        console.warn(`[Events] ${adapter.id} subscribe error:`, error);
      }
    }
    for (const [id, unsubscribe] of [...state._adapterUnsubscribes]) {
      if (live.has(id)) continue;
      unsubscribe();
      state._adapterUnsubscribes.delete(id);
    }
  }

  function unsubscribeSources() {
    for (const unsubscribe of state._unsubscribes.splice(0)) unsubscribe();
    for (const unsubscribe of state._adapterUnsubscribes.values()) unsubscribe();
    state._adapterUnsubscribes.clear();
  }

  function watchCamera() {
    const camera = state._viewer?.camera;
    if (!camera || state._removeMoveEnd) return;
    state._removeMoveStart = camera.moveStart.addEventListener(() => {
      state._cameraMoving = true;
      if (state._hoverKey) parts.interaction.clearHover();
    });
    state._removeMoveEnd = camera.moveEnd.addEventListener(() => {
      state._cameraMoving = false;
      if (state._moveTimer) clearTimeout(state._moveTimer);
      state._moveTimer = setTimeout(() => {
        state._moveTimer = 0;
        // The cohort is ranked around the camera: a stop re-reads sources
        // so the nearest records win, then culls the horizon.
        refreshNow();
      }, MOVE_END_DEBOUNCE_MS);
    });
  }

  function unwatchCamera() {
    state._removeMoveStart?.();
    state._removeMoveEnd?.();
    state._removeMoveStart = null;
    state._removeMoveEnd = null;
    state._cameraMoving = false;
  }

  function watchTheme() {
    if (state._removeThemeListener || typeof window === 'undefined') return;
    const onStyle = () => {
      // The style's custom properties settle after the class flip.
      setTimeout(() => {
        if (!state._icons) return;
        state._icons.setTheme(readEventTheme());
        parts.rendering.refreshIcons();
      }, 0);
    };
    window.addEventListener('gev:style-change', onStyle);
    state._removeThemeListener = () =>
      window.removeEventListener('gev:style-change', onStyle);
  }

  const methods = {
    id: EVENTS_LAYER_ID,
    name: 'Event Map',
    icon: '◈',
    source: 'Registered event sources',
    updateInterval: EVENTS_UPDATE_INTERVAL_MS,

    init(viewer) {
      if (state._viewer) throw new Error('Event layer is already initialized');
      state._viewer = viewer;
      state._icons = createEventIconCache(readEventTheme());
      parts.rendering.ensureDataSource(viewer);
      state._count = 0;
      state._lastUpdate = null;
      state._lastError = null;
      console.log('[Data:Events] Initialized');
    },

    enable() {
      if (!state._viewer) return false;
      state._enabled = true;
      parts.rendering.setVisible(true);
      parts.interaction.install();
      watchCamera();
      watchTheme();
      subscribeSources();
      refreshNow();
      return true;
    },

    disable() {
      state._enabled = false;
      cancelTimers();
      unsubscribeSources();
      unwatchCamera();
      parts.interaction.remove();
      parts.rendering.setVisible(false);
      parts.rendering.clear();
      state._count = 0;
      notifyListeners();
      return true;
    },

    async update() {
      if (!state._enabled) return false;
      refreshNow();
      return true;
    },

    destroy(viewer = state._viewer) {
      methods.disable();
      state._removeThemeListener?.();
      state._removeThemeListener = null;
      parts.hoverCard.destroy();
      parts.rendering.destroyDataSource(viewer);
      state._viewer = null;
      state._icons = null;
      state._listeners.clear();
    },

    getStats() {
      const errors = [...state._adapterErrors.values()];
      return {
        count: state._count,
        lastUpdate: state._lastUpdate,
        error: state._lastError || (errors.length ? errors[0] : null),
        sources: state._countsByAdapter.size,
        loadingLabel:
          state._enabled && !state._countsByAdapter.size
            ? msg('no event sources on')
            : '',
      };
    },

    /** The manager is handed over before enable (src/app/data.js). */
    attachDataManager(manager) {
      state._dataManager = manager;
    },

    /** The ranked cohort currently on the globe. */
    getEvents() {
      return state._events.slice();
    },

    getEventById(pickId) {
      return state._eventById.get(String(pickId)) || null;
    },

    /**
     * Resolve a pick id or a bare record id to a voice/pick descriptor
     * (src/data/pickedContext.js reads this through the pick registry).
     */
    findByQuery(query) {
      const value = String(query ?? '').trim();
      if (!value) return null;
      const direct = state._eventById.get(value);
      if (direct) return describeEvent(direct);
      const parsed = parseEventPickId(value);
      if (parsed) return null;
      for (const event of state._events) {
        if (event.id === value || event.title.toLowerCase() === value.toLowerCase())
          return describeEvent(event);
      }
      return null;
    },

    /** Cameras near a point, for fire and quake feeds. */
    nearestCameras(point, limit = NEAREST_CAMERA_LIMIT) {
      return nearestEvents(state._events, point, {
        kind: 'camera',
        limit,
        maxKm: NEAREST_CAMERA_MAX_KM,
      }).map(({ event, km }) => ({ event, km }));
    },

    /** Open the feed drawer for an event by pick id (voice, QA, scenes). */
    openEvent(pickId) {
      const event = state._eventById.get(String(pickId));
      if (!event) return false;
      services.feed?.open?.(event, { origin: 'programmatic' });
      return true;
    },

    /** Read every source now instead of waiting for the next trigger. */
    refresh() {
      refreshNow();
      return state._count;
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      state._listeners.add(listener);
      listener(uiState());
      return () => state._listeners.delete(listener);
    },

    getUIState: uiState,

    /** Test/QA seam: run the hover pass at a canvas position. */
    _hoverAtForTest(x, y) {
      state._hoverLastPickAt = 0;
      parts.interaction.handleHoverMove({ x, y });
      return parts.hoverCard.currentKey;
    },

    /** Test/QA seam: the screen position of an event's icon, if on screen. */
    _screenPositionForTest(pickId) {
      const entity = state._entityById.get(String(pickId));
      const scene = state._viewer?.scene;
      if (!entity || !scene) return null;
      const position = entity.position?.getValue?.(
        state._viewer.clock?.currentTime,
      );
      if (!position) return null;
      const screen = scene.cartesianToCanvasCoordinates(position);
      return screen ? { x: screen.x, y: screen.y } : null;
    },

    /** Distance from a point to an event, for ranking helpers and tests. */
    _distanceKmForTest(event, point) {
      return greatCircleKm(point, { lat: event.lat, lon: event.lon });
    },
  };

  return { methods, refreshNow, scheduleRefresh, collect };
}
