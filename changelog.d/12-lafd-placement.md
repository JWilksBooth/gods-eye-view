- Live Incidents: LAFD alerts are placed from the map link each alert carries
  (one HEAD request to the feed's own short link, reading only the redirect
  target, which names exact coordinates), with the geocoder as the fallback;
  the geocoder query now drops the City's quadrant letter and spells out the
  street type, which is what the map data uses (JWilksBooth, #12).
