import assert from 'node:assert/strict';
import test from 'node:test';

import { caltransStreamUrl } from './sources.js';

const GOOD =
  'https://wzmedia.dot.ca.gov/D4/N101_NOF_Petaluma_Bl.stream/playlist.m3u8';

test('a Caltrans playlist on the agency media host is accepted as published', () => {
  assert.equal(caltransStreamUrl(GOOD), GOOD);
  assert.equal(caltransStreamUrl(' ' + GOOD + ' '), GOOD);
  assert.equal(
    caltransStreamUrl(
      'https://wzmedia.dot.ca.gov/D12/SR-55_at_Chapman.stream/playlist.m3u8',
    ),
    'https://wzmedia.dot.ca.gov/D12/SR-55_at_Chapman.stream/playlist.m3u8',
  );
});

test('dot segments normalize to the real district path before the check', () => {
  assert.equal(
    caltransStreamUrl(
      'https://wzmedia.dot.ca.gov/D4/../D7/N101.stream/playlist.m3u8',
    ),
    'https://wzmedia.dot.ca.gov/D7/N101.stream/playlist.m3u8',
  );
});

test('anything off the media host, off HTTPS, or decorated is refused', () => {
  for (const bad of [
    undefined,
    '',
    'http://wzmedia.dot.ca.gov/D4/N101.stream/playlist.m3u8',
    'https://example.com/D4/N101.stream/playlist.m3u8',
    'https://user:pw@wzmedia.dot.ca.gov/D4/N101.stream/playlist.m3u8',
    'https://wzmedia.dot.ca.gov/D4/N101.stream/playlist.m3u8?token=1',
    'https://wzmedia.dot.ca.gov/D4/N101.stream/chunklist.m3u8',
    'https://wzmedia.dot.ca.gov/N101.stream/playlist.m3u8',
    'not a url',
  ]) {
    assert.equal(caltransStreamUrl(bad), null, String(bad));
  }
});
