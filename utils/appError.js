// utils/appError.js
'use strict';

/**
 * AppError
 * --------
 * A small, production-safe error type with:
 *  - machine-readable `code`
 *  - HTTP `status`
 *  - human `message`
 *  - optional `details` (safe to log/return)
 *
 * Also exposes helpers to wrap unknown errors and to map PSP HTTP errors.
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
    Error.captureStackTrace?.(this, AppError);
  }

  /** Minimal, client-safe JSON view. */
  safeJSON() {
    const out = {
      code: this.code || 'internal_error',
      message: this.message || 'Internal server error',
      status: Number.isFinite(this.status) ? this.status : 500,
    };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }

  /** Wrap any unknown error into an AppError (defaults to 500/internal_error). */
  static wrap(err, fallbackCode = 'internal_error') {
    if (err instanceof AppError) return err;
    const msg = err?.message || 'Internal server error';
    return new AppError(fallbackCode, msg, 500);
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

    const details = { context };
    // Retry-After → milliseconds (tests expect this)
    const ra = headers['retry-after'];
    if (ra != null) {
      if (/^\d+$/.test(String(ra))) {
        details.retryAfterMs = Number(ra) * 1000;
      } else {
        const ts = Date.parse(String(ra));
        if (!Number.isNaN(ts)) {
          const delta = ts - Date.now();
          details.retryAfterMs = Math.max(0, delta);
        }
      }
    }

    return new AppError(code, e?.message || code, Number(status) || 502, details);
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
    const details = { context };
    return new AppError(code, e?.message || code, Number(status) || 502, details);
  }
}

module.exports = AppError;
