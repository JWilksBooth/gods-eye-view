/**
 * Rendered-surface height without a GPU pick.
 *
 * `scene.sampleHeight` answers by rendering the scene again into an offscreen
 * pick buffer along a vertical ray and reading the pixels back, which stalls
 * the GPU pipeline until that render finishes. Profiled on the 2026-11-01
 * perf pass, the aircraft ground snap alone (one sample per grounded modeled
 * plane, up to 16 a second at a busy airport) put 97% of the main thread's
 * time inside `readPixels` with Flights, Vessels and CCTV on, and each sample
 * cost a whole extra scene render on the GPU.
 *
 * `scene.getHeight` answers the same question on the CPU: a ray test against
 * the loaded terrain tiles and against every 3D Tiles tileset that has
 * `enableCollision` (the photoreal globe does — it is what the camera's own
 * ground collision uses every frame). No render, no pixel read-back. It
 * returns `undefined` where nothing is loaded yet, which is the same "try
 * again later" every caller already handled for a pick miss.
 *
 * The pick render is kept only for a scene that has no CPU path at all —
 * scenes built by tests, or a Cesium older than the one the app ships.
 */

/**
 * Height of the rendered surface at a cartographic position, or undefined
 * when no loaded geometry covers it.
 * @param {object} scene Cesium scene (or a stand-in).
 * @param {object} cartographic Cesium.Cartographic.
 * @param {{excludeObjects?: Array<unknown>}} [options] Objects the pick-render
 *   fallback must not hit; the CPU path never hits billboards or models.
 * @returns {number|undefined}
 */
export function sampleRenderedSurfaceHeight(
  scene,
  cartographic,
  { excludeObjects } = {},
) {
  if (!scene || !cartographic) return undefined;
  if (typeof scene.getHeight === 'function') {
    let height;
    try {
      height = scene.getHeight(cartographic);
    } catch {
      return undefined;
    }
    return Number.isFinite(height) ? height : undefined;
  }
  if (typeof scene.sampleHeight === 'function') {
    let height;
    try {
      height = scene.sampleHeight(cartographic, excludeObjects);
    } catch {
      return undefined;
    }
    return Number.isFinite(height) ? height : undefined;
  }
  return undefined;
}

/** Whether a scene can answer surface heights at all. */
export function surfaceHeightSupported(scene) {
  return (
    typeof scene?.getHeight === 'function' ||
    typeof scene?.sampleHeight === 'function'
  );
}
