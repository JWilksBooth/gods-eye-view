import * as Cesium from 'cesium';
import { createAlertsLayer } from '../../layers/alerts/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** The theme's value for a CSS custom property, read from the document root. */
function resolveThemeToken(name) {
  const root = globalThis.document?.documentElement;
  if (!root || typeof globalThis.getComputedStyle !== 'function') return '';
  return globalThis.getComputedStyle(root).getPropertyValue(name) || '';
}

/** Wire official alerts into the application catalog. */
export function createApplicationAlerts(options) {
  return createAlertsLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    resolveToken: resolveThemeToken,
    ...options,
  });
}
