import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { DATASF_CALLS_URL } from './datasf.js';
import { parseChpIncidents } from './chp.js';
import { LAFD_ALERTS_URL, lafdAddress, parseLafdAlerts } from './lafd.js';

const fixture = (name) =>
  fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('CHP CAD logs parse whether the attribute is written ID="…" or ID = "…"', () => {
  const spaced = fixture('chp-sample.xml');
  assert.match(spaced, /ID = "/, 'the live feed spaces the attribute');
  const rows = parseChpIncidents(spaced, { onlyRegions: false });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].lat > 32 && rows[0].lat < 42, 'California latitude');
  assert.ok(rows[0].lon < -114, 'western hemisphere longitude');
  const tight = spaced.replace(/ID = "/g, 'ID="');
  assert.equal(parseChpIncidents(tight, { onlyRegions: false }).length, 1);
});

test('LAFD items with anchor-wrapped titles yield a clean title, the alert page and the address', () => {
  const alerts = parseLafdAlerts(fixture('lafd-sample.xml'));
  assert.equal(alerts.length, 1);
  const [alert] = alerts;
  assert.doesNotMatch(alert.title, /</);
  assert.match(alert.url, /^https:\/\/lafd\.org\/alert\//);
  assert.ok(alert.address, 'address found');
  assert.ok(Number.isFinite(alert.time), 'pubDate parsed');
});

test('LAFD street abbreviations are recognised', () => {
  assert.equal(
    lafdAddress('Structure Fire; 7930 N Whitsett Av; Sun Valley'),
    '7930 N Whitsett Av',
  );
  assert.equal(
    lafdAddress('Rescue; 9900 N Reseda Bl; Northridge'),
    '9900 N Reseda Bl',
  );
  assert.equal(lafdAddress('Fire; 22719 W Lull St'), '22719 W Lull St');
});

test('feed addresses point at the hosts that answer today', () => {
  assert.equal(new URL(LAFD_ALERTS_URL).host, 'lafd.org');
  assert.equal(new URL(DATASF_CALLS_URL).host, 'data.sf.gov');
});

test('LAFD long-form Pacific pubDates convert to UTC', async () => {
  const { lafdTime } = await import('./lafd.js');
  // 1 November 2026 09:23 Pacific is standard time (DST ended at 02:00 that
  // morning), so 17:23 UTC.
  assert.equal(
    lafdTime('Sunday, November 1, 2026 - 09:23'),
    Date.UTC(2026, 10, 1, 17, 23),
  );
  assert.equal(
    lafdTime('Sat, 01 Nov 2026 08:49:00 -0700'),
    Date.UTC(2026, 10, 1, 15, 49),
  );
  assert.equal(lafdTime('yesterday'), null);
});
