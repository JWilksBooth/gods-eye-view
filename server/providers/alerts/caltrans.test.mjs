import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CALTRANS_REQUIRED_COLUMNS,
  caltransAlertsFromCsv,
  caltransLcsUrl,
  closureInEffect,
  createCaltransFeedSource,
} from './caltrans.js';
import { parseCsvRecords, parseCsvRows } from './csv.js';

const NOW = Date.parse('2026-11-01T17:00:00Z');
const at = (minutes) => String(Math.round((NOW + minutes * 60_000) / 1000));

// The district file's header, as cwwp2.dot.ca.gov publishes it.
const HEADER =
  'index,recordDate,recordTime,recordEpoch,travelFlowDirection,beginDistrict,beginLocationName,beginFreeFormDescription,beginNearbyPlace,beginLongitude,beginLatitude,beginElevation,beginDirection,beginCounty,beginRoute,beginRouteSuffix,beginPostmilePrefix,beginPostmile,beginAlignment,beginMilepost,endDistrict,endLocationName,endFreeFormDescription,endNearbyPlace,endLongitude,endLatitude,endElevation,endDirection,endCounty,endRoute,endRouteSuffix,endPostmilePrefix,endPostmile,endAlignment,endMilepost,closureID,logNumber,closureRequestDate,closureRequestTime,closureRequestEpoch,closureStartDate,closureStartTime,closureStartEpoch,closureEndDate,closureEndTime,closureEndEpoch,isClosureEndIndefinite,facility,typeOfClosure,typeOfWork,durationOfClosure,estimatedDelay,lanesClosed,totalExistingLanes,isCHINReportable,isCode1097,code1097Date,code1097Time,code1097Epoch,isCode1098,code1098Date,code1098Time,code1098Epoch,isCode1022,code1022Date,code1022Time,code1022Epoch';
const COLUMNS = HEADER.split(',');

const quote = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function row(fields) {
  const record = {
    recordEpoch: at(-5),
    travelFlowDirection: 'East',
    beginDistrict: '7',
    beginLocationName: 'Main St',
    beginLongitude: '-118.25',
    beginLatitude: '34.05',
    beginRoute: 'I-10',
    endLocationName: 'Alameda St',
    closureID: 'C1',
    logNumber: '1',
    closureStartEpoch: at(-60),
    closureEndEpoch: at(120),
    isClosureEndIndefinite: 'false',
    facility: 'Freeway',
    typeOfClosure: 'Full',
    typeOfWork: 'Paving',
    durationOfClosure: 'Standard',
    estimatedDelay: '10',
    lanesClosed: '3',
    totalExistingLanes: '3',
    isCode1097: 'true',
    code1097Epoch: at(-55),
    isCode1098: 'false',
    isCode1022: 'false',
    ...fields,
  };
  return COLUMNS.map((name) => quote(record[name])).join(',');
}

const CSV = [
  HEADER,
  row({ closureID: 'IN-EFFECT' }),
  row({ closureID: 'LIFTED', isCode1098: 'true' }),
  row({ closureID: 'CANCELLED', isCode1022: 'true' }),
  row({
    closureID: 'SOON',
    isCode1097: 'false',
    closureStartEpoch: at(30),
    closureEndEpoch: at(300),
    typeOfClosure: 'Lane',
    lanesClosed: '1',
    totalExistingLanes: '4',
    estimatedDelay: 'Not Reported',
  }),
  row({
    closureID: 'LATER',
    isCode1097: 'false',
    closureStartEpoch: at(180),
    closureEndEpoch: at(400),
  }),
  row({ closureID: 'ENDED', closureEndEpoch: at(-1) }),
  row({
    closureID: 'ELSEWHERE',
    beginLongitude: '-119.8',
    beginLatitude: '36.7',
  }),
  row({
    closureID: 'QUOTED',
    beginDistrict: '4',
    beginLongitude: '-122.40',
    beginLatitude: '37.78',
    beginRoute: 'US-101',
    travelFlowDirection: 'N/A',
    beginLocationName: '"B" Street, North',
    endLocationName: '',
    typeOfClosure: 'One-Way Traffic',
    typeOfWork: 'Bridge\nwork',
  }),
  row({
    closureID: 'INDEFINITE',
    isClosureEndIndefinite: 'true',
    closureEndEpoch: at(-600),
  }),
  '',
].join('\r\n');

