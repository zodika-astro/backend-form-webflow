'use strict';

/**
 * Global Error Handler
 * --------------------
 * Purpose:
 *   - Convert thrown errors/exceptions into clean JSON responses.
 *   - Emit structured logs (no PII) with request correlation.
 *   - Avoid leaking stack traces in production.
 *
 * Conventions:
 *   - `err.status` (HTTP status) and `err.code` (machine-readable code) are optional.
 *   - We always attach `X-Request-Id` to the response when available.
 */

const baseLogger = require('../utils/logger').child('error');

module.exports = function errorHandler(err, req, res, _next) {
  const status = Number(err?.status || 500);
  const code   = String(err?.code || 'internal_error');
  const rid    = req?.requestId || null;
  const log    = (req?.log || baseLogger).child('handler');

  // Surface correlation id to the client for support/debugging.
  if (rid) res.set('X-Request-Id', String(rid));

  // Structured log without PII or secrets.
  log.error({
    status,
    code,
    rid,
    method: req?.method,
    path: req?.originalUrl,
    msg: err?.message,
  }, 'unhandled error');

  // Minimal, client-safe payload.
  const body = {
    error: {
      code,
      message: status >= 500 ? 'Internal server error' : (err?.message || 'Request error'),
      request_id: rid || undefined,
    }
  };

  // Only show stack traces outside production.
  if (process.env.NODE_ENV !== 'production' && err?.stack) {
    body.error.stack = err.stack;
  }

  res.status(status).json(body);
};
