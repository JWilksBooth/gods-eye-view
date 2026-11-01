- Make the Display → PERFORMANCE presets set sharpness as well as cost.
  Each preset now sizes the drawing buffer in device pixels: Quality draws
  every pixel (at most two per CSS pixel, clamped to the GPU's texture
  limit), Balanced three quarters of them but never fewer than the screen's,
  Performance half with a three-quarter floor. Imagery and photoreal tiles
  follow (globe screen-space error 1 / 1.5 / 2, tile cache 600 / 300 / 100,
  anisotropic filtering 16× / 8× / 4×, Google 3D tiles error 12 / 16 / 24),
  and a readout under the row names the buffer actually drawn, such as
  `1600 × 900 px · MSAA 2×`. Performance withholds the sharpen pass instead
  of switching the Sharpen toggle off, `?quality=<preset>` picks a preset for
  one page load, and a software renderer starts on Performance. OSM stops at
  zoom 19, and ion world terrain no longer downloads vertex normals nothing
  lights (JWilksBooth).
