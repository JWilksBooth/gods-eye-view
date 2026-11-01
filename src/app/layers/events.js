import * as Cesium from 'cesium';
import {
  createEventsLayer,
  registerEventAdapter,
} from '../../layers/events/index.js';
import { createCctvEventAdapter } from '../../layers/events/adapters/cctv.js';
import { createFiresEventAdapter } from '../../layers/events/adapters/fires.js';
import { createEarthquakesEventAdapter } from '../../layers/events/adapters/earthquakes.js';
import { createAircraftEventAdapter } from '../../layers/events/adapters/aircraft.js';
import { createVesselsEventAdapter } from '../../layers/events/adapters/vessels.js';
import { createIncidentsEventAdapter } from '../../layers/events/adapters/incidents.js';
import { buildIncidentCard } from '../../layers/incidents/index.js';
import { createEventFeedDrawer } from '../../ui/eventFeedDrawer.js';
import { pickViewTarget } from '../../ui/cameraOrientationControls.js';
import * as picking from '../../data/pickRegistry.js';
import * as render from '../../renderGovernor.js';

/** The camera's ground point in degrees, for nearest-first ranking. */
export function readCameraCenter(viewer) {
  const target = viewer ? pickViewTarget(viewer) : null;
  const cartesian = target || viewer?.camera?.positionWC;
  if (!cartesian) return null;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  if (!carto) return null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

/**
 * Construct the event map layer, register the built-in adapters for the
 * catalog's own layers, and give it a feed drawer. A concurrently built
 * layer registers its own adapter the same way (src/layers/events/adapters.js).
 * @param {object} options
 * @param {object} options.surface Application surface services.
 * @param {object} options.layers `{ cctv, firms, earthquakes, flights, military,
 *   vessels, incidents }`; each is optional and adds its adapter when present.
 * @param {object} [options.cctvSource] The CCTV source, for snapshot URLs.
 * @param {object} [options.feed] A feed drawer, when the host supplies one.
 */
export function createApplicationEvents({
  surface,
  layers = {},
  cctvSource = null,
  feed = null,
}) {
  let dataManager = null;
  let drawer = feed;
  const layer = createEventsLayer({
    services: {
      picking,
      render,
      ground: surface.groundFloor,
      camera: { readCameraCenter },
      feed: {
        open: (event, options) => ensureDrawer().open(event, options),
        openCluster: (events, options) =>
          ensureDrawer().openCluster(events, options),
      },
    },
  });
  function ensureDrawer() {
    if (!drawer) {
      drawer = createEventFeedDrawer({
        layers: { cctv: () => layers.cctv, events: () => layer },
        cctvSource,
        dataManager,
      });
    }
    return drawer;
  }
  const attachDataManager = layer.attachDataManager;
  layer.attachDataManager = (manager) => {
    dataManager = manager;
    attachDataManager(manager);
  };
  const unregister = [];
  const add = (adapter) => unregister.push(registerEventAdapter(adapter));
  if (layers.cctv) add(createCctvEventAdapter({ layer: layers.cctv }));
  if (layers.firms)
    add(
      createFiresEventAdapter({
        layer: layers.firms,
        layerId: layers.firms.id,
      }),
    );
  if (layers.earthquakes)
    add(createEarthquakesEventAdapter({ layer: layers.earthquakes }));
  if (layers.flights)
    add(createAircraftEventAdapter({ layer: layers.flights }));
  if (layers.military)
    add(
      createAircraftEventAdapter({
        layer: layers.military,
        layerId: 'military',
        id: 'military-aircraft',
      }),
    );
  if (layers.vessels) add(createVesselsEventAdapter({ layer: layers.vessels }));
  if (layers.incidents)
    add(
      createIncidentsEventAdapter({
        layer: layers.incidents,
        describe: describeIncident,
        openExternal,
      }),
    );
  const destroy = layer.destroy;
  layer.destroy = (viewer) => {
    for (const remove of unregister.splice(0)) remove();
    drawer?.destroy?.();
    drawer = feed;
    destroy(viewer);
  };
  /** The drawer, for the shell's Escape and QA seams. */
  layer.getFeedDrawer = () => drawer;
  layer.closeFeed = () => drawer?.close?.('programmatic') ?? false;
  return layer;
}

/** The incident card's lines, minus its own click hint (the drawer has a button). */
export function describeIncident(row, nowMs = Date.now()) {
  const card = buildIncidentCard(row, nowMs);
  const details = row.url ? card.details.slice(0, -1) : card.details;
  return [card.title, ...details];
}

/** Agency pages open in a new tab, as the incident card itself does. */
function openExternal(url) {
  globalThis.window?.open?.(url, '_blank', 'noopener,noreferrer');
}
