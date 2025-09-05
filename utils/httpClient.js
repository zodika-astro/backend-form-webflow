// utils/httpClient.js
'use strict';

/**
 * Production-grade HTTP client on top of undici/fetch
 * ---------------------------------------------------
 * Goals:
 * - Sensible defaults (timeouts, JSON handling, keep-alive via undici pools).
 * - Robust retries with exponential backoff + jitter for transient failures.
 * - Optional respect for `Retry-After`.
 * - HTTPS-only with an allowlist of hosts to reduce misconfig/SSRF risk.
 * - Optional response size guard based on Content-Length.
 * - Never logs secrets; only returns response headers/data to the caller.
 *
 * API (unchanged):
 *   const http = require('./utils/httpClient');
 *   await http.get(url, { headers, timeout, retries });
 *   await http.post(url, body, { headers, timeout, retries });
 *   await http.put/patch/delete(...)
 *
 * Return shape (unchanged):
 *   { status, data, headers } on success
 *   throw Error with .response = { status, data, headers } on HTTP errors
 */

const { fetch, Headers } = require('undici');

/* -------------------------------- Defaults -------------------------------- */

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
// Retry on these HTTP status codes (transient or rate-limited)
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// Maximum allowed response size (based only on Content-Length header).
// If Content-Length is missing, we don't enforce a hard cap here.
const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000; // ~1.5MB

// Allowlist of HTTPS hosts we consider safe to call from this backend.
// You can override via env HTTP_ALLOWED_HOSTS="api.mercadopago.com,api.pagbank.com.br"
const DEFAULT_ALLOWED_HOSTS = new Set([
  'api.mercadopago.com',
  'api.pagbank.com.br',
  'sandbox.api.pagseguro.com',
]);

/* ------------------------------- Small utils ------------------------------- */

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

/** Normalize & validate a URL:
 *  - Must be https://
 *  - Host must be present in the allowlist (or end with one of them if you prefer suffix matching)
 */
function validateHttpsUrl(url, allowedHosts) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Invalid URL'); }
  if ((u.protocol || '').toLowerCase() !== 'https:') {
    throw new Error('Only HTTPS URLs are allowed');
  }
  const host = u.host; // includes hostname[:port]
  if (!host) throw new Error('URL missing host');

  // Strict host allowlist
  if (!allowedHosts.has(host)) {
    throw new Error(`Destination host not allowed: ${host}`);
  }
  return u.toString();
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
 * - Validates HTTPS + allowed host.
 * - Optionally guards response size using Content-Length header.
 * - Parses JSON when content-type includes application/json, else returns text.
 */
async function doFetch(method, url, {
  data,
  headers = {},
  timeout,
  timeoutMs,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  userAgent = 'ZodikaBackend/1.0 (+https://www.zodika.com.br) httpClient',
} = {}) {
  // Validate URL before any network I/O
  const safeUrl = validateHttpsUrl(url, allowedHosts);

  const controller = new AbortController();
  const to = setTimeout(
    () => controller.abort(new Error('Request timed out')),
    Number(timeoutMs ?? timeout ?? DEFAULT_TIMEOUT_MS)
  );

  try {
    const baseHeaders = new Headers(headers);

    // Default headers
    if (!baseHeaders.has('accept')) baseHeaders.set('accept', 'application/json');
    if (!baseHeaders.has('user-agent')) baseHeaders.set('user-agent', userAgent);

    const hasBody = data !== undefined && data !== null && method !== 'GET' && method !== 'HEAD';
    if (hasBody && !baseHeaders.has('content-type') && typeof data === 'object' && !(data instanceof Buffer)) {
      baseHeaders.set('content-type', 'application/json');
    }

    const body = hasBody
      ? (typeof data === 'string' || data instanceof Buffer ? data : JSON.stringify(data))
      : undefined;

    const res = await fetch(safeUrl, {
      method,
      headers: baseHeaders,
      body,
      signal: controller.signal,
      // keep-alive: undici enables connection pooling by default
      redirect: 'follow', // we’ll validate final URL below
      // Note: if you prefer to prevent off-allowlist redirects entirely,
      // switch to 'manual' and implement step-by-step checks.
    });

    // If redirected, ensure the final URL host is still allowed
    try {
      const final = new URL(res.url);
      if ((final.protocol || '').toLowerCase() !== 'https:' || !allowedHosts.has(final.host)) {
        const err = new Error('Redirected to a disallowed host');
        err.response = { status: 497, data: 'Disallowed redirect target', headers: sanitizeHeadersForReturn(res.headers) };
        throw err;
      }
    } catch {
      // ignore URL parsing issues; undici normally provides a valid res.url
    }

    const ct = res.headers.get('content-type') || '';
    const retHeaders = sanitizeHeadersForReturn(res.headers);

    // Optional response size guard (based on Content-Length only)
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

    // Non-2xx: build error object with parsed payload (JSON or text)
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

/* ----------------------------- Public request API -------------------------- */

/**
 * Core request with retry/backoff.
 * Retries on:
 *  - 408, 425, 429, 5xx responses
 *  - network/timeout errors
 *
 * Backoff schedule (ms) with jitter:
 *   attempt 0 → 0
 *   attempt 1 → 200-300
 *   attempt 2 → 500-750
 *   attempt 3 → 1000-1500
 */
async function request(method, url, opts = {}) {
  const {
    data,
    headers,
    timeout,
    timeoutMs,
    retries = DEFAULT_RETRIES,
    retryBackoffMs,
    // hardening knobs (optional)
    allowedHosts,
    maxResponseBytes,
    userAgent,
  } = opts;

  // Resolve allowlist from env (comma-separated) or use defaults
  let hosts = DEFAULT_ALLOWED_HOSTS;
  if (allowedHosts && allowedHosts instanceof Set) {
    hosts = allowedHosts;
  } else if (typeof process.env.HTTP_ALLOWED_HOSTS === 'string' && process.env.HTTP_ALLOWED_HOSTS.trim()) {
    hosts = new Set(
      process.env.HTTP_ALLOWED_HOSTS
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    );
  }

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
        allowedHosts: hosts,
        maxResponseBytes: maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        userAgent,
      });
    } catch (err) {
      lastErr = err;

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
  throw lastErr;
}

/* --------------------------------- Exports --------------------------------- */

module.exports = {
  get: (url, opts) => request('GET', url, opts),
  post: (url, data, opts) => request('POST', url, { ...opts, data }),
  put: (url, data, opts) => request('PUT', url, { ...opts, data }),
  patch: (url, data, opts) => request('PATCH', url, { ...opts, data }),
  delete: (url, opts) => request('DELETE', url, opts),
};
