- Alerts: a new layer of official alerts for the LIVE OPS regions (Los
  Angeles, Sonoma County, the San Francisco Bay Area and Las Vegas) through
  `/api/alerts`: NWS warnings and advisories on their zone shapes, CAL FIRE
  incidents, Caltrans lane closures, FAA airport closures, stops and delays,
  AirNow air quality (`AIRNOW_API_KEY`), BART, 511 SF Bay and Swiftly transit
  alerts and Cal OES, County of Sonoma and LAFD bulletins. Each feed is cached,
  budgeted and served stale on its own; colours come from the theme's
  `--alert-severity-*` tokens; a click opens the alert's card and its source.
  `get_alerts` and `get_airport_status` join the MCP and voice tools
  (JWilksBooth, #6).
