import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAA_NAS_STATUS_URL,
  createFaaFeedSource,
  describeAirportEvent,
  faaAlerts,
  isPartialClosure,
  parseFaaAirportStatus,
} from './faa.js';

// The FAA AirportStatus document, one section of each kind.
const XML = `<AIRPORT_STATUS_INFORMATION><Update_Time>Sun Nov 1 17:20:25 2026 GMT</Update_Time>
<Dtd_File>http://www.fly.faa.gov/AirportStatus.dtd</Dtd_File>
<Delay_type><Name>Ground Stop Programs</Name><Ground_Stop_List>
  <Program><ARPT>SFO</ARPT><Reason>low ceilings</Reason><End_Time>10:30 am PST</End_Time></Program>
</Ground_Stop_List></Delay_type>
<Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List>
  <Ground_Delay><ARPT>SFO</ARPT><Reason>low ceilings</Reason><Avg>1 hour and 3 minutes</Avg><Max>2 hours and 18 minutes</Max></Ground_Delay>
</Ground_Delay_List></Delay_type>
<Delay_type><Name>General Arrival/Departure Delay Info</Name><Arrival_Departure_Delay_List>
  <Delay><ARPT>LAX</ARPT><Reason>TM Initiatives:MIT:VOL</Reason>
    <Arrival_Departure Type="Departure"><Min>16 minutes</Min><Max>30 minutes</Max><Trend>Increasing</Trend></Arrival_Departure>
  </Delay>
  <Delay><ARPT>ORD</ARPT><Reason>wind</Reason>
    <Arrival_Departure Type="Arrival"><Min>31 minutes</Min><Max>45 minutes</Max><Trend>Decreasing</Trend></Arrival_Departure>
  </Delay>
</Arrival_Departure_Delay_List></Delay_type>
<Delay_type><Name>Airport Closures</Name><Airport_Closure_List>
  <Airport><ARPT>LAS</ARPT><Reason>!LAS 10/160 LAS AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR</Reason><Start>Oct 28 at 19:26 UTC.</Start><Reopen>Jan 27 at 23:00 UTC.</Reopen></Airport>
  <Airport><ARPT>BUR</ARPT><Reason>!BUR 11/001 BUR AD AP CLSD</Reason><Start>Nov 01 at 15:00 UTC.</Start><Reopen>Nov 01 at 23:00 UTC.</Reopen></Airport>
</Airport_Closure_List></Delay_type>
<Delay_type><Name>Deicing</Name><Deicing_List><Arpt>DEN</Arpt></Deicing_List></Delay_type>
</AIRPORT_STATUS_INFORMATION>`;

test('every section of the status document becomes an event', () => {
  const status = parseFaaAirportStatus(XML);
  assert.equal(status.updatedAt, '2026-11-01T17:20:25.000Z');
  assert.deepEqual(
    status.events.map((event) => `${event.airport}:${event.status}`),
    [
      'SFO:ground_stop',
      'SFO:ground_delay',
      'LAX:delay',
      'ORD:delay',
      'LAS:restriction',
      'BUR:closure',
    ],
  );
  const [stop, gdp, lax] = status.events;
  assert.equal(stop.endTime, '10:30 am PST');
  assert.equal(gdp.avgDelay, '1 hour and 3 minutes');
  assert.equal(lax.type, 'Departure');
  assert.equal(lax.minDelay, '16 minutes');
  assert.equal(lax.trend, 'Increasing');
  assert.deepEqual(status.unknownSections, ['Deicing']);
  assert.throws(
    () => parseFaaAirportStatus('<html>maintenance</html>'),
    (error) => error.code === 'invalid_payload',
  );
});

test('NOTAMs that close an airport only to some traffic are restrictions', () => {
  assert.equal(
    isPartialClosure(
      'LAS AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR',
    ),
    true,
  );
  assert.equal(isPartialClosure('BUR AD AP CLSD'), false);
  assert.equal(
    describeAirportEvent({
      status: 'delay',
      type: 'Departure',
      reason: 'wind',
      minDelay: '16 minutes',
      maxDelay: '30 minutes',
      trend: 'Increasing',
    }),
    'Departure delays · wind · up to 30 minutes · trend increasing',
  );
});

test('only the regions’ airports become alerts, placed at the airport', () => {
  const status = parseFaaAirportStatus(XML);
  const alerts = faaAlerts(status, {
    fetchedAt: Date.parse('2026-11-01T17:21:00Z'),
  });
  const byId = Object.fromEntries(alerts.map((alert) => [alert.id, alert]));
  assert.deepEqual(Object.keys(byId).sort(), [
    'faa:BUR:closure:all',
    'faa:LAS:restriction:all',
    'faa:LAX:delay:Departure',
    'faa:SFO:ground_delay:all',
    'faa:SFO:ground_stop:all',
  ]);
  const stop = byId['faa:SFO:ground_stop:all'];
  assert.equal(stop.severity, 'severe');
  assert.equal(stop.headline, 'SFO · Ground stop · low ceilings');
  assert.deepEqual(stop.regions, ['sf-bay-area']);
  assert.equal(stop.areaSource, 'site');
  assert.equal(stop.areaDescription, 'San Francisco International');
  assert.equal(stop.url, 'https://nasstatus.faa.gov/');
  const restriction = byId['faa:LAS:restriction:all'];
  assert.equal(restriction.severity, 'minor');
  assert.equal(restriction.headline, 'LAS · Airport restriction');
  assert.match(restriction.body, /CLSD TO NON SKED/);
  assert.equal(byId['faa:BUR:closure:all'].severity, 'severe');
  assert.equal(byId['faa:SFO:ground_delay:all'].severity, 'moderate');
  assert.equal(byId['faa:LAX:delay:Departure'].severity, 'minor');
});

test('the feed reads the fixed FAA address', async () => {
  const asked = [];
  const source = createFaaFeedSource({
    now: () => Date.parse('2026-11-01T17:21:00Z'),
    fetchImpl: async (url) => {
      asked.push(String(url));
      return new Response(XML, {
        headers: { 'content-type': 'application/xml' },
      });
    },
  });
  const loaded = await source.load();
  assert.deepEqual(asked, [FAA_NAS_STATUS_URL]);
  assert.equal(loaded.events.length, 6);
  assert.equal(loaded.alerts.length, 5);
});
