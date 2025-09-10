// utils/httpClient.js
'use strict';

/**
 * Production-grade HTTP client on top of undici/fetch
 * ---------------------------------------------------
 * Goals:
 * - Sensible defaults (timeouts, JSON handling, keep-alive via undici pools).
 * - Robust retries with exponential backoff + jitter for transient failures.
 * - Optional respect for `Retry-After`.
 * - HTTPS-only with a strict allowlist of hosts.
 * - Optional response size guard (Content-Length).
 * - Correlation propagation (X-Request-Id/X-Correlation-Id).
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
const crypto = require('crypto');

/* -------------------------------- Defaults -------------------------------- */

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;

// Retry on these HTTP status codes (transient or rate-limited)
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// Maximum allowed response size (based only on Content-Length header).
// If Content-Length is missing, we don't enforce a hard cap here.
const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000; // ~1.5MB

// Allowlist of HTTPS hosts we consider safe to call from this backend.
// You can override via env: HTTP_ALLOWED_HOSTS="api.mercadopago.com,api.pagbank.com.br"
const HARDCODED_ALLOWED_HOSTS = new Set([
  'api.mercadopago.com',
  'api.pagbank.com.br',
  'sandbox.api.pagseguro.com',
]);

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
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function sanitizeHeadersForReturn(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v;
  return out;
}

function getAllowedHostsFromEnv(defaultSet) {
  const raw = process.env.HTTP_ALLOWED_HOSTS;
  if (!raw || !raw.trim()) return new Set(defaultSet);
  return new Set(
    raw.split(',').map(s => s.trim()).filter(Boolean)
  );
}

/**
 * Validate and normalize a URL:
 *  - Must be https://
 *  - Host must be present in the allowlist
 */
function validateHttpsUrl(url, allowedHosts) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Invalid URL'); }
  if ((u.protocol || '').toLowerCase() !== 'https:') {
    throw new Error('Only HTTPS URLs are allowed');
  }
  const host = u.host; // includes hostname[:port]
  if (!host) throw new Error('URL missing host');
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
 * - Optionally controls following redirects (default: follow).
 */
async function doFetch(method, url, {
  data,
  headers = {},
  timeout,
  timeoutMs,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  allowedHosts = HARDCODED_ALLOWED_HOSTS,
  userAgent = 'ZodikaBackend/1.0 (+https://www.zodika.com.br) httpClient',
  followRedirects = true,
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
        // Respect caller-provided content-type for raw/string payloads
        body = data;
      } else if (!ct || ct.includes('application/json')) {
        baseHeaders.set('content-type', 'application/json');
        body = JSON.stringify(data);
      } else {
        // Caller set another content-type but passed an object; we stringify anyway
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
    followRedirects,
  } = opts;

  // Resolve allowlist from env or use defaults
  const hosts = allowedHosts instanceof Set
    ? allowedHosts
    : getAllowedHostsFromEnv(HARDCODED_ALLOWED_HOSTS);

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
        followRedirects: followRedirects !== false, // default true
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
