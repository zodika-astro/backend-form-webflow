// utils/httpClient.js
'use strict';

/**
 * Minimal HTTP client built on Node.js native `fetch` (Node >= 18).
 *
 * Goals:
 * - No external dependencies (removed `node-fetch`).
 * - Consistent JSON handling with graceful fallback to raw text.
 * - Per-request timeout using AbortController.
 * - Optional base URL (for PagBank), absolute URLs pass through unchanged.
 *
 * Environment:
 * - PAGBANK_BASE_URL: Optional base URL for relative paths (no trailing slash required).
 *
 * Notes:
 * - `globalThis.fetch` is available natively in Node >= 18.17. Ensure your runtime matches.
 * - Timeouts abort the request; callers should handle the thrown AbortError as a retriable case.
 */

const DEFAULT_TIMEOUT = 20_000;

// Resolve and normalize base URL for relative paths (e.g., PagBank API)
let BASE_URL = process.env.PAGBANK_BASE_URL || '';
if (BASE_URL.endsWith('/')) BASE_URL = BASE_URL.slice(0, -1);

/** Quick check for absolute URLs (http/https) */
function isAbsolute(url = '') {
  return /^https?:\/\//i.test(url);
}

/**
 * Core request helper.
 * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
 * @param {string} url - Absolute or relative (when relative, BASE_URL is prefixed)
 * @param {Object} [options]
 * @param {Object} [options.headers] - Extra headers to send
 * @param {any}    [options.data]    - JSON-serializable payload (auto stringified)
 * @param {number} [options.timeout] - Milliseconds until abort (default: 20s)
 * @returns {Promise<{status:number,data:any,headers:Object,config:Object}>}
 */
async function request(method, url, { headers = {}, data, timeout = DEFAULT_TIMEOUT } = {}) {
  // Guard: ensure native fetch exists (Node >= 18)
  if (typeof globalThis.fetch !== 'function') {
    // This indicates the runtime is outdated; updating Node is the fix.
    throw new Error('Native fetch is not available. Please run on Node.js >= 18.17.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const finalUrl = isAbsolute(url) ? url : `${BASE_URL}${url}`;

  // Default headers; caller can override by passing same keys in `headers`
  const baseHeaders = { Accept: 'application/json', ...headers };
  // Only set JSON content-type when a body is present and caller hasn't set it explicitly
  if (data !== undefined && baseHeaders['Content-Type'] == null) {
    baseHeaders['Content-Type'] = 'application/json';
  }

  try {
    const res = await globalThis.fetch(finalUrl, {
      method,
      headers: baseHeaders,
      body: data !== undefined ? JSON.stringify(data) : undefined,
      signal: controller.signal,
    });

    // Read body once; try JSON first, fall back to raw text wrapper
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON response: preserve raw payload for diagnostics/edge APIs
      json = text ? { raw: text } : null;
    }

    if (!res.ok) {
      // Normalize error object with response snapshot and request config
      const error = new Error(`HTTP ${res.status} on ${finalUrl}`);
      error.response = {
        status: res.status,
        data: json,
        headers: Object.fromEntries(res.headers.entries()),
      };
      error.config = { url: finalUrl, method, data, headers: baseHeaders };
      throw error;
    }

    return {
      status: res.status,
      data: json,
      headers: Object.fromEntries(res.headers.entries()),
      config: { url: finalUrl, method, data, headers: baseHeaders },
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  get: (url, opts) => request('GET', url, opts),
  post: (url, data, opts = {}) => request('POST', url, { ...opts, data }),
  put: (url, data, opts = {}) => request('PUT', url, { ...opts, data }),
  patch: (url, data, opts = {}) => request('PATCH', url, { ...opts, data }),
  delete: (url, opts) => request('DELETE', url, opts),
};
