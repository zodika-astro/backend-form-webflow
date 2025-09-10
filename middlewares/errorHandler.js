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
 */

const crypto = require('crypto');
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
function toRetryAfterSeconds(source) {
  const ms = source?.retryAfterMs ?? source;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 1000));
}

/** Generate a correlation id if missing */
function ensureRequestId(req) {
  return (
    req?.requestId ||
    req?.get?.('x-request-id') ||
    req?.get?.('x-correlation-id') ||
    (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))
  );
}

module.exports = function errorHandler(err, req, res, next) {
  // If headers are already sent, delegate to Express default handler
  if (res.headersSent) return next?.(err);

  const isAppErr = !!(err?.isAppError || err?.name === 'AppError');

  // Status + code
  const status = normalizeStatus(err?.status);
  const code   = String(err?.code || (status >= 500 ? 'internal_error' : 'request_error'));

  // Correlation
  const rid = ensureRequestId(req);
  if (rid) res.set('X-Request-Id', String(rid));

  // Honor Retry-After hints if coherent with status
  const retryAfterSec = toRetryAfterSeconds(err?.details) ?? toRetryAfterSeconds(err);
  if (retryAfterSec != null && [429, 502, 503, 504].includes(status)) {
    res.set('Retry-After', String(retryAfterSec));
  }

  // Defensive no-cache headers
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.set('Pragma', 'no-cache');

  // Choose safe message
  const message = status >= 500
    ? 'Internal server error'
    : (err?.message ? String(err.message) : 'Request error');

  // Log payload (never log raw body/PII)
  const logBase = {
    rid,
    status,
    code,
    method: req?.method,
    path: req?.originalUrl || req?.url,
    msg: err?.message ? String(err.message) : undefined,
  };

  if (isAppErr && err?.details !== undefined) {
    logBase.details = err.details;
  }
  if (!isProd && err?.stack) {
    logBase.stack = err.stack;
  }

  // Structured logging
  const parentLog = req?.log || baseLogger;
  const log = (typeof parentLog?.child === 'function') ? parentLog.child('handler') : parentLog;
  if (typeof log?.error === 'function') {
    log.error(logBase, 'request failed');
  } else {
    // eslint-disable-next-line no-console
    console.error('[errorHandler]', logBase);
  }

  // Client-safe body
  const body = {
    error: {
      code,
      message,
      request_id: rid,
    },
  };

  // In non-production, expose stack & safe details
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
