- Cameras: the LIVE badge in the CAMERAS panel now means the camera's stream
  answered recently, not that the catalog lists a stream URL. The camera
  proxy keeps per-camera stream health in memory (last success, last
  failure, failure count; bounded, nothing on disk), learned from the HLS
  leases it pulls and from a bounded probe of playlists: eight per
  video-capable provider when the catalog loads, then the cameras the panel
  lists whose verdict is unknown, never a camera with a fresh verdict
  (`CCTV_STREAM_PROBE=0` turns both off). `GET /api/cctv/health` carries the
  record as `streams`. NEWEST lists streams seen answering first (LIVE), then
  unchecked ones (LIVE?), then stills and streams that failed in the last ten
  minutes (STREAM DOWN) by frame freshness; the camera wall never hovers,
  pins or spends a proxy session on a stream known to be down, and a play
  that works clears the failure (JWilksBooth, #17).
