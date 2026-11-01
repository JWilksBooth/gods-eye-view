import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  ALERT_OUTLINE_TOKEN,
  createAlert,
  createAlertsLayer,
  resolveSeverityColors,
} from './index.js';

const NOW = Date.parse('2026-11-01T17:00:00Z');

// A stand-in theme: the layer may only ever draw with what these tokens hold.
const THEME = Object.freeze({
  '--accent': '#00ff41',
  '--alert-severity-extreme': '#ff3b5c',
  '--alert-severity-severe': '#ff8a1f',
  '--alert-severity-moderate': '#ffd23b',
  '--alert-severity-minor': '#00ff41',
  '--alert-severity-unknown': 'rgba(232, 234, 237, 0.5)',
  [ALERT_OUTLINE_TOKEN]: '#020a04',
});

const square = [
  [-122.5, 37.7],
  [-122.3, 37.7],
  [-122.3, 37.9],
  [-122.5, 37.9],
  [-122.5, 37.7],
];

const ALERTS = [
  createAlert(
    {
      id: 'caltrans:4:C1:1',
      source: 'caltrans',
      kind: 'road',
      severity: 'moderate',
      agency: 'Caltrans District 4',
      headline: 'US-101 North · Full closure',
      area: { type: 'Point', coordinates: [-122.4, 37.78] },
      regions: ['sf-bay-area'],
      issued: NOW - 3_600_000,
      url: 'https://lcswebreports.dot.ca.gov/searchdistricts?district=4',
    },
    { fetchedAt: NOW },
  ),
  createAlert(
    {
      id: 'nws:coastal',
      source: 'nws',
      kind: 'weather',
      severity: 'minor',
      agency: 'NWS San Francisco Bay Area',
      headline: 'Coastal Flood Advisory',
      area: { type: 'Polygon', coordinates: [square] },
      areaSource: 'zones',
      regions: ['sf-bay-area'],
      issued: NOW - 600_000,
      url: 'https://forecast.weather.gov/showsigwx.php?warnzone=CAZ006&warncounty=CAC075',
    },
    { fetchedAt: NOW },
  ),
  createAlert(
    {
      id: 'bart:1',
      source: 'bart',
      kind: 'transit',
      severity: 'severe',
      agency: 'BART',
      headline: 'Single tracking',
      regions: ['sf-bay-area'],
      issued: NOW - 60_000,
      url: 'https://www.bart.gov/schedules/advisories',
    },
    { fetchedAt: NOW },
  ),
  createAlert(
    {
      id: 'faa:LAS:delay:all',
      source: 'faa',
      kind: 'airport',
      severity: 'minor',
      agency: 'FAA',
      headline: 'LAS · Delays',
      area: { type: 'Point', coordinates: [-115.1537, 36.084] },
      regions: ['las-vegas'],
      issued: NOW - 60_000,
    },
    { fetchedAt: NOW },
  ),
];

const SOURCES = [
  { id: 'nws', label: 'NWS alerts', status: 'ok', count: 1, fetchedAt: null },
  {
    id: 'caltrans',
    label: 'Caltrans lane closures',
    status: 'ok',
    count: 1,
    partial: true,
  },
  {
    id: 'faa',
    label: 'FAA airport status',
    status: 'stale',
    stale: true,
    count: 1,
  },
  {
    id: 'airnow',
    label: 'AirNow air quality',
    status: 'key-required',
    count: 0,
  },
  {
    id: 'lafd',
    label: 'LAFD alerts',
    status: 'unavailable',
    stale: true,
    count: 0,
    error: 'http_404',
  },
];

function harness({
  pick = () => null,
  cardHit = () => null,
  alerts = ALERTS,
} = {}) {
  const sources = [];
  const overlay = { entries: new Map(), visible: new Map() };
  const clicks = { handler: null, destroyed: 0 };
  const owners = new Map();
  const opened = [];
  const requests = [];
  const viewer = {
    scene: { pick },
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createAlertsLayer({
    source: {
      getSnapshot: async (options) => {
        requests.push(options);
        return {
          alerts: options.region
            ? alerts.filter((entry) => entry.regions.includes(options.region))
            : alerts,
          sources: SOURCES,
          regions: [],
          region: options.region ?? null,
          fetchedAt: new Date(NOW).toISOString(),
          stale: false,
        };
      },
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        overlay.entries.set(sourceId, entries);
      },
      setVisible(sourceId, visible) {
        overlay.visible.set(sourceId, visible);
      },
      clearSource(sourceId) {
        overlay.entries.delete(sourceId);
      },
      hitTest: (x, y, options) => cardHit(x, y, options),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(callback) {
        clicks.handler = callback;
      },
      destroy() {
        clicks.destroyed += 1;
        clicks.handler = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, pickedId) =>
        String(pickedId).startsWith('other-layer:'),
      registerPickOwner: (layerId, predicate) => owners.set(layerId, predicate),
      unregisterPickOwner: (layerId) => owners.delete(layerId),
    },
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
    resolveToken: (name) => THEME[name] ?? '',
    now: () => NOW,
  });
  layer.init(viewer);
  return { layer, viewer, sources, overlay, clicks, owners, opened, requests };
}

