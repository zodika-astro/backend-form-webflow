// utils/httpClient.js
'use strict';

/**
 * Minimal HTTP client on top of undici/fetch with:
 * - Sensible defaults for production (timeouts, JSON handling).
 * - Automatic retries with exponential backoff for transient errors (429/5xx & network).
 * - Support for idempotent POSTs when caller provides `X-Idempotency-Key`.
 * - Keep-alive via undici's connection pooling (default).
 *
 * API (unchanged):
 *   const http = require('./utils/httpClient');
 *   await http.get(url, { headers, timeout, retries });
 *   await http.post(url, body, { headers, timeout, retries });
 *   await http.put/patch/delete(...)
 *
 * Return shape (unchanged):
 *   { status, data, headers } on success
 *   throw { message, response: { status, data, headers } } on HTTP errors
 */

const { fetch, Headers } = require('undici');

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function parseRetryAfterMs(hdr) {
  if (!hdr) return null;
  const s = String(hdr).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const ts = Date.parse(s);
  if (!Number.isNaN(ts)) {
    const delta = ts - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function sanitizeHeadersForReturn(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v;
  return out;
}

async function doFetch(method, url, { data, headers = {}, timeout, timeoutMs } = {}) {
  const controller = new AbortController();
  const to = setTimeout(
    () => controller.abort(new Error('Request timed out')),
    Number(timeoutMs ?? timeout ?? DEFAULT_TIMEOUT_MS)
  );

  try {
    const baseHeaders = new Headers(headers);
    const hasBody = data !== undefined && data !== null && method !== 'GET' && method !== 'HEAD';

    if (hasBody && !baseHeaders.has('content-type') && typeof data === 'object' && !(data instanceof Buffer)) {
      baseHeaders.set('content-type', 'application/json');
    }
    if (!baseHeaders.has('accept')) baseHeaders.set('accept', 'application/json');

    const body = hasBody
      ? (typeof data === 'string' || data instanceof Buffer ? data : JSON.stringify(data))
      : undefined;

    const res = await fetch(url, {
      method,
      headers: baseHeaders,
      body,
      signal: controller.signal,
      // Keep-alive is on by default via undici's pool
    });

    const ct = res.headers.get('content-type') || '';
    const retHeaders = sanitizeHeadersForReturn(res.headers);

    if (res.ok) {
      const parsed = ct.includes('application/json')
        ? await res.json().catch(() => ({}))
        : await res.text();
      return { status: res.status, data: parsed, headers: retHeaders };
    }

    const errPayload = ct.includes('application/json')
      ? await res.json().catch(() => ({}))
      : await res.text();
    const error = new Error(`HTTP ${res.status} ${res.statusText}`);
    error.response = { status: res.status, data: errPayload, headers: retHeaders };
    throw error;
  } finally {
    clearTimeout(to);
  }
}

/**
 * Core request with retry/backoff.
 * Retries on:
 *  - 429 or 5xx (except 501) responses
 *  - network/timeout errors
 *
 * Backoff schedule (ms):
 *   attempt 0 → 0
 *   attempt 1 → 200-300 (jitter)
 *   attempt 2 → 500-750 (jitter)
 *   attempt 3 → 1000-1500 (jitter)
 */
async function request(method, url, opts = {}) {
  const {
    data,
    headers,
    timeout,
    timeoutMs,
    retries = DEFAULT_RETRIES,
    retryBackoffMs,
  } = opts;

  const backoff = Array.isArray(retryBackoffMs) && retryBackoffMs.length
    ? retryBackoffMs
    : [0, 200, 500, 1000];

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await doFetch(method, url, { data, headers, timeout, timeoutMs });
    } catch (err) {
      lastErr = err;

      const status = err?.response?.status;
      const isRetryableStatus = status ? RETRY_STATUS.has(status) : false;
      const isNetworkErr = !status;

      if (attempt >= retries || (!isRetryableStatus && !isNetworkErr)) break;

      const retryAfterMs = parseRetryAfterMs(err?.response?.headers?.['retry-after']);
      const baseDelay = backoff[Math.min(attempt + 1, backoff.length - 1)];
      const jitter = Math.floor(baseDelay * 0.5 * Math.random());
      const delay = retryAfterMs != null ? retryAfterMs : (baseDelay + jitter);

      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = {
  get: (url, opts) => request('GET', url, opts),
  post: (url, data, opts) => request('POST', url, { ...opts, data }),
  put: (url, data, opts) => request('PUT', url, { ...opts, data }),
  patch: (url, data, opts) => request('PATCH', url, { ...opts, data }),
  delete: (url, opts) => request('DELETE', url, opts),
};
