- CCTV: Caltrans cameras that publish a live stream on Caltrans' own media
  host (`wzmedia.dot.ca.gov`, about 200 of District 4's cameras and more in
  District 7) now play as live HLS video through the bounded stream proxy, with
  the still frame kept as the snapshot fallback; the rest stay stills.
  `CCTV_CALTRANS_VIDEO=0` returns every Caltrans camera to stills
  (JWilksBooth, #10).
