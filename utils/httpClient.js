// utils/httpClient.js
'use strict';

/**
 * Production-grade HTTP client on top of undici/fetch
 * ---------------------------------------------------
 * Goals:
 * - Sensible defaults (timeouts, JSON handling, keep-alive via undici pools).
 * - Opt-in retries with exponential backoff + jitter for transient failures.
 * - Optional respect for `Retry-After` on 429/5xx/408.
 * - HTTPS-only with a strict allowlist of hosts.
 * - Optional response size guard (Content-Length).
 * - Correlation propagation (X-Request-Id/X-Correlation-Id).
 * - Respects upstream AbortSignal (`opts.signal`) for cooperative cancellation.
 */

const { fetch, Headers } = require('undici');
const crypto = require('crypto');

/* -------------------------------- Defaults -------------------------------- */

const DEFAULT_TIMEOUT_MS = toInt(process.env.HTTP_DEFAULT_TIMEOUT_MS, 10_000);
const DEFAULT_RETRIES    = toInt(process.env.HTTP_DEFAULT_RETRIES, 0);

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000;

// Baseline allowlist; can be extended via HTTP_ALLOWED_HOSTS env.
const HARDCODED_ALLOWED_HOSTS = new Set([
  'api.mercadopago.com',
  'api.pagbank.com.br',
  'sandbox.api.pagseguro.com',
  'ephemeris-api-production.up.railway.app',
  'hook.us1.make.com',
  'hook.eu1.make.com',
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
function sleep(ms) { return new Promise(res => setTimeout(res, Math.max(0, Number(ms) || 0))); }

function sanitizeHeadersForReturn(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v;
  return out;
}

function getAllowedHostsFromEnv(defaultSet) {
  const raw = process.env.HTTP_ALLOWED_HOSTS;
  if (!raw || !raw.trim()) return new Set(defaultSet);
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
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
  const host = u.host; // hostname[:port]
  if (!host) throw new Error('URL missing host');
  if (!allowedHosts.has(host) && !allowedHosts.has(u.hostname)) {
    throw new Error(`Destination host not allowed: ${host}`);
  }
  return u.toString();
}

/** Classify undici/fetch errors that are generally retryable (network-ish). */
function isNetworkLikeError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const code = err.cause?.code || err.code || '';
  return [
    'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ].includes(code);
}

/* --------------------------- Core fetch with guards ------------------------ */

async function doFetch(method, url, {
  data,
  headers = {},
  timeout,
  timeoutMs,
  upstream,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  allowedHosts = HARDCODED_ALLOWED_HOSTS,
  userAgent = 'ZodikaBackend/1.0 (+https://www.zodika.com.br) httpClient',
  followRedirects = true,
} = {}) {
  const safeUrl = validateHttpsUrl(url, allowedHosts);

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

    // Correlation propagation
    const corr = baseHeaders.get('x-request-id') || baseHeaders.get('x-correlation-id') || genId();
    if (!baseHeaders.has('x-request-id')) baseHeaders.set('x-request-id', corr);
    if (!baseHeaders.has('x-correlation-id')) baseHeaders.set('x-correlation-id', corr);

    // Defaults
    if (!baseHeaders.has('accept')) baseHeaders.set('accept', 'application/json');
    if (!baseHeaders.has('user-agent')) baseHeaders.set('user-agent', userAgent);

    // Body
    const hasBody = data !== undefined && data !== null && method !== 'GET' && method !== 'HEAD';
    let body;
    if (hasBody) {
      const ct = baseHeaders.get('content-type');
      if (typeof data === 'string' || data instanceof Buffer) {
        body = data;
      } else if (!ct || ct.includes('application/json')) {
        baseHeaders.set('content-type', 'application/json');
        body = JSON.stringify(data);
      } else {
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

    // Validate redirect target host is still allowed
    try {
      const final = new URL(res.url);
      if ((final.protocol || '').toLowerCase() !== 'https:') {
        const err = new Error('Redirected to non-HTTPS URL');
        err.response = { status: 497, data: 'Disallowed redirect (non-HTTPS)', headers: sanitizeHeadersForReturn(res.headers) };
        throw err;
      }
      const finalHostAllowed =
        allowedHosts.has(final.host) || allowedHosts.has(final.hostname);
      if (!finalHostAllowed) {
        const err = new Error('Redirected to a disallowed host');
        err.response = { status: 497, data: 'Disallowed redirect target', headers: sanitizeHeadersForReturn(res.headers) };
        throw err;
      }
    } catch { /* ignore */ }

    const ct = res.headers.get('content-type') || '';
    const retHeaders = sanitizeHeadersForReturn(res.headers);

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

async function request(method, url, opts = {}) {
  const {
    data,
    headers,
    timeout,
    timeoutMs,
    retries = DEFAULT_RETRIES,
    retryBackoffMs,
    allowedHosts,
    maxResponseBytes,
    userAgent,
    followRedirects,
    signal,
  } = opts;

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
        upstream: signal,
        allowedHosts: hosts,
        maxResponseBytes: maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        userAgent,
        followRedirects: followRedirects !== false,
      });
    } catch (err) {
      lastErr = err;

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

function toInt(v, def) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}
