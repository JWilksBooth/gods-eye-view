# Event map

Live events and places as constant-size icons on the globe, a hover card with
a one-line description, a click that opens a right-side feed drawer with the
live content, and a top-down grid view. The layer is `events` in the Data
Layers panel (Events group); the grid view is Display → GRID or the `G` key.

## How it is built

- `src/layers/events/adapters.js`: the adapter registry. A layer joins the
  event map with `registerEventAdapter({ id, kind, layerId, getEvents,
feed? })`; the interface and every field are documented in the file.
- `src/layers/events/adapters/{cctv,fires,earthquakes,aircraft,vessels,
incidents}.js`: the built-in adapters, registered by `src/app/layers/
events.js` from the catalog's own layer instances. An adapter is read only
  while its layer is on, so the event map shows what the operator has turned
  on. The incidents adapter lists LIVE OPS incidents newest first and reuses
  the incident card (`buildIncidentCard`) for the drawer detail, with an "Open
  at source" action for the agency page. The alerts adapter does the same over
  the alerts layer (`getAlerts()`, `buildAlertCard`): worst severity first and
  newest within a band, the hover line is the headline with agency and
  severity, and a shapeless bulletin sits at its LIVE OPS region centre.
- `src/layers/events/model.js`: pick ids (`event:<adapter>:<id>`), record
  normalization, priority-then-distance ranking, freshness, cluster summaries
  and nearest-camera lookups.
- `src/layers/events/icons.js`: SVG icons per kind coloured from CSS tokens
  (`--event-<kind>` in `src/ui/styles/events.css`), plus cluster count badges.
- `src/layers/events/rendering.js`: a clustered `CustomDataSource` (Cesium
  `EntityCluster`): constant screen size, depth test off, horizon cull,
  reconciled on data changes and camera stops only, never per frame.
- `src/layers/events/hoverCard.js` and `interaction.js`: one hover card
  element, throttled hover picks (120 ms), clean-tap clicks, pick ownership.
- `src/layers/events/lifecycle.js`: the manager module (`init/enable/disable/
update/destroy/getStats`, `attachDataManager`, `findByQuery`, `openEvent`,
  `nearestCameras`, QA seams).
- `src/ui/eventFeedDrawer.js` + `src/ui/styles/events.css`: the right-side
  drawer (`dialog[data-panel-surface]`, Esc or × closes and tears media down;
  a camera's video paints from the CCTV layer's single decoder; stream embeds
  are created on open and destroyed on close).
- `src/layers/streams/{embed,playback}.js`: pure embed descriptors (YouTube
  privacy-enhanced iframe, HLS, MJPEG, link-out) and bounded hls.js playback.
  The `streams` layer that feeds them is built separately (see Remaining).

### Registration

`events` holds layer-state token `8` (`src/data/layerState.js`,
`src/data/layerStateTokenReservations.json`); it is named in
`src/ui/layerNames.js`, placed first in the Events group of
`src/ui/layerPanel.js`, has pick kind `event` in `src/data/pickedContext.js`,
is constructed last in `src/app/constructCatalog.js` with the CCTV, FIRMS,
earthquakes, flights, military, vessels and incidents instances and
`sources.cctv`, occludes world overlays behind `#event-feed-drawer`
(`src/overlays/worldOverlay.js`), is reachable by voice as a toggle
(`src/voice/layerManifest.js`), and its stylesheet is imported from
`style.css`.

### Grid view

`src/ui/gridView.js` (controller) and `src/gridViewMath.js` (pure geometry),
owned by `VisualSettings` (`setGridViewEnabled`, `toggleGridView`,
`restoreStoredGridView`), bound to the DISPLAY button `#grid-view-toggle` and
the `G` key by `displayBindings.js`.

- The 3D camera is switched to an `OrthographicFrustum`
  (`camera.switchToOrthographicFrustum()`), never `SceneMode.SCENE2D`. The
  frustum gets `fov`/`fovy` readers that answer the perspective angle a camera
  at the current height would need, so the flights, military, CCTV, launches
  and celestial-ring pixel math keeps working; writes are ignored. On exit the
  saved perspective frustum is restored.
- The camera is aimed straight down and north up through
  `readCameraTargetFrame`/`setCameraTargetFrame`. While the view is on every
  camera stop re-checks the orbit frame and straightens it, so a flight or an
  orbit ends top-down; a camera still in flight when the view is turned on is
  straightened on arrival.
