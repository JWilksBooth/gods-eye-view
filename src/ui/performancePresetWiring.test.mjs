import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const template = read('src/ui/templates/display-controls.html');
const shell = read('src/ui/applicationShell.js');
const settings = read('src/ui/visualSettings.js');
const facade = read('src/ui/shellFacade.js');
const bindings = read('src/ui/displayBindings.js');
const tools = read('src/app/tools.js');
const scene = read('src/app/scene.js');
const sharelink = read('src/sharelink.js');
const codec = read('src/share/viewCodec.js');

test('the Performance preset lives under DISPLAY as one segmented row ahead of the HUD group', () => {
  const display = template.match(/id="pp-toggles"[\s\S]*?id="clean-view-exit"/);
  assert.ok(display, 'Display markup is missing');
  assert.match(
    display[0],
    /id="performance-preset-seg"[\s\S]*?data-performance="quality"[\s\S]*?data-performance="balanced"[\s\S]*?data-performance="performance"[\s\S]*?id="hud-toggle"/,
  );
  // Balanced ships selected in the markup, the same markup-carries-the-default
  // convention as the 3D toggle; the owner re-syncs it from the stored choice.
  assert.match(
    display[0],
    /data-performance="balanced"[^>]*aria-checked="true"/,
  );
  assert.equal(
    (template.match(/id="performance-preset-seg"/g) || []).length,
    1,
  );
});

test('the preset is applied after the first-load baseline and before share restoration', () => {
  const baseline = shell.indexOf('this._applyGlobalPostDefaults();');
  const preset = shell.indexOf('this._applyPerformancePresetVisuals();');
  const restore = shell.indexOf('this._shareRestoration.start();');
  assert.ok(baseline > 0 && preset > baseline && restore > preset);
});

test('VisualSettings owns the preset: it persists the choice and keeps it out of the share link', () => {
  assert.match(settings, /persistPerformancePreset\(/);
  // It adopts the page load's choice (settled with the viewer) rather than
  // re-reading storage, which would replace a ?quality= override.
  assert.match(settings, /adoptInitialPerformancePreset\(/);
  assert.doesNotMatch(settings, /readStoredPerformancePreset\(/);
  const shareState = settings.slice(settings.indexOf('_readShareState() {'));
  const shareBody = shareState.slice(
    0,
    shareState.indexOf('getDetectionState() {'),
  );
  assert.doesNotMatch(shareBody, /performance/i);
  assert.doesNotMatch(sharelink, /performancePreset/);
  assert.doesNotMatch(codec, /performancePreset/);
});

test('the facade delegates the preset API and Display binds the selector', () => {
  assert.match(
    facade,
    /setPerformancePreset\(preset[^)]*\) \{\s*return this\._visualSettings\.setPerformancePreset\(/,
  );
  assert.match(
    facade,
    /getPerformancePreset\(\) \{\s*return this\._visualSettings\.getPerformancePreset\(/,
  );
  assert.match(bindings, /performanceButtons: this\._performancePresetBtns/);
  assert.match(
    bindings,
    /setPerformancePreset: \(value\) => this\.setPerformancePreset\(value\)/,
  );
});

test('the preset is installed with the viewer, before its first frame and before the photoreal tileset loads tiles', () => {
  const adopt = scene.indexOf('adoptInitialPerformancePreset({');
  const viewer = scene.indexOf('createApplicationViewer({');
  const install = scene.indexOf('installPerformancePreset(viewer, {');
  const attach = scene.indexOf('performancePreset.attachTileset(tileset);');
  const add = scene.indexOf('viewer.scene.primitives.add(tileset);');
  assert.ok(adopt > 0 && viewer > adopt && install > viewer);
  assert.ok(attach > install && add > attach);
  // The construction-time buffer is already in device pixels at the
  // preset's sampling, and every resize is clamped to the GPU's limits.
  assert.match(
    scene,
    /createApplicationViewer\(\{[\s\S]*?msaaSamples: initialPreset\.msaaSamples,[\s\S]*?deviceResolution: true/,
  );
  assert.match(
    scene,
    /installPerformancePreset\(viewer, \{[\s\S]*?storage: presetStorage,[\s\S]*?search: presetSearch,[\s\S]*?getMaxTextureSize: webglBufferLimit/,
  );
  assert.match(scene, /defer\(\(\) => performancePreset\.uninstall\(\)\)/);
  // tools.js no longer installs a second copy; it exposes the snapshot.
  assert.doesNotMatch(tools, /installPerformancePreset/);
  assert.match(tools, /describePerformancePreset: \(\) =>/);
});

test('base-map imagery is built at the preset anisotropy with LINEAR filters and rebuilt when it changes', () => {
  assert.match(
    scene,
    /createImageryLayer: \(provider\) =>\s*new Cesium\.ImageryLayer\(\s*provider,\s*imageryLayerOptions\(\{\s*maximumAnisotropy: getPerformanceSettings\(\)\.imageryMaximumAnisotropy,/,
  );
  assert.match(
    scene,
    /refreshImageryOnAnisotropyChange\(\(\) =>\s*mapStackController\.refreshImageryLayer\?\.\(\),?\s*\)/,
  );
});

test('the preset withholds sharpen through the effects gate, never through the operator toggle', () => {
  const visuals = settings.slice(
    settings.indexOf('_applyPerformancePresetVisuals() {'),
  );
  const body = visuals.slice(0, visuals.indexOf('\n  }\n'));
  assert.match(body, /this\._applySharpenPermission\(/);
  assert.doesNotMatch(body, /_setSharpenEnabled/);
  assert.match(
    settings,
    /this\._visualEffects\.setSharpenPermitted\(permitted\)/,
  );
});

test('the PERFORMANCE row carries a drawing-buffer readout the code fills in', () => {
  const row = template.match(
    /id="performance-preset-row"[\s\S]*?<\/div>\s*<\/div>/,
  );
  assert.ok(row, 'performance row markup is missing');
  assert.match(
    row[0],
    /<output class="performance-preset-status" id="performance-preset-status"[^>]*data-i18n-runtime/,
  );
  assert.match(settings, /getElementById\?\.\('performance-preset-status'\)/);
});
