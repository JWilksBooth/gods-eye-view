import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetPerformancePresetForTest,
  installPerformancePreset,
  setPerformancePreset,
} from '../performancePreset.js';
import { VisualEffects } from './visualEffects.js';

function classList() {
  const names = new Set();
  return {
    toggle(name, force) {
      if (force ?? !names.has(name)) names.add(name);
      else names.delete(name);
    },
    contains: (name) => names.has(name),
  };
}

/** A viewer whose resize sizes the canvas the way CesiumWidget does. */
function fakeViewer({ clientWidth = 1600, clientHeight = 900, dpr = 1 } = {}) {
  const canvas = {
    clientWidth,
    clientHeight,
    width: clientWidth,
    height: clientHeight,
  };
  const viewer = {
    canvas,
    useBrowserRecommendedResolution: true,
    resolutionScale: 1,
    targetFrameRate: 60,
    scene: {
      msaaSamples: 4,
      postProcessStages: { fxaa: { enabled: false }, remove() {} },
      globe: { maximumScreenSpaceError: 2, tileCacheSize: 100 },
    },
  };
  viewer.cesiumWidget = {
    resize() {
      const ratio =
        (viewer.useBrowserRecommendedResolution ? 1 : dpr) *
        viewer.resolutionScale;
      canvas.width = Math.floor(canvas.clientWidth * ratio);
      canvas.height = Math.floor(canvas.clientHeight * ratio);
    },
  };
  return viewer;
}

test.beforeEach(() => _resetPerformancePresetForTest());
test.after(() => _resetPerformancePresetForTest());

test('the readout names the drawing buffer and the anti-aliasing pass on it', async () => {
  const { formatDrawingBufferReadout } = await import('./visualSettings.js');
  assert.equal(
    formatDrawingBufferReadout({ width: 1600, height: 900, msaaSamples: 2 }),
    '1600 × 900 px · MSAA 2×',
  );
  assert.equal(
    formatDrawingBufferReadout({
      width: 1200,
      height: 675,
      msaaSamples: 1,
      fxaa: true,
    }),
    '1200 × 675 px · FXAA',
  );
  assert.equal(
    formatDrawingBufferReadout({ width: 3200, height: 1800, msaaSamples: 1 }),
    '3200 × 1800 px',
  );
  assert.equal(formatDrawingBufferReadout({ width: 0, height: 900 }), '');
  assert.equal(formatDrawingBufferReadout(), '');
});

test('the sharpen gate withholds the stage without touching the toggle or the slider value', () => {
  const requests = [];
  const effects = new VisualEffects({
    viewer: { scene: { postProcessStages: { remove() {} } } },
    requestRender: (reason) => requests.push(reason),
    holdRender() {},
    releaseRender() {},
  });
  const stage = { enabled: false, uniforms: {} };
  effects.sharpenStage = stage;
  effects.setSharpenEnabled(true);
  effects.applySharpenIntensity(0.49);
  assert.equal(stage.enabled, true);
  requests.length = 0;
  effects.setSharpenPermitted(false);
  assert.equal(stage.enabled, false);
  assert.equal(effects.sharpenEnabled, true);
  assert.equal(effects.sharpenIntensity, 0.49);
  assert.deepEqual(requests, ['sharpen']);
  // Repeating the same permission is free; the operator can still change the
  // toggle and slider meanwhile, and nothing runs until it is permitted.
  effects.setSharpenPermitted(false);
  assert.deepEqual(requests, ['sharpen']);
  effects.applySharpenIntensity(0.8);
  assert.equal(stage.enabled, false);
  effects.setSharpenPermitted(true);
  assert.equal(stage.enabled, true);
  assert.equal(stage.uniforms.amount, 0.1 + 0.8 * 2);
  effects.setSharpenEnabled(false);
  effects.setSharpenPermitted(true);
  assert.equal(stage.enabled, false, 'permission never turns sharpen on');
});

test('Display follows the preset: readout, sharpen withheld in Performance and restored on return', async (t) => {
  const { VisualSettings } = await import('./visualSettings.js');
  const status = { textContent: '' };
  const priorDocument = globalThis.document;
  globalThis.document = {
    documentElement: { dataset: {} },
    getElementById: (id) =>
      id === 'performance-preset-status' ? status : null,
    querySelectorAll: () => [],
  };
  t.after(() => {
    globalThis.document = priorDocument;
  });
  const viewer = fakeViewer();
  const preset = installPerformancePreset(viewer, {
    renderer: 'ANGLE (NVIDIA GeForce RTX 3070)',
    getDevicePixelRatio: () => 1,
  });
  const button = {
    disabled: false,
    title: 'Sharpening',
    classList: classList(),
  };
  const slider = { disabled: false, value: '49' };
  const shares = [];
  const owner = new VisualSettings({
    viewer,
    elements: { _sharpenBtn: button, _sharpenSlider: slider },
    operations: {
      _syncShareState: () => shares.push(true),
      _layoutRightPanels() {},
    },
    services: {
      governorRequestRender() {},
      holdContinuousRender() {},
      releaseContinuousRender() {},
    },
  });
  const stage = { enabled: false, uniforms: {} };
  owner._visualEffects.sharpenStage = stage;
  owner._visualEffects.setSharpenEnabled(true);
  owner._visualEffects.applySharpenIntensity(0.49);
  // The first-load baseline hands over to the preset's visual half.
  owner._applyPerformancePresetVisuals();
  viewer.cesiumWidget.resize();
  assert.equal(owner.getPerformancePreset(), 'balanced');
  assert.equal(status.textContent, '1600 × 900 px · MSAA 2×');
  assert.equal(stage.enabled, true);
  assert.equal(button.disabled, false);

  // Another owner (a voice tool, the QA harness) switches the module.
  setPerformancePreset('performance');
  viewer.cesiumWidget.resize();
  assert.equal(status.textContent, '1200 × 675 px · FXAA');
  assert.equal(stage.enabled, false);
  assert.equal(owner.sharpenPermitted, false);
  assert.equal(owner.sharpenEnabled, true, 'the operator toggle is untouched');
  assert.equal(button.disabled, true);
  assert.equal(button.classList.contains('pp-toggle-btn--withheld'), true);
  assert.equal(button.title, 'Sharpening is off in the Performance preset');
  assert.equal(slider.disabled, true);
  assert.equal(slider.value, '49');

  assert.equal(owner.setPerformancePreset('quality', { persist: false }), true);
  viewer.cesiumWidget.resize();
  assert.equal(status.textContent, '1600 × 900 px · MSAA 4×');
  assert.equal(stage.enabled, true);
  assert.equal(button.disabled, false);
  assert.equal(button.title, 'Sharpening');
  assert.equal(slider.disabled, false);
  assert.ok(shares.length >= 3, 'each change refreshes the share state');

  owner.destroy();
  setPerformancePreset('performance');
  assert.equal(status.textContent, '1600 × 900 px · MSAA 4×', 'unsubscribed');
  preset.uninstall();
});