- Tilt and look (`screenSpaceCameraController.enableTilt/enableLook`) are
  locked while on and restored on exit.
- The base is darkened: a shown 3D tileset gets a grey `Cesium3DTileStyle`
  tint, a globe imagery base gets `brightness` 0.55
  (`GRID_VIEW_BASE_LUMINANCE`); the previous style or brightness is restored
  on exit, and a map-stack switch while on re-applies it to the new base.
- `#event-grid-overlay`, a canvas inside `#cesiumContainer`, draws lat/lon
  lines at a 1-2-5 spacing chosen for the visible extent, degree labels on
  the top and left edges and an MGRS label per cell (`src/mgrsFormat.js`, the
  HUD's formatter, now shared). Colours come from the `--event-grid-*` tokens.
  It repaints on camera stops, resizes and theme changes, and per rendered
  frame only while the camera is moving.
- The choice is remembered in `localStorage` (`gev:grid-view:v1`, applied at
  start-up) and travels in share links: long-form `gv=1` (written only while
  on) and compact flag bit 5 `gridView` (`docs/SHARE-LINK-FORMAT.md`).

## QA

`npm run qa:event-map` (`scripts/qa-event-map.mjs`) drives a real Chrome
against a running app with seeded cameras and incidents over San Francisco on
top of the real imagery: it enables the layers, hovers an icon with the real
pointer, clicks it open, opens the drawer on a camera, presses `G` and checks
the frustum, lock, tint, canvas, button, preference and share hash, then
turns the view off again. Screenshots land in `docs/media/event-map/`:

| Shot                     | Shows                                                 |
| ------------------------ | ----------------------------------------------------- |
| `01-icons.png`           | camera and incident icons over the city               |
| `02-hover.png`           | the hover card on a fire incident                     |
| `03-drawer-incident.png` | the drawer with the incident card and nearest cameras |
| `04-drawer-camera.png`   | the drawer with a camera snapshot                     |
| `05-grid-view.png`       | the grid view: top-down, dimmed, graticule and MGRS   |

## Remaining

- Streams (built in parallel on the same base): `server/providers/streams/`
  (curated registry, YouTube discovery, Windy, scanners),
  `src/layers/streams/{source,index}.js` with token `9`, keys in
  `src/keySetupCore.mjs` and `.env.example`, `find_live_streams` tool,
  `DATA_SOURCES.md`, `src/data/dataCredits.js`, `docs/TOOLS.md`, and a
  `streams` adapter registered like the built-in ones.
- At merge, reconcile the three branches' layer-state tokens and the pinned
  counts in `src/data/layerState.test.mjs` and
  `src/data/layerStateTokenLedger.test.mjs`, the voice tool-schema pins in
  `src/firstRunExperience.test.mjs` and `src/voice/actionSchemas.test.mjs`,
  and the catalog counts in `src/app/constructCatalog.test.mjs`.

## Provider terms (researched 2026-11-01)

- **YouTube Data API v3**: since June 2026 `search.list` has its own bucket of
  100 calls/day (previously 100 units of the 10,000-unit pool); `videos.list`
  costs 1 unit for up to 50 ids. Four regions refreshed hourly is 96 searches a
  day, so the server must also keep a daily budget and serve the cached result
  when it is spent. `location` needs `locationRadius` (≤ 1000 km) and
  `type=video`; `videoEmbeddable=true` filters to embeddable videos. Cached API
  data must be refreshed or deleted within 30 days. `recordingDetails.location`
  is deprecated, so discovered streams without coordinates fall back to the
  region centre and say so. Embedding: the standard iframe with documented
  parameters, nothing overlaid on the player, at least 200×200 px, one
  auto-playing player per page; `youtube-nocookie.com` is the documented
  privacy-enhanced domain.
- **Windy Webcams API v3**: free key (`x-windy-api-key`); show images only from
  API URLs (tokens expire in 10–15 min, so no caching of image URLs), link each
  image to the Windy webcam page or player, credit "Webcams provided by
  windy.com", use Windy's embed player for live/timelapse; no published daily
  limit.
- **Broadcastify**: terms §9(d) forbid relaying, re-streaming or embedding live
  audio without a commercial licence; the embed widget was retired in 2026.
  Link out to the feed page only.
- **OpenMHz**: terms §3/§5: linking to the site is allowed, linking to audio or
  using the API is not without permission. Link out only.
