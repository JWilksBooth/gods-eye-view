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
  assert.match(settings, /readStoredPerformancePreset\(/);
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

test('the viewer adopts the remembered preset where the render governor is installed', () => {
  const governor = tools.indexOf('installRenderGovernor(viewer);');
  const preset = tools.indexOf('installPerformancePreset(viewer, {');
  assert.ok(governor > 0 && preset > governor);
  assert.match(
    tools,
    /installPerformancePreset\(viewer, \{[\s\S]*?tileset,[\s\S]*?storage: presetStorage/,
  );
});
