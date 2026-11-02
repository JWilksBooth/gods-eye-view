import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SF511_AGENCY_NAMES,
  SF511_OPERATORS,
  sf511RouteLabel,
  sf511RouteMode,
  splitSf511Id,
} from './sf511Operators.js';

test('the operator table is frozen, two-character keyed, and names every entry', () => {
  assert.ok(Object.isFrozen(SF511_OPERATORS));
  for (const [id, entry] of Object.entries(SF511_OPERATORS)) {
    assert.match(id, /^[A-Z0-9]{2}$/, `${id} is a 511 operator id`);
    assert.ok(entry.name && entry.short, `${id} is named`);
    assert.ok(
      ['bus', 'tram', 'subway', 'rail', 'ferry'].includes(entry.mode),
      `${id} has a known mode`,
    );
    assert.equal(SF511_AGENCY_NAMES[id], entry.name);
  }
  assert.equal(SF511_AGENCY_NAMES.SF, 'San Francisco Muni');
  assert.equal(SF511_AGENCY_NAMES.BA, 'BART');
});

test('regional ids split on a known operator prefix and survive unknown ones whole', () => {
  assert.deepEqual(splitSf511Id('SF:14'), { operator: 'SF', local: '14' });
  assert.deepEqual(splitSf511Id('ba:Yellow-N'), {
    operator: 'BA',
    local: 'Yellow-N',
  });
  assert.deepEqual(splitSf511Id('3D:380'), { operator: '3D', local: '380' });
  // An unknown prefix, a bare id and a blank are never mangled.
  assert.deepEqual(splitSf511Id('ZZ:1'), { operator: null, local: 'ZZ:1' });
  assert.deepEqual(splitSf511Id('14'), { operator: null, local: '14' });
  assert.deepEqual(splitSf511Id(null), { operator: null, local: '' });
});

test('the operator settles the mode: BART is a subway, trains are trains, ferries float', () => {
  assert.equal(sf511RouteMode('BA:Yellow-N'), 'subway');
  assert.equal(sf511RouteMode('CT:Local'), 'rail');
  assert.equal(sf511RouteMode('SA:SMART'), 'rail');
  assert.equal(sf511RouteMode('AM:CC'), 'rail');
  assert.equal(sf511RouteMode('GF:Larkspur'), 'ferry');
  assert.equal(sf511RouteMode('SB:Alameda'), 'ferry');
  assert.equal(sf511RouteMode('AC:51A'), 'bus');
  assert.equal(sf511RouteMode('SC:60'), 'bus');
  // Muni rail and cable cars are trams; Muni buses are buses.
  assert.equal(sf511RouteMode('SF:N'), 'tram');
  assert.equal(sf511RouteMode('SF:KT'), 'tram');
  assert.equal(sf511RouteMode('SF:F'), 'tram');
  assert.equal(sf511RouteMode('SF:59'), 'tram');
  assert.equal(sf511RouteMode('SF:14R'), 'bus');
  // VTA light rail by line colour or 900-series id; the rest are buses.
  assert.equal(sf511RouteMode('VT:Blue'), 'tram');
  assert.equal(sf511RouteMode('VT:902'), 'tram');
  assert.equal(sf511RouteMode('VT:22'), 'bus');
  // No prefix, no claim: the feed default applies, unresolved.
  assert.equal(sf511RouteMode('14'), 'unknown');
  assert.equal(sf511RouteMode(null), 'unknown');
});

test('labels lead with the operator a rider would name', () => {
  assert.equal(sf511RouteLabel('SF:14'), 'Muni 14');
  assert.equal(sf511RouteLabel('BA:Yellow-N'), 'BART Yellow-N');
  assert.equal(sf511RouteLabel('SR:1'), 'Santa Rosa CityBus 1');
  assert.equal(sf511RouteLabel('14'), '14');
  assert.equal(sf511RouteLabel(null), null);
});
