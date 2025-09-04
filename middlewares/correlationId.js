// middlewares/correlationId.js
'use strict';

/**
 * Correlation-id middleware
 * -------------------------
 * Responsibilities:
 *  - Read an incoming correlation id from headers (x-request-id | x-correlation-id | traceparent).
 *  - Validate and, if missing/invalid, generate a new stable id (UUIDv4).
 *  - Expose id on request object (req.reqId) and AsyncLocalStorage context.
 *  - Return the id back to the client via response headers for easier troubleshooting.
 *
 * Notes:
 *  - Keep this middleware as early as possible in the chain, so all downstream logs carry reqId.
 *  - This module has zero external dependencies; uses node:crypto for UUID.
 */

const crypto = require('crypto');
const { runWith, set: setCtx, getAll } = require('../utils/requestContext');

// Basic allow-list for IDs coming from the edge
const SAFE_ID_RE = /^[a-zA-Z0-9._\-:@]{6,128}$/;

// Extract a candidate correlation id from common headers
function pickIncomingId(req) {
  const h = (name) => req.get(name) || req.headers?.[name];

  // Priority: x-request-id, x-correlation-id, then traceparent (W3C)
  const id =
    h('x-request-id') ||
    h('x-correlation-id') ||
    (h('traceparent') ? String(h('traceparent')).split('-')[1] : null);

  return id && SAFE_ID_RE.test(String(id)) ? String(id) : null;
}

// Generate UUIDv4 (falls back to random string if not available)
function newId() {
  try { return crypto.randomUUID(); }
  catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
}

function correlationIdMiddleware(req, res, next) {
  const incoming = pickIncomingId(req);
  const reqId = incoming || newId();

  // Prepare the initial per-request context
  const baseCtx = {
    reqId,
    method: req.method,
    path: req.originalUrl || req.url,
    ip: req.ip, // honors app.set('trust proxy', ...)
    ua: req.get('user-agent') || '',
    start: Date.now(),
  };

  // Run downstream middlewares/handlers inside the ALS context
  return runWith(baseCtx, () => {
    // Also expose on req and res.locals for convenience
    req.reqId = reqId;
    res.locals.reqId = reqId;

    // Make sure response carries the id back to clients/NGINX/APM
    res.setHeader('X-Request-Id', reqId);
    res.setHeader('X-Correlation-Id', reqId);

    // Optional: on finish, store duration in context (useful for later loggers/metrics)
    res.on('finish', () => {
      const ctx = getAll();
      // Attach duration in ms (won't log here; logger/metrics middleware can read it)
      if (ctx && typeof ctx.start === 'number') {
        setCtx('durationMs', Date.now() - ctx.start);
      }
    });

    next();
  });
}

module.exports = correlationIdMiddleware;
