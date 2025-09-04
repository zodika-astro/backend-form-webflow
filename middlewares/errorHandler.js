// middlewares/errorHandler.js
'use strict';

/**
 * Global Error Handler
 * --------------------
 * Purpose
 *   - Translate thrown exceptions into clean, stable JSON responses.
 *   - Emit structured logs (no PII) with request correlation.
 *   - Avoid leaking stack traces in production.
 *
 * Conventions
 *   - `err.status`  → HTTP status code (defaults to 500).
 *   - `err.code`    → stable, machine-readable error code (see utils/errorCodes).
 *   - `err.details` → safe, serializable object with extra info for clients.
 *   - `req.requestId` and/or `req.log` should be set by upstream middleware.
 */

const baseLogger = require('../utils/logger').child('http.error');
const isProd = (process.env.NODE_ENV || 'production') === 'production';

module.exports = function errorHandler(err, req, res, _next) {
  const statusRaw = Number(err?.status);
  const status = Number.isInteger(statusRaw) && statusRaw >= 400 && statusRaw <= 599 ? statusRaw : 500;

  // Prefer explicit code; otherwise choose a generic one by class of error
  const code = String(
    err?.code ||
    (status >= 500 ? 'internal_error' : 'bad_request')
  );

  const rid = req?.requestId || null;
  const log = req?.log || baseLogger;

  // Surface correlation id for support/debugging
  if (rid) res.set('X-Request-Id', String(rid));

  // Prevent caches from storing error payloads
  res.set('Cache-Control', 'no-store');

  // Structured server log (avoid dumping PII or large payloads)
  const logPayload = {
    code,
    status,
    rid,
    method: req?.method,
    path: req?.originalUrl,
    msg: err?.message,
  };
  if (!isProd && err?.stack) {
    logPayload.stack = err.stack;
  }
  log.error(logPayload, 'request failed');

  // Minimal, client-safe error body
  const body = {
    error: {
      code,
      message: status >= 500
        ? 'Internal server error'
        : (err?.message || 'Request error'),
      request_id: rid || undefined,
    },
  };

  // Include safe details when provided
  if (err?.details && typeof err.details === 'object') {
    body.error.details = err.details;
  }

  // In non-prod, include stack for easier debugging
  if (!isProd && err?.stack) {
    body.error.stack = err.stack;
  }

  res.status(status).json(body);
};
