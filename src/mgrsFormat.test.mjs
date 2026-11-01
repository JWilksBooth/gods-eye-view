import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatMGRS, mgrsAt } from './mgrsFormat.js';

test('a raw MGRS reference is spaced into zone, square, easting and northing', () => {
  assert.equal(formatMGRS('18SUJ23370716'), '18S UJ 2337 0716');
  assert.equal(formatMGRS('4QFJ1234567890'), '4Q FJ 12345 67890');
  assert.equal(
    formatMGRS('10SEG'),
    '10SEG',
    'a square without digits is left alone',
  );
  assert.equal(formatMGRS('not mgrs'), 'not mgrs');
  assert.equal(formatMGRS(undefined), undefined);
});

test('mgrsAt projects a point at the requested precision and refuses the caps', () => {
  const sf = mgrsAt(-122.4194, 37.7749, 4);
  assert.match(sf, /^10S EG \d{4} \d{4}$/, sf);
  const coarse = mgrsAt(-122.4194, 37.7749, 1);
  assert.match(coarse, /^10S EG \d \d$/, coarse);
  assert.equal(mgrsAt(0, 89, 4), null, 'MGRS is undefined above 84°');
  assert.equal(mgrsAt(Number.NaN, 10, 4), null);
  assert.equal(mgrsAt(10, undefined, 4), null);
});

test('the HUD reads MGRS through the shared helper and keeps no copy of it', () => {
  const hud = readFileSync(new URL('./hud.js', import.meta.url), 'utf8');
  assert.match(hud, /import \{ formatMGRS \} from '\.\/mgrsFormat\.js';/);
  assert.match(hud, /formatMGRS\(mgrsStr\)/);
  assert.doesNotMatch(hud, /_formatMGRS/);
});
