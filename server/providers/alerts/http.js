import {
  readResponseBytesCapped,
  readResponseTextCapped,
} from '../common/http.js';

/**
 * The identity every alert feed request carries. The National Weather
 * Service requires a User-Agent that names the application and a way to
 * reach its maintainers; the other feeds accept the same one.
 */
export const ALERTS_USER_AGENT =
  'gods-eye-view-alerts-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

/** Most redirects one read follows, each to a host the feed lists. */
const MAX_REDIRECTS = 3;

/**
 * A failure the proxy can describe without repeating upstream text: `code`
 * is one of the short identifiers `upstreamErrorCode` returns, `status` the
 * upstream HTTP status when there was one.
 */
export class UpstreamError extends Error {
  constructor(code, { status = null } = {}) {
    super(code);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
  }
}

/**
 * A short, fixed identifier for a failed read: `http_<status>`, `timeout`,
 * `too_large`, `invalid_payload`, `redirect_refused`, `network` or
 * `unavailable`. Nothing upstream wrote (bodies, messages, addresses, which
 * may carry a key) ever reaches a payload, a log line or a status route.
 */
export function upstreamErrorCode(error) {
  if (!error) return 'unavailable';
  if (error instanceof UpstreamError) {
    if (Number.isInteger(error.status)) return `http_${error.status}`;
    return /^[a-z][a-z0-9_]{0,40}$/.test(error.code)
      ? error.code
      : 'unavailable';
  }
  if (error.code === 'RESPONSE_TOO_LARGE') return 'too_large';
  if (error.name === 'AbortError' || error.name === 'TimeoutError')
    return 'timeout';
  if (error instanceof SyntaxError) return 'invalid_payload';
  if (error.name === 'TypeError') return 'network';
  return 'unavailable';
}

function hostAllowed(url, allowedHosts) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' && allowedHosts.includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * One bounded upstream read: a deadline that covers the body, a byte cap,
 * and redirects followed only to the hosts the caller lists (none by
 * default). Returns the body with the status and content type, so a parser
 * can tell JSON from XML from protobuf by header rather than by guessing.
 */
async function fetchUpstream(url, read, options = {}) {
  const {
    fetchImpl = (...args) => globalThis.fetch(...args),
    headers = {},
    timeoutMs = 15_000,
    maxBytes = 4 * 1024 * 1024,
    redirectHosts = [],
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const response = await fetchImpl(target, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': ALERTS_USER_AGENT, ...headers },
      });
      if (response.status >= 300 && response.status < 400) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        const location = response.headers?.get?.('location');
        let next = null;
        try {
          next = location ? new URL(location, target).href : null;
        } catch {
          next = null;
        }
        if (!next || hop >= MAX_REDIRECTS || !hostAllowed(next, redirectHosts))
          throw new UpstreamError('redirect_refused');
        target = next;
        continue;
      }
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new UpstreamError('http', { status: response.status });
      }
      const payload = await read(response, maxBytes, controller.signal);
      return {
        status: response.status,
        url: target,
        contentType: String(response.headers?.get?.('content-type') || ''),
        payload,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch text (JSON, XML, RSS, CSV) with the shared bounds. */
export function fetchUpstreamText(url, options) {
  return fetchUpstream(url, readResponseTextCapped, options);
}

/** Fetch bytes (protobuf) with the shared bounds. */
export function fetchUpstreamBytes(url, options) {
  return fetchUpstream(url, readResponseBytesCapped, options);
}

/** Parse JSON, tolerating a UTF-8 byte-order mark some feeds prepend. */
export function parseJsonText(text) {
  return JSON.parse(String(text).replace(/^﻿/, ''));
}
