// utils/httpClient.js
'use strict';

/**
 * Production-grade HTTP client on top of undici/fetch
 * ---------------------------------------------------
 * Goals:
 * - Sensible defaults (timeouts, JSON handling, keep-alive via undici pools).
 * - Opt-in retries with exponential backoff + jitter for transient failures.
 * - Optional respect for `Retry-After` on 429/5xx/408.
 * - HTTPS-only (no egress allowlist enforcement).
 * - Optional response size guard (Content-Length).
 * - Correlation propagation (X-Request-Id/X-Correlation-Id).
 * - Respects upstream AbortSignal (`opts.signal`) for cooperative cancellation.
 *
 * API:
 *   const http = require('./utils/httpClient');
 *   await http.get(url, { headers, timeout, retries, signal });
 *   await http.post(url, body, { headers, timeout, retries, signal });
 *
 * Return shape:
 *   { status, data, headers } on success
 *   throw Error with .response = { status, data, headers } on HTTP errors
 */

const { fetch, Headers } = require('undici');
const crypto = require('crypto');

/* -------------------------------- Defaults -------------------------------- */

// Safe defaults to avoid long hangs when caller doesn't configure timeouts/retries.
const DEFAULT_TIMEOUT_MS = toInt(process.env.HTTP_DEFAULT_TIMEOUT_MS, 10_000); // 10s
const DEFAULT_RETRIES    = toInt(process.env.HTTP_DEFAULT_RETRIES, 0);        // opt-in

// Retry-worthy HTTP statuses (transient/rate-limited)
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// Optional response size guard via Content-Length
const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000; // ~1.5MB

/* ------------------------------- Small utils ------------------------------- */

const genId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

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
function sleep(ms) { return new Promise(res => setTimeout(res, Math.max(0, Number(ms) || 0))); }

function sanitizeHeadersForReturn(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v;
  return out;
}

/** Classify undici/fetch errors that are generally retryable (network-ish). */
function isNetworkLikeError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true; // timeout/abort
  const code = err.cause?.code || err.code || '';
  return [
    'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ].includes(code);
}

/* --------------------------- Core fetch with guards ------------------------ */

/**
 * Perform a single HTTP request (no retries here).
 * - Enforces timeout via AbortController.
 * - Respects upstream AbortSignal (`upstream`) for cooperative cancellation.
 * - Validates HTTPS (no egress host allowlist).
 * - Optional guard for response size using Content-Length header.
 * - Parses JSON when content-type includes application/json, else returns text.
 * - Optionally controls redirects (default: follow). Ensures redirect target stays HTTPS.
 */
