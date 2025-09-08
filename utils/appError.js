// utils/appError.js
'use strict';

/**
 * AppError
 * --------
 * Production-safe error class with:
 *  - machine-readable `code`
 *  - HTTP `status`
 *  - human `message`
 *  - optional `details` (safe to log/return; never include secrets/PII)
 *
 * Helpers included:
 *  - validation(...)           → 400 errors for input validation
 *  - fromUnexpected(...)       → 500 (or provided status) for unexpected failures
 *  - fromUpstream(...)         → wraps HTTP client/provider errors (default 502)
 *  - fromMPResponse(...)       → specialized mapping for Mercado Pago responses
 *  - fromPagBankResponse(...)  → specialized mapping for PagBank responses
 *
 * Notes:
 *  - `.safeJSON()` yields a client-safe payload (no stack, no cause).
 *  - Keep `details` compact; prefer primitives and small objects.
 */

class AppError extends Error {
  /**
   * @param {string} code    Machine-readable error code (e.g., "internal_error").
   * @param {string} message Human-friendly message.
   * @param {number} status  HTTP status (default 500).
   * @param {object} [details] Additional safe context (no secrets/PII).
   */
  constructor(code, message, status = 500, details = undefined) {
    super(message || code || 'Error');
    this.name = 'AppError';
    this.code = code || 'internal_error';
    this.status = Number.isFinite(status) ? Number(status) : 500;
    if (details !== undefined) this.details = details;
    this.isAppError = true; // simple type guard for handlers
    // Keep constructor out of stack where supported
    Error.captureStackTrace?.(this, AppError);
  }

  /** Minimal, client-safe JSON view (no stack/cause). */
  safeJSON() {
    const out = {
      code: this.code || 'internal_error',
      message: this.message || 'Internal server error',
      status: Number.isFinite(this.status) ? this.status : 500,
    };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }

  /** Override default JSON serialization with the safe representation. */
  toJSON() {
    return this.safeJSON();
  }

  /** Wrap non-AppError values into an AppError. */
  static wrap(err, fallbackCode = 'internal_error', status = 500, details) {
    if (err instanceof AppError) return err;
    const msg = err?.message || 'Internal server error';
    return new AppError(fallbackCode, msg, status, details);
  }

  /** 400 Validation error (to normalize Zod/validator libs in controllers). */
  static validation(code = 'validation_error', message = 'Validation error', details) {
    return new AppError(code, message, 400, details);
  }

  /**
   * Wrap unexpected internal failures with a consistent code/status.
   * @param {string} code
   * @param {string} message
   * @param {object} [opts] { cause?: any, status?: number, details?: object }
   */
  static fromUnexpected(code = 'internal_error', message = 'Internal server error', opts = {}) {
    const status = Number.isFinite(opts?.status) ? Number(opts.status) : 500;
    const details = opts?.details || (opts?.cause ? { cause: String(opts.cause?.message || opts.cause) } : undefined);
    return new AppError(code, message, status, details);
  }

  /**
   * Wrap upstream/provider HTTP errors (e.g., PSP/external APIs).
   * Attempts to derive a meaningful HTTP status and preserves safe metadata.
   * @param {string} code
   * @param {string} message
   * @param {any} upstreamErr  Typically an error thrown by httpClient (with response)
   * @param {object} [extraDetails]
   */
  static fromUpstream(code, message, upstreamErr, extraDetails = undefined) {
    const status = normalizeHttpStatus(upstreamErr?.response?.status, 502);
    const details = Object.assign(
      {},
      extraDetails || {},
      extractRetryAfter(upstreamErr?.response?.headers),
      upstreamErr?.response?.status ? { upstreamStatus: upstreamErr.response.status } : {}
    );
    return new AppError(code || 'upstream_error', message || 'Upstream error', status, details);
  }

  /**
   * Map Mercado Pago HTTP client errors to AppError.
   * Honors Retry-After header (seconds or HTTP-date) when present.
   */
  static fromMPResponse(e, context = 'mp_request') {
    const status = e?.response?.status;
    const headers = e?.response?.headers || {};
    const codeByStatus = {
      400: 'mp_invalid_request',
      401: 'mp_unauthorized',
      403: 'mp_forbidden',
      404: 'mp_not_found',
      409: 'mp_conflict',
      422: 'mp_unprocessable',
      429: 'mp_rate_limited',
      500: 'mp_server_error',
      502: 'mp_bad_gateway',
      503: 'mp_unavailable',
      504: 'mp_gateway_timeout',
    };

    const code = codeByStatus[status] || 'mp_http_error';
    const details = { context, ...extractRetryAfter(headers) };
    return new AppError(code, e?.message || code, normalizeHttpStatus(status, 502), details);
  }

  /**
   * Map PagBank HTTP client errors to AppError.
   */
  static fromPagBankResponse(e, context = 'pagbank_request') {
    const status = e?.response?.status;
    const codeByStatus = {
      400: 'pagbank_invalid_request',
      401: 'pagbank_unauthorized',
      403: 'pagbank_forbidden',
      404: 'pagbank_not_found',
      409: 'pagbank_conflict',
      422: 'pagbank_unprocessable',
      429: 'pagbank_rate_limited',
      500: 'pagbank_server_error',
      502: 'pagbank_bad_gateway',
      503: 'pagbank_unavailable',
      504: 'pagbank_gateway_timeout',
    };

    const code = codeByStatus[status] || 'pagbank_http_error';
    const details = { context, ...extractRetryAfter(e?.response?.headers) };
    return new AppError(code, e?.message || code, normalizeHttpStatus(status, 502), details);
  }
}

/* ----------------------------- Internal helpers ----------------------------- */

function normalizeHttpStatus(status, fallback = 500) {
  const n = Number(status);
  return Number.isFinite(n) && n >= 400 && n <= 599 ? n : fallback;
}

/** Parse Retry-After header (seconds or HTTP-date) into { retryAfterMs }. */
function extractRetryAfter(headers) {
  if (!headers) return {};
  const ra = headers['retry-after'];
  if (ra == null) return {};
  const s = String(ra).trim();
  if (/^\d+$/.test(s)) return { retryAfterMs: Number(s) * 1000 };
  const ts = Date.parse(s);
  if (!Number.isNaN(ts)) {
    const delta = ts - Date.now();
    return { retryAfterMs: Math.max(0, delta) };
  }
  return {};
}

/**
 * EXPORT SHAPE (supports both import styles)
 * ------------------------------------------
 *  const AppError = require('.../appError');
 *  const { AppError } = require('.../appError');
 */
module.exports = AppError;          // default export
module.exports.AppError = AppError; // named export