const entities = (h) => h.sources[0].entities.values;
const colorOf = (entity) =>
  entity.point.color
    .getValue(Cesium.JulianDate.now())
    .withAlpha(1)
    .toCssHexString();

test('markers, areas and bulletins are drawn with the theme tokens only', async () => {
  const h = harness();
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  const ids = entities(h)
    .map((entity) => entity.id)
    .sort();
  // Worst first, then newest: the closure, the LAS delay, the coastal area;
  // the BART advisory has no shape and joins its region's bulletins.
  assert.deepEqual(ids, [
    'alert-area:2',
    'alert-bulletins:sf-bay-area',
    'alert-point:0',
    'alert-point:1',
  ]);
  const byId = Object.fromEntries(
    entities(h).map((entity) => [entity.id, entity]),
  );
  assert.equal(colorOf(byId['alert-point:0']), '#ffd23b', 'moderate token');
  assert.equal(colorOf(byId['alert-point:1']), '#00ff41', 'minor token');
  assert.equal(
    colorOf(byId['alert-bulletins:sf-bay-area']),
    '#ff8a1f',
    'worst bulletin, severe',
  );
  assert.equal(
    byId['alert-point:0'].point.outlineColor
      .getValue(Cesium.JulianDate.now())
      .withAlpha(1)
      .toCssHexString(),
    '#020a04',
  );
  const area = byId['alert-area:2'];
  assert.equal(
    area.polygon.material.color
      .getValue(Cesium.JulianDate.now())
      .withAlpha(1)
      .toCssHexString(),
    '#00ff41',
  );
  const labels = h.overlay.entries.get('alerts');
  assert.ok(labels.some((label) => label.title === 'Coastal Flood Advisory'));
  assert.ok(
    labels.some(
      (label) => label.title === 'San Francisco Bay Area · 1 bulletin',
    ),
  );
  assert.ok(
    labels.every((label) => Object.values(THEME).includes(label.accent)),
    'label accents come from the tokens',
  );
  const stats = h.layer.getStats();
  assert.equal(stats.count, 4);
  assert.equal(stats.partial, true);
  assert.equal(stats.stale, false);
  assert.equal(
    stats.sources.find((entry) => entry.id === 'lafd').error,
    'http_404',
  );
});

test('without a stylesheet no colour is invented', () => {
  const colors = resolveSeverityColors(() => '');
  assert.deepEqual(colors, {
    extreme: null,
    severe: null,
    moderate: null,
    minor: null,
    unknown: null,
    outline: null,
  });
  const fallback = resolveSeverityColors((name) =>
    name === '--accent' ? '#00ff41' : 'not a colour',
  );
  assert.equal(fallback.extreme, '#00ff41');
  const thrown = resolveSeverityColors(() => {
    throw new Error('no document');
  });
  assert.equal(thrown.minor, null);
});

test('the layer source names no colour literal', () => {
  for (const file of [
    'index.js',
    'model.js',
    'cards.js',
    'regions.js',
    'source.js',
  ]) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, file);
  }
  const wrapper = readFileSync(
    new URL('../../app/layers/alerts.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(wrapper, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  const css = readFileSync(
    new URL('../../ui/styles/alerts.css', import.meta.url),
    'utf8',
  );
  for (const token of Object.keys(THEME).filter((name) =>
    name.startsWith('--alert'),
  ))
    assert.match(css, new RegExp(`${token}:`), token);
});

test('point and bulletin markers are claimed for picking; areas are not', async () => {
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  const owns = h.owners.get('alerts');
  assert.equal(typeof owns, 'function');
  assert.equal(owns('alert-point:0'), true);
  assert.equal(owns('alert-bulletins:sf-bay-area'), true);
  assert.equal(
    owns('alert-area:2'),
    false,
    'large areas never block sibling cards',
  );
  assert.equal(owns('alert-point:99'), false);
  h.layer.disable();
  assert.equal(h.owners.has('alerts'), false);
  assert.equal(h.clicks.destroyed, 1);
});