test('the CSV reader handles quotes, doubled quotes, line breaks and CRLF', () => {
  assert.deepEqual(
    parseCsvRows('a,b\r\n"x, y","say ""hi"""\n"multi\nline",\n'),
    [
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', ''],
    ],
  );
  assert.deepEqual(parseCsvRows('﻿a\nb'), [['a'], ['b']]);
  const { header, records } = parseCsvRecords('x,y\n1\n\n2,3\n');
  assert.deepEqual(header, ['x', 'y']);
  assert.deepEqual(records, [
    { x: '1', y: '' },
    { x: '2', y: '3' },
  ]);
});

test('a closure is in effect from 10-97 until it is lifted or cancelled', () => {
  assert.equal(
    closureInEffect({ isCode1097: 'true', isCode1098: 'false' }),
    true,
  );
  assert.equal(
    closureInEffect({ isCode1097: 'true', isCode1098: 'true' }),
    false,
  );
  assert.equal(
    closureInEffect({ isCode1097: 'true', isCode1022: 'true' }),
    false,
  );
  assert.equal(closureInEffect({ isCode1097: 'false' }), false);
});

test('closures in effect or starting within the hour become road alerts', () => {
  const alerts = caltransAlertsFromCsv(CSV, { district: 7, now: NOW });
  const ids = alerts.map((alert) => alert.id.split(':')[2]);
  assert.deepEqual(ids, ['IN-EFFECT', 'SOON', 'QUOTED', 'INDEFINITE']);
  const [inEffect, soon, quoted, indefinite] = alerts;
  assert.equal(inEffect.kind, 'road');
  assert.equal(inEffect.severity, 'moderate');
  assert.equal(inEffect.agency, 'Caltrans District 7');
  assert.equal(inEffect.headline, 'I-10 East · Full closure');
  assert.equal(
    inEffect.body,
    'Paving · 3 of 3 lanes closed · Estimated delay 10 min · Freeway · Standard · In effect',
  );
  assert.equal(inEffect.areaDescription, 'Main St → Alameda St');
  assert.deepEqual(inEffect.regions, ['los-angeles']);
  assert.deepEqual(inEffect.area, {
    type: 'Point',
    coordinates: [-118.25, 34.05],
  });
  assert.equal(inEffect.ends, new Date(Number(at(120)) * 1000).toISOString());
  assert.equal(
    inEffect.url,
    'https://lcswebreports.dot.ca.gov/searchdistricts?district=7',
  );
  assert.equal(soon.severity, 'minor');
  assert.match(soon.body, /1 of 4 lanes closed/);
  assert.doesNotMatch(soon.body, /delay/i);
  assert.match(soon.body, /Scheduled$/);
  assert.equal(quoted.headline, 'US-101 · One-Way Traffic closure');
  assert.equal(quoted.areaDescription, '"B" Street, North');
  assert.deepEqual(quoted.regions, ['sf-bay-area']);
  assert.equal(indefinite.ends, null);
});

test('a file without the closure columns is refused', () => {
  assert.throws(
    () => caltransAlertsFromCsv('a,b\n1,2\n', { district: 4 }),
    (error) => error.code === 'invalid_payload',
  );
  assert.ok(CALTRANS_REQUIRED_COLUMNS.every((name) => COLUMNS.includes(name)));
});

test('the feed reads every district file and reports a partial load', async () => {
  const asked = [];
  const source = createCaltransFeedSource({
    districts: [4, 7],
    now: () => NOW,
    fetchImpl: async (url) => {
      asked.push(String(url));
      if (String(url).includes('/d4/'))
        return new Response('gone', { status: 404 });
      return new Response(CSV, { headers: { 'content-type': 'text/csv' } });
    },
  });
  const loaded = await source.load();
  assert.deepEqual(asked, [caltransLcsUrl(4), caltransLcsUrl(7)]);
  assert.equal(
    caltransLcsUrl(7),
    'https://cwwp2.dot.ca.gov/data/d7/lcs/lcsStatusD07.csv',
  );
  assert.equal(loaded.partial, true);
  assert.equal(loaded.alerts.length, 4);
  const down = createCaltransFeedSource({
    districts: [4],
    fetchImpl: async () => new Response('gone', { status: 404 }),
  });
  await assert.rejects(down.load(), (error) => error.status === 404);
});
