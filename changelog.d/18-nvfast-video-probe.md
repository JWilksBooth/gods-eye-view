- CCTV: the RTC FAST Dashboard pack decides at each catalog load whether to
  register the NDOT live streams about a quarter of its rows name. It asks up
  to six of those playlists, spread across NDOT's hosts, and registers video
  for every row that names one (the still stays the snapshot fallback) when
  at least one answers, so the Las Vegas cameras show LIVE badges on the days
  NDOT's streams are up without an env change, and stay stills with one log
  line on the days they are not. `CCTV_NVFAST_VIDEO=1` still forces video,
  `0` forces stills (JWilksBooth, #18).