test('a click opens the alert card, the card opens the source, empty space clears it', async () => {
  let picked = null;
  let hit = null;
  const h = harness({ pick: () => picked, cardHit: () => hit });
  h.layer.enable();
  await h.layer.update();
  picked = { id: 'alert-point:0' };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  let [card] = h.overlay.entries.get('alerts-selected');
  assert.equal(card.id, 'alert-card:caltrans:4:C1:1');
  assert.equal(card.title, 'US-101 North · Full closure');
  assert.equal(card.details[0], 'Caltrans District 4 · Moderate');
  assert.match(card.details.join('\n'), /Issued 1 hour ago/);
  assert.match(card.details.at(-1), /^lcswebreports\.dot\.ca\.gov ↗/);
  assert.equal(card.accent, '#ffd23b');
  assert.ok(card.position, 'the card carries a world anchor');
  hit = { entryId: card.id };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.deepEqual(h.opened, [
    'https://lcswebreports.dot.ca.gov/searchdistricts?district=4',
  ]);
  hit = null;

  picked = { id: 'alert-area:2' };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  [card] = h.overlay.entries.get('alerts-selected');
  assert.equal(
    card.title,
    'Coastal Flood Advisory',
    'an area click still selects',
  );

  picked = { id: 'alert-bulletins:sf-bay-area' };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  [card] = h.overlay.entries.get('alerts-selected');
  assert.equal(card.title, 'San Francisco Bay Area · 1 bulletin');
  assert.match(card.details[0], /^Single tracking · BART/);

  picked = { id: 'other-layer:aircraft' };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('alerts-selected').length, 1);
  picked = null;
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('alerts-selected').length, 0);
});

test('kind chips and the region param narrow what is drawn and asked', async () => {
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.setParams({ kinds: ['road', 'bogus'] }), true);
  assert.deepEqual(h.layer.getParams(), { kinds: ['road'], region: null });
  assert.deepEqual(
    entities(h).map((entity) => entity.id),
    ['alert-point:0'],
  );
  assert.equal(h.layer.setParams({}), false);
  h.layer.setParams({
    kinds: ['road', 'weather', 'transit', 'airport'],
    region: 'LAS-VEGAS',
  });
  assert.equal(h.layer.getParams().region, 'las-vegas');
  await h.layer.update();
  assert.equal(h.requests.at(-1).region, 'las-vegas');
  assert.deepEqual(
    entities(h).map((entity) => entity.id),
    ['alert-point:0'],
  );
  assert.equal(h.layer.findByQuery('alert-point:0').name, 'LAS · Delays');
  h.layer.setParams({ region: 'atlantis' });
  assert.equal(h.layer.getParams().region, null);
});

test('the row shows kind chips, a token legend and the feed health', async () => {
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  const controls = h.layer.getRowControls();
  assert.deepEqual(
    controls.chips.map((chip) => chip.id),
    [
      'weather',
      'fire',
      'air',
      'road',
      'transit',
      'airport',
      'emergency',
      'advisory',
    ],
  );
  assert.deepEqual(
    controls.legend.map((item) => item.color),
    [
      'var(--alert-severity-extreme)',
      'var(--alert-severity-severe)',
      'var(--alert-severity-moderate)',
      'var(--alert-severity-minor)',
      'var(--alert-severity-unknown)',
    ],
  );
  assert.deepEqual(
    controls.legend.map((item) => item.count),
    [0, 1, 1, 2, 0],
  );
  assert.equal(controls.info, '2 of 4 feeds live');
  assert.match(controls.infoTitle, /AirNow air quality: key required/);
  assert.match(controls.infoTitle, /LAFD alerts: unavailable/);
  assert.match(controls.infoTitle, /FAA airport status: stale/);
  const found = h.layer.findByQuery('coastal');
  assert.equal(found.id, 'nws:coastal');
  assert.ok(Math.abs(found.latitude - 37.8) < 1e-9);
  assert.equal(
    h.layer.findByQuery('alert-bulletins:sf-bay-area').name,
    'San Francisco Bay Area: Single tracking',
  );
  assert.equal(h.layer.findByQuery('nothing like it'), null);
  assert.equal(h.layer.getAnalystRecords()[0].id, 'bart:1');
  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);
});

test('a failed refresh keeps the drawing and reports the error', async () => {
  let fail = false;
  const h = harness();
  const original = h.layer.update;
  h.layer.enable();
  await original();
  const layer = createAlertsLayer({
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('Alerts feed unavailable (HTTP 502)');
        return {
          alerts: ALERTS,
          sources: [],
          regions: [],
          fetchedAt: null,
          stale: false,
        };
      },
    },
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init({ dataSources: { add() {}, remove() {} } });
  layer.enable();
  assert.equal(await layer.update(), true);
  fail = true;
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().error, 'Alerts feed unavailable (HTTP 502)');
  assert.equal(layer.getStats().count, 4);
  assert.throws(
    () => createAlertsLayer({ overlayHost: {} }),
    /snapshot source/,
  );
  assert.throws(
    () => createAlertsLayer({ source: { getSnapshot() {} } }),
    /overlay host/,
  );
});
