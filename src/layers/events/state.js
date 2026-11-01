/** Per-layer scene and interaction state; one object per layer instance. */
export function createState() {
  return {
    _viewer: null,
    _enabled: false,
    _dataManager: null,
    _dataSource: null,
    _removeClusterListener: null,
    /** @type {Map<string, import('cesium').Entity>} pickId → entity */
    _entityById: new Map(),
    /** @type {Map<string, object>} pickId → normalized event */
    _eventById: new Map(),
    /** @type {object[]} The current ranked cohort. */
    _events: [],
    /** @type {Map<string, number>} adapter id → events contributed */
    _countsByAdapter: new Map(),
    /** @type {Map<string, string>} adapter id → last read error */
    _adapterErrors: new Map(),
    _handler: null,
    _removeMoveStart: null,
    _removeMoveEnd: null,
    _cameraMoving: false,
    _refreshTimer: 0,
    _moveTimer: 0,
    _unsubscribes: [],
    _adapterUnsubscribes: new Map(),
    _hoverLastPickAt: 0,
    _hoverKey: null,
    _hoverReleaseTimer: 0,
    _icons: null,
    _removeThemeListener: null,
    _count: 0,
    _lastUpdate: null,
    _lastError: null,
    _listeners: new Set(),
    _refreshGeneration: 0,
    _lastHorizonSignature: null,
  };
}
