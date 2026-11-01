import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALERTS_OVERLAY_COHORT_LIMIT,
  buildAlertCard,
  buildBulletinCard,
  createAlertOverlayEntry,
  labelHeadline,
  relativeTime,
  selectAlertOverlayCohort,
  sourceHost,
} from './cards.js';
import { createAlert } from './model.js';
import { alertRegion } from './regions.js';

const NOW = Date.parse('2026-11-01T17:00:00Z');

const closure = createAlert(
  {
    id: 'caltrans:4:C1:1',
    source: 'caltrans',
    kind: 'road',
    severity: 'moderate',
    agency: 'Caltrans District 4',
    headline: 'US-101 North · Full closure',
    body: 'Paving · 3 of 3 lanes closed · In effect',
    area: { type: 'Point', coordinates: [-122.4, 37.78] },
    areaDescription: 'Main St → Market St',
    regions: ['sf-bay-area'],
    issued: NOW - 2 * 3_600_000,
    starts: NOW - 2 * 3_600_000,
    ends: NOW + 3_600_000,
    url: 'https://lcswebreports.dot.ca.gov/searchdistricts?district=4',
  },
  { fetchedAt: NOW },
);

test('the alert card shows headline, agency, severity, time and source', () => {
  const card = buildAlertCard(closure, NOW, {
    accent: '#123456',
    link: closure.url,
  });
  assert.equal(card.id, 'alert-card:caltrans:4:C1:1');
  assert.equal(card.title, 'US-101 North · Full closure');
  assert.equal(card.details[0], 'Caltrans District 4 · Moderate');
  assert.equal(card.details[1], 'Roads · Main St → Market St');
  assert.match(card.details[2], /^Issued 2 hours ago · Until \d{1,2}:\d{2}/);
  assert.equal(card.details[3], 'Paving · 3 of 3 lanes closed · In effect');
  assert.equal(
    card.details.at(-1),
    'lcswebreports.dot.ca.gov ↗ · Click card to open the source',
  );
  assert.equal(card.interactive, true);
  assert.equal(
    card.accessibilityLabel,
    'Open US-101 North · Full closure at its source',
  );
  assert.equal(
    card.accent,
    '#123456',
    'the accent is whatever the theme resolved',
  );
  const later = buildAlertCard(
    {
      ...closure,
      starts: new Date(NOW + 3 * 3_600_000).toISOString(),
      issued: null,
      freshness: 'stale',
      areaSource: 'centroid',
      url: null,
    },
    NOW,
  );
  assert.match(later.details.join('\n'), /Starts in 3 hours/);
  assert.match(later.details.join('\n'), /Placed at the county centre/);
  assert.match(later.details.join('\n'), /Feed copy may be stale/);
  assert.doesNotMatch(later.details.join('\n'), /Click card/);
  assert.equal(later.interactive, false);
});

test('a region bulletin card lists the worst bulletins first', () => {
  const region = alertRegion('sf-bay-area');
  const bulletins = Array.from({ length: 8 }, (_, index) =>
    createAlert(
      {
        id: `bart:${index}`,
        source: 'bart',
        kind: 'transit',
        severity: index === 5 ? 'severe' : 'minor',
        agency: 'BART',
        headline: `Advisory ${index}`,
        regions: ['sf-bay-area'],
        issued: NOW - 30 * 60_000,
        url: 'https://www.bart.gov/schedules/advisories',
      },
      { fetchedAt: NOW },
    ),
  );
  const card = buildBulletinCard(region, bulletins, NOW, {
    link: 'https://www.bart.gov/schedules/advisories',
  });
  assert.equal(card.title, 'San Francisco Bay Area · 8 bulletins');
  assert.equal(card.details[0], 'Advisory 5 · BART · 30 minutes ago');
  assert.equal(card.details[6], '2 more bulletins');
  assert.equal(
    card.details.at(-1),
    'bart.gov ↗ · Click card to open the source',
  );
  const single = buildBulletinCard(region, bulletins.slice(0, 1), NOW);
  assert.equal(single.title, 'San Francisco Bay Area · 1 bulletin');
  assert.equal(single.interactive, false);
});

test('labels favour worse, newer alerts and stay short', () => {
  const entry = createAlertOverlayEntry({
    id: closure.id,
    position: { x: 1, y: 2, z: 3 },
    alert: closure,
    accent: '#abcdef',
  });
  assert.equal(entry.variant, 'label');
  assert.equal(entry.interactive, false);
  assert.ok(entry.priority > 2_000_000 && entry.priority < 3_000_000);
  assert.equal(
    labelHeadline({
      headline: 'A very long headline that keeps going past the label',
    }).length,
    34,
  );
  const many = Array.from({ length: 80 }, (_, index) => ({
    id: `e${index}`,
    priority: index,
  }));
  const kept = selectAlertOverlayCohort(many);
  assert.equal(kept.length, ALERTS_OVERLAY_COHORT_LIMIT);
  assert.equal(kept[0].id, 'e79');
  assert.deepEqual(selectAlertOverlayCohort(many, 0), []);
  assert.equal(sourceHost('https://www.weather.gov/lox/'), 'weather.gov');
  assert.equal(sourceHost('not a url'), null);
  assert.equal(relativeTime(NOW - 90 * 60_000, NOW), '2 hours ago');
  assert.equal(relativeTime(NOW + 3 * 86_400_000, NOW), 'in 3 days');
  assert.equal(relativeTime(Number.NaN, NOW), null);
});
