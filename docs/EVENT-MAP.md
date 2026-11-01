# Event map (work in progress)

Branch `claude/eloquent-wright-n7enqr`. The framework under `src/layers/events/`
is written but not yet registered in the layer catalog; nothing in the running
app changes until the wiring below lands.

## Done

- `src/layers/events/adapters.js`: the adapter registry. A layer joins the event
  map with `registerEventAdapter({ id, kind, layerId, getEvents, feed? })`;
  the interface, every field, and commented stubs for the `incidents` and
  `alerts` layers are documented in that file.
- `src/layers/events/model.js`: pick ids (`event:<adapter>:<id>`), record
  normalization, priority-then-distance ranking, freshness, cluster summaries,
  nearest-camera lookups.
- `src/layers/events/icons.js`: SVG icons per kind coloured from CSS tokens
  (`--event-<kind>` in `src/ui/styles/events.css`, derived from the foundation
  palette), plus count badges for clusters.
- `src/layers/events/rendering.js`: a clustered `CustomDataSource` (Cesium
  `EntityCluster`, the Radio layer's pattern): constant screen size, depth test
  off, horizon cull, reconciled on data changes and camera stops only.
- `src/layers/events/hoverCard.js` and `interaction.js`: one hover card element,
  throttled hover picks (120 ms), clean-tap clicks, `registerPickOwner('events')`.
- `src/layers/events/lifecycle.js`: the manager module (`init/enable/disable/
update/destroy/getStats`, `attachDataManager`, `findByQuery`, `openEvent`,
  `nearestCameras`, QA seams).
- `src/layers/events/adapters/{cctv,fires,earthquakes,aircraft,vessels}.js`.
- `src/ui/eventFeedDrawer.js` + `src/ui/styles/events.css`: the right-side
  drawer (`dialog[data-panel-surface]`, Esc or × closes and tears media down;
  camera video paints from the CCTV layer's single decoder; stream embeds are
  created on open and destroyed on close).
- `src/layers/streams/{embed,playback}.js`: pure embed descriptors (YouTube
  privacy-enhanced iframe, muted autoplay; HLS; MJPEG; link-out) and bounded
  hls.js playback.
- `src/app/layers/events.js`: application wiring that registers the built-in
  adapters and lazily creates the drawer.

## Remaining

1. Register the layer: `events` token `6` (and `streams` `7`) in
   `src/data/layerState.js` and `layerStateTokenReservations.json`; update the
   pinned counts in `src/data/layerState.test.mjs` (32 → 34, next token `6` →
   `8`) and `layerStateTokenLedger.test.mjs` (fixture tokens `6`/`7` → `8`/`9`,
   `[...'6789']` → `[...'89']`, "33 published" → "35 published"); add
   `events`/`streams` to `src/ui/layerNames.js`, `PANEL_GROUPS` in
   `src/ui/layerPanel.js`, `KIND_BY_LAYER` in `src/data/pickedContext.js`;
   import `events.css` from `style.css`; construct the layer in
   `src/app/constructCatalog.js` with the catalog's cctv, firms, earthquakes,
   flights, military and vessel instances and `sources.cctv`; add
   `#event-feed-drawer` to `WORLD_OVERLAY_OCCLUDER_SELECTORS`.
2. Grid view: orthographic frustum on the 3D camera (not `SceneMode.SCENE2D`,
   which six modules assume away) with `fov`/`fovy` compatibility getters so the
   flights, military and CCTV pixel math keeps working; north-up straight-down
   through `readCameraTargetFrame`; tilt and look locked while on; darker base
   via tileset tint and imagery brightness, restored on exit; grid canvas with
   lat/lon lines and MGRS labels through the HUD's `_formatMGRS` (move it to a
   shared module); `G` key (free: 1–6, H, O, V, F, D, C, Q–T, backtick and Esc
   are taken) and a DISPLAY button; `gev:grid-view:v1` in localStorage; share
   flag bit 5 `gridView` in `src/share/viewCodec.js`, long-form `gv` in
   `src/sharelink.js`, applied through `visualSettings.js`.
3. Streams: done on `wip/streams` (see **Streams** below); at merge the
   `streams` layer takes token `9`.
4. Translations for every new string in all ten locale catalogs, `npm run i18n`,
   `npm run format`, `npm test`, `scripts/qa-event-map.mjs`, screenshots, PR.

## Streams

The `streams` layer (`src/layers/streams/`, token `9`, enabled-only) and the
`/api/streams` provider (`server/providers/streams.js`) put geotagged live
streams on the map for the four LIVE OPS regions. Everything that crosses the
wire is metadata (`src/layers/streams/records.js`: where, who, and how it
plays); the source never requests media and never creates a player. A player
exists only inside the feed drawer, created when an icon is clicked and
destroyed when the drawer closes.

- **Sources** (`server/providers/streams/`): the curated registry (one JSON
  file per region under `registry/`; every YouTube entry answered oEmbed, so it
  is public and embeddable, and every Caltrans HLS playlist answered `#EXTM3U`
  on its `verified_at`), YouTube Data API discovery behind `YOUTUBE_API_KEY`
  (hourly per region, a daily budget below the 100-call `search.list` bucket,
  cached result served when spent, disk copy pruned after 30 days, discovered
  streams placed at the region centre and saying so), Windy webcams behind
  `WINDY_WEBCAMS_API_KEY` (hourly per region, preview URLs served only within
  nine minutes of their fetch, rows link to Windy's player, credited "Webcams
  provided by windy.com") and Broadcastify scanner directories as link-outs.
  Keyless, the layer serves the registry and the link-outs.
- **Registry counts on 2026-10-31**: Los Angeles 16, San Francisco Bay Area
  15, Las Vegas 8, Sonoma County 8 (2 civic YouTube cameras plus 6 Caltrans
  District 4 HLS feeds; the county has few public YouTube cameras), plus one
  or more scanner link-outs per region.
- **Layer**: points coloured by kind (`--event-stream` for anything that plays
  in place, `--text-dim` for link-outs), ambient labels, a card on click that
  opens the stream through the event map's drawer when the Event Map layer is
  on and on the provider's page otherwise. While the Event Map layer is on, its
  icons carry the streams and the layer's own points hide, so nothing is drawn
  twice. `src/app/layers/streams.js` registers the adapter
  (`src/layers/streams/eventAdapter.js`, kind `stream`, `layerId: 'streams'`)
  whose `feed()` is `{ type: 'stream', stream, owner, terms }`.
- **Tool**: `find_live_streams` (region, area, kind, source, limit) on MCP and
  voice; `docs/TOOLS.md`.

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
