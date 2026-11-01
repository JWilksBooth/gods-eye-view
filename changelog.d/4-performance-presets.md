- Add a PERFORMANCE row to Display with Quality, Balanced and Performance
  presets that set resolution scale, anti-aliasing, the frame-rate cap, the
  sharpen pass, detection density, layer update cadence and photoreal tile
  detail; Balanced is the default and the choice is remembered in this
  browser, never in a share link. Grounded 3D aircraft, the mesh-floor cells
  and the camera ground guard now read the rendered surface on the CPU
  instead of through a pick render that stalled the GPU on every sample: with
  Flights, Vessels and CCTV on, the layers no longer issue any GPU read-backs
  (JWilksBooth, #4).
