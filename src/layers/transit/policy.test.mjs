import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_STALE_AFTER_MS,
  FEED_STALE_GRACE_MS,
  aggregateTransitFeedHealth,
  feedStaleAfterMs,
} from './policy.js';
import { getTransitFeed } from '../../data/transitFeeds.js';

test('a feed polled on an operator allowance is quiet only past its own window', () => {
  assert.equal(feedStaleAfterMs(getTransitFeed('mbta')), FEED_STALE_AFTER_MS);
  assert.equal(feedStaleAfterMs(null), FEED_STALE_AFTER_MS);
  assert.equal(feedStaleAfterMs({ refreshMs: 20_000 }), FEED_STALE_AFTER_MS);
  const sf511 = getTransitFeed('sf511-bay-area');
  assert.equal(
    feedStaleAfterMs(sf511),
    sf511.refreshMs + FEED_STALE_GRACE_MS,
    'eighty seconds of cache plus the grace',
  );
  assert.ok(feedStaleAfterMs(sf511) > FEED_STALE_AFTER_MS);
  // A catalog entry carries the same field and gets the same answer.
  assert.equal(
    feedStaleAfterMs({ refreshMs: sf511.refreshMs }),
    feedStaleAfterMs(sf511),
  );
});

test('feed health judges each status by the threshold its feed earned', () => {
  const now = 1_700_000_000_000;
  const quietFor = (ms, extra = {}) => ({
    stale: false,
    upstreamAt: now - ms,
    error: null,
    retryInSec: null,
    loading: false,
    ...extra,
  });
  // Shared threshold: 100 s of silence is stale.
  assert.equal(
    aggregateTransitFeedHealth([quietFor(100_000)], now).stale,
    true,
  );
  // The 511 feed's threshold: the same 100 s is simply between loads.
  const window = feedStaleAfterMs(getTransitFeed('sf511-bay-area'));
  assert.equal(
    aggregateTransitFeedHealth(
      [quietFor(100_000, { staleAfterMs: window })],
      now,
    ).stale,
    false,
  );
  assert.equal(
    aggregateTransitFeedHealth(
      [quietFor(window + 1, { staleAfterMs: window })],
      now,
    ).stale,
    true,
  );
  // One quiet feed among two reads as degraded, and the error of a keyed feed
  // without its key is reported like any other.
  const health = aggregateTransitFeedHealth(
    [
      quietFor(1_000),
      quietFor(1_000, {
        error: '511 SF Bay feed needs a key',
        keyRequired: true,
      }),
    ],
    now,
  );
  assert.equal(health.degraded, true);
  assert.equal(health.error, '511 SF Bay feed needs a key');
});
