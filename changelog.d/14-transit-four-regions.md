- Transit: live GTFS-Realtime vehicles for the four LIVE OPS regions. OCTA
  (Orange County) and MVgo (Mountain View) are keyless; the 511 SF Bay regional
  feed (every Bay Area and Sonoma County operator, BART included, one load every
  80 s to stay inside the token's sixty an hour), LA Metro bus and rail and RTC
  Southern Nevada through Swiftly, and Metrolink read optional keys
  (`BAY_AREA_511_API_KEY`, `SWIFTLY_API_KEY`, `METROLINK_API_KEY`) that never
  leave the server; without one the layer row reads "needs a key" and the
  operator is never asked. A LIVE OPS region button turns Transit on with its
  other layers, Provider Settings shows the three keys, and the RTC alerts feed
  moves to Swiftly's `las-vegas-rtc` agency key (JWilksBooth, #14).