async function doFetch(method, url, {
  data,
  headers = {},
  timeout,
  timeoutMs,
  upstream, // upstream AbortSignal
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  userAgent = 'ZodikaBackend/1.0 (+https://www.zodika.com.br) httpClient',
  followRedirects = true,
} = {}) {
  const safeUrl = validateHttpsUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Request timed out')),
    Number(timeoutMs ?? timeout ?? DEFAULT_TIMEOUT_MS)
  );

  const onUpstreamAbort = () => controller.abort(upstream?.reason || new Error('Aborted by upstream'));
  if (upstream) {
    if (upstream.aborted) onUpstreamAbort();
    else upstream.addEventListener('abort', onUpstreamAbort, { once: true });
  }

  try {
    const baseHeaders = new Headers(headers);

    // Correlation propagation (generate if absent)
    const corr = baseHeaders.get('x-request-id') || baseHeaders.get('x-correlation-id') || genId();
    if (!baseHeaders.has('x-request-id')) baseHeaders.set('x-request-id', corr);
    if (!baseHeaders.has('x-correlation-id')) baseHeaders.set('x-correlation-id', corr);

    // Default headers
    if (!baseHeaders.has('accept')) baseHeaders.set('accept', 'application/json');
    if (!baseHeaders.has('user-agent')) baseHeaders.set('user-agent', userAgent);

    // Body handling
    const hasBody = data !== undefined && data !== null && method !== 'GET' && method !== 'HEAD';
    let body;
    if (hasBody) {
      const ct = baseHeaders.get('content-type');
      if (typeof data === 'string' || data instanceof Buffer) {
        body = data; // raw payload provided by caller
      } else if (!ct || ct.toLowerCase().includes('application/json')) {
        baseHeaders.set('content-type', 'application/json');
        body = JSON.stringify(data);
      } else {
        // caller set another content-type but passed an object; still stringify
        body = JSON.stringify(data);
      }
    }

    const res = await fetch(safeUrl, {
      method,
      headers: baseHeaders,
      body,
      signal: controller.signal,
      redirect: followRedirects ? 'follow' : 'manual',
    });

    // Redirect target must remain HTTPS
    try {
      const final = new URL(res.url);
      if ((final.protocol || '').toLowerCase() !== 'https:') {
        const err = new Error('Redirected to non-HTTPS URL');
        err.response = { status: 497, data: 'Disallowed redirect (non-HTTPS)', headers: sanitizeHeadersForReturn(res.headers) };
        throw err;
      }
    } catch {
      // ignore URL parsing issues (undici usually provides a valid res.url)
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const retHeaders = sanitizeHeadersForReturn(res.headers);

    // Optional response size guard
    const cl = res.headers.get('content-length');
    if (cl && maxResponseBytes && Number(cl) > maxResponseBytes) {
      const error = new Error('Response too large');
      error.response = { status: 499, data: 'Response exceeds configured size limit', headers: retHeaders };
      throw error;
    }

    if (res.ok) {
      const parsed = ct.includes('application/json')
        ? await res.json().catch(() => ({}))
        : await res.text();
      return { status: res.status, data: parsed, headers: retHeaders };
    }

    // Non-2xx: include parsed payload (JSON or text)
    const errPayload = ct.includes('application/json')
      ? await res.json().catch(() => ({}))
      : await res.text();

    const error = new Error(`HTTP ${res.status} ${res.statusText}`);
    error.response = { status: res.status, data: errPayload, headers: retHeaders };
    throw error;
  } finally {
    clearTimeout(timer);
    if (upstream) upstream.removeEventListener?.('abort', onUpstreamAbort);
  }
}

/* ----------------------------- Public request API -------------------------- */

/**
 * Core request with retry/backoff.
 * Retries on:
 *  - 408, 425, 429, 5xx responses
 *  - network/timeout errors
 * Respects `opts.signal` for cooperative cancellation across retries.
 */
async function request(method, url, opts = {}) {
  const {
    data,
    headers,
    timeout,
    timeoutMs,
    retries = DEFAULT_RETRIES,
    retryBackoffMs,
    maxResponseBytes,
    userAgent,
    followRedirects,
    signal,
  } = opts;

  const backoff = Array.isArray(retryBackoffMs) && retryBackoffMs.length
    ? retryBackoffMs
    : [0, 200, 500, 1000];

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await doFetch(method, url, {
        data,
        headers,
        timeout,
        timeoutMs,
        upstream: signal, // propagate cancellation
        maxResponseBytes: maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        userAgent,
        followRedirects: followRedirects !== false, // default: follow
      });
    } catch (err) {
      lastErr = err;

      // If canceled by upstream, don't retry
      if (signal?.aborted) break;

      const status = err?.response?.status;
      const isRetryableStatus = status ? RETRY_STATUS.has(status) : false;
      const isNetworkErr = isNetworkLikeError(err);

      if (attempt >= retries || (!isRetryableStatus && !isNetworkErr)) break;

      const retryAfterMs = parseRetryAfterMs(err?.response?.headers?.['retry-after']);
      const baseDelay = backoff[Math.min(attempt + 1, backoff.length - 1)];
      const jitter = Math.floor(baseDelay * 0.5 * Math.random());
      const delay = retryAfterMs != null ? retryAfterMs : (baseDelay + jitter);

      await sleep(delay);
    }
  }
  throw lastErr || new Error('http_request_failed_unknown');
}

/* --------------------------------- Exports --------------------------------- */

module.exports = {
  get: (url, opts) => request('GET', url, opts),
  post: (url, data, opts) => request('POST', url, { ...opts, data }),
  put: (url, data, opts) => request('PUT', url, { ...opts, data }),
  patch: (url, data, opts) => request('PATCH', url, { ...opts, data }),
  delete: (url, opts) => request('DELETE', url, opts),
};

/* --------------------------------- Internals -------------------------------- */

function validateHttpsUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Invalid URL'); }
  if ((u.protocol || '').toLowerCase() !== 'https:') {
    throw new Error('Only HTTPS URLs are allowed');
  }
  return u.toString();
}

function toInt(v, def) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}
