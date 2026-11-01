import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lafdGeocodeQuery,
  lafdMapLink,
  parseMapsPoint,
  placeLafdAlerts,
} from './lafd.js';

test('the geocoder query drops the quadrant letter and spells out the street type', () => {
  assert.equal(lafdGeocodeQuery('7930 N Whitsett Av'), '7930 Whitsett Avenue');
  assert.equal(lafdGeocodeQuery('9900 N Reseda Bl'), '9900 Reseda Boulevard');
  assert.equal(lafdGeocodeQuery('22719 W Lull St'), '22719 Lull Street');
  assert.equal(
    lafdGeocodeQuery('Hollywood Fwy at Vermont Ave'),
    'Hollywood Fwy at Vermont Avenue',
  );
});

test('the MAP short link is read from the alert body', () => {
  assert.equal(
    lafdMapLink('MAP: <a href="https://bit.ly/4ijuk7j">x</a>; Sun Valley'),
    'https://bit.ly/4ijuk7j',
  );
  assert.equal(lafdMapLink('no link here'), null);
});

test('coordinates come only from a Google Maps redirect target', () => {
  assert.deepEqual(
    parseMapsPoint(
      'https://www.google.com/maps/search/?api=1&query=34.21477,-118.40508',
    ),
    { lat: 34.21477, lon: -118.40508 },
  );
  assert.deepEqual(
    parseMapsPoint('https://www.google.com/maps/@34.25,-118.53,15z'),
    { lat: 34.25, lon: -118.53 },
  );
  assert.equal(parseMapsPoint('https://evil.example/?query=34.2,-118.4'), null);
  assert.equal(
    parseMapsPoint('https://www.google.com/maps/search/?api=1&query=Reseda'),
    null,
  );
  assert.equal(parseMapsPoint(null), null);
});

test('placement uses the map link first and the geocoder only as a fallback', async () => {
  const now = Date.now();
  const alerts = [
    {
      id: 'a',
      title: 'Structure Fire',
      body: 'x',
      time: now,
      url: 'u',
      address: '7930 N Whitsett Av',
      mapLink: 'https://bit.ly/4ijuk7j',
    },
    {
      id: 'b',
      title: 'Rescue',
      body: 'y',
      time: now,
      url: 'u',
      address: '9900 N Reseda Bl',
      mapLink: null,
    },
    {
      id: 'c',
      title: 'Brush Fire',
      body: 'z',
      time: now,
      url: 'u',
      address: '1 Main St',
      mapLink: 'https://bit.ly/elsewhere',
    },
  ];
  const geocoded = [];
  const rows = await placeLafdAlerts(alerts, {
    now: () => now,
    resolveLink: async (link) => {
      if (link === 'https://bit.ly/4ijuk7j')
        return { lat: 34.21477, lon: -118.40508 };
      // A link that points outside Los Angeles is ignored.
      if (link === 'https://bit.ly/elsewhere') return { lat: 40.7, lon: -74 };
      return null;
    },
    geocode: async (address) => {
      geocoded.push(address);
      return { lat: 34.2508, lon: -118.536 };
    },
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    geocoded,
    ['9900 N Reseda Bl', '1 Main St'],
    'the link-placed alert never hits the geocoder',
  );
  assert.equal(rows[0].lat, 34.21477);
  assert.equal(rows[0].lon, -118.40508);
});
