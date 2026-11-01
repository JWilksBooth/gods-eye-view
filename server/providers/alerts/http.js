import {
  readResponseBytesCapped,
  readResponseTextCapped,
} from '../common/http.js';

/**
 * The identity every alert feed request carries. The National Weather
 * Service requires a User-Agent that names the application and a contact;
 * the others do not object to one.
 */
export const ALERTS_USER_AGENT =
  'GodsEyeView/0.3 (alerts layer; +https://github.com/JWilksBooth/gods-eye-view)';

/** Failure the governors recognise: `status` is the upstream HTTP status. */
export class UpstreamError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.url = url;
  }
}

/**
 * One bounded upstream read: a deadline that covers the body, a byte cap,
 * and redirects refused unless a feed is known to redirect. Returns the body
 * as text with the status and content type, so a parser can tell JSON from
 * XML from protobuf by header rather than by guessing.
 */
async function fetchUpstream(url, read, options = {}) {
  const {
    fetchImpl = (...args) => globalThis.fetch(...args),
    headers = {},
    timeoutMs = 15_000,
    maxBytes = 4 * 1024 * 1024,
    redirect = 'error',
    method = 'GET',
    body,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      signal: controller.signal,
      redirect,
      headers: { 'User-Agent': ALERTS_USER_AGENT, ...headers },
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw new UpstreamError(`Upstream returned ${response.status}`, {
        status: response.status,
        url,
      });
    }
    const payload = await read(response, maxBytes, controller.signal);
    return {
      status: response.status,
      contentType: String(response.headers?.get?.('content-type') || ''),
      payload,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch text (JSON, XML, RSS) with the shared bounds. */
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
