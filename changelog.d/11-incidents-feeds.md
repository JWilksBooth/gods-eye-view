- Live Incidents: the three feeds that had gone quiet are back. CHP CAD logs
  parse again (the live XML writes `ID = "…"` with spaces, which the parser
  refused, so every region showed zero CHP incidents), DataSF dispatched calls
  follow the dataset to its new `data.sf.gov` host, and LAFD alerts read the
  moved `lafd.org/alerts-rss.xml` feed, including its anchor-wrapped titles,
  abbreviated street types (`Av`, `Bl`, `Wy`) and long-form Pacific times
  (JWilksBooth, #11).
