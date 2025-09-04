// middlewares/errorHandler.js
'use strict';

/**
 * Global Error Handler
 * --------------------
 * - Converts thrown errors into clean JSON responses.
 * - Emits structured logs (no PII) with request correlation.
 * - Avoids leaking stacks in production.
 */

const rootLogger = require('../utils/logger');
const baseLogger = (typeof rootLogger?.child === 'function')
  ? rootLogger.child('error')
  : rootLogger;

module.exports = function errorHandler(err, req, res, _next) {
  const status = Number(err?.status || 500);
  const code   = String(err?.code || 'internal_error');
  const rid    = req?.requestId || null;

  // Prefer req.log when provided; gracefully handle stubs without .child()
  const parentLog = req?.log || baseLogger || {};
  const log = (typeof parentLog.child === 'function') ? parentLog.child('handler') : parentLog;

  if (rid) res.set('X-Request-Id', String(rid));

  const logPayload = {
    status,
    code,
    rid,
    method: req?.method,
    path: req?.originalUrl,
    msg: err?.message,
  };

  if (process.env.NODE_ENV !== 'production' && err?.stack) {
    logPayload.stack = err.stack;
  }

  // If test stubs pass a plain object, ensure we don't crash:
  if (typeof log?.error === 'function') {
    log.error(logPayload, 'request failed');
  } else {
    // Last-resort logging
    // eslint-disable-next-line no-console
    console.error('[errorHandler]', logPayload);
  }

  const body = {
    error: {
      code,
      message: status >= 500 ? 'Internal server error' : (err?.message || 'Request error'),
      request_id: rid || undefined,
    }
  };

  if (process.env.NODE_ENV !== 'production' && err?.stack) {
    body.error.stack = err.stack;
  }

  res.status(status).json(body);
};
