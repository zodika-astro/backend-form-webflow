// middlewares/errorHandler.js
'use strict';

/**
 * Global Error Handler (Express)
 * -----------------------------
 * Responsibilities
 *  - Convert thrown errors into clean JSON responses.
 *  - Emit structured logs (no PII) with request correlation (X-Request-Id).
 *  - Avoid leaking stack traces in production.
 *  - Respect Retry-After hints (when provided by upstream mappings).
 *  - Never crash if logger/err objects are stubs.
 *
 * Contract
 *  - Expects AppError-like objects (err.isAppError || err.name === 'AppError') but
 *    gracefully handles any error shape.
 */

const rootLogger = require('../utils/logger');

// Prefer a namespaced child logger if available
const baseLogger = (typeof rootLogger?.child === 'function')
  ? rootLogger.child('error')
  : rootLogger;

const isProd = (process.env.NODE_ENV || 'production') === 'production';

/** Ensure status is an HTTP error code; default to 500 for out-of-range values. */
function normalizeStatus(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 500;
  return (n < 400 || n > 599) ? 500 : n;
}

/** Convert retryAfterMs to whole seconds (minimum 0). */
function toRetryAfterSeconds(details) {
  const ms = details?.retryAfterMs;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 1000));
}

module.exports = function errorHandler(err, req, res, next) {
  // If headers are already sent, delegate to Express default handler
  if (res.headersSent) return next?.(err);

  const isAppErr = !!(err?.isAppError || err?.name === 'AppError');

  // Status + code
  const status = normalizeStatus(err?.status);
  const code   = String(err?.code || (status >= 500 ? 'internal_error' : 'request_error'));

  // Correlation
  const rid = req?.requestId || req?.get?.('x-request-id') || null;
  if (rid) res.set('X-Request-Id', String(rid));

  // Honor Retry-After hints surfaced by upstream mappers (e.g., Mercado Pago / PagBank)
  const retryAfterSec = toRetryAfterSeconds(err?.details);
  if (retryAfterSec != null && [429, 502, 503, 504].includes(status)) {
    res.set('Retry-After', String(retryAfterSec));
  }

  // Defensive no-cache on error responses to avoid proxy/browser caching
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.set('Pragma', 'no-cache');

  // Choose message: never echo raw internal messages for 5xx
  const message = status >= 500
    ? 'Internal server error'
    : (err?.message || 'Request error');

  // Build log payload (safe, minimal)
  const logBase = {
    rid,
    status,
    code,
    method: req?.method,
    path: req?.originalUrl || req?.url,
    msg: err?.message,
  };

  // Include safe details for observability (never log raw payloads/PII here)
  if (isAppErr && err?.details !== undefined) {
    logBase.details = err.details;
  }

  if (!isProd && err?.stack) {
    logBase.stack = err.stack;
  }

  // Log using request-scoped logger when available
  const parentLog = req?.log || baseLogger;
  const log = (typeof parentLog?.child === 'function') ? parentLog.child('handler') : parentLog;

  if (typeof log?.error === 'function') {
    log.error(logBase, 'request failed');
  } else {
    // Last-resort logging
    // eslint-disable-next-line no-console
    console.error('[errorHandler]', logBase);
  }

  // Build client-safe body
  const body = {
    error: {
      code,
      message,
      request_id: rid || undefined,
    },
  };

  // In non-production, expose stack & (safe) details to aid debugging
  if (!isProd) {
    if (err?.stack) body.error.stack = err.stack;
    if (isAppErr && err?.details !== undefined) body.error.details = err.details;
  }

  // HEAD requests should not include a response body
  if (req?.method === 'HEAD') {
    return res.status(status).end();
  }

  return res.status(status).json(body);
};
