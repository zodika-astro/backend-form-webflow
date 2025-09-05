// middlewares/correlationId.js
'use strict';

/**
 * Correlation-id middleware
 * -------------------------
 * Responsibilities:
 *  - Read an incoming correlation id from headers (x-request-id | x-correlation-id | traceparent).
 *  - Validate and, if missing/invalid, generate a new stable id (UUIDv4).
 *  - Expose id on request object as BOTH `req.requestId` (project-wide convention) and `req.reqId`.
 *  - Populate AsyncLocalStorage context so logs/metrics can read it.
 *  - Echo the id back via response headers for easier troubleshooting.
 *
 * Notes:
 *  - Keep this middleware as early as possible in the chain.
 *  - Zero external dependencies besides Node's crypto.
 */

const crypto = require('crypto');
const { runWith, set: setCtx, getAll, bind } = require('../utils/requestContext');

// Strict allow-list for correlation IDs that arrive from the edge
const SAFE_ID_RE = /^[a-zA-Z0-9._\-:@]{6,128}$/;

/** Pick a candidate id from common headers; validate with SAFE_ID_RE. */
function pickIncomingId(req) {
  const h = (name) => req.get?.(name) || req.headers?.[name];

  // Priority: x-request-id, x-correlation-id, then W3C traceparent (trace-id segment)
  const direct =
    h('x-request-id') ||
    h('x-correlation-id');

  if (direct && SAFE_ID_RE.test(String(direct))) return String(direct);

  const tp = h('traceparent');
  if (tp) {
    // traceparent format: "00-<traceId>-<spanId>-<flags>"
    const parts = String(tp).split('-');
    if (parts.length >= 2) {
      const traceId = parts[1];
      if (/^[a-f0-9]{32}$/i.test(traceId)) return traceId;
    }
  }
  return null;
}

/** Generate UUIDv4; fallback to a high-entropy string if not available. */
function newId() {
  try { return crypto.randomUUID(); }
  catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
}

function correlationIdMiddleware(req, res, next) {
  const incoming = pickIncomingId(req);
  const reqId = incoming || newId();

  // Initial per-request context (read by logger via AsyncLocalStorage)
  const baseCtx = {
    reqId,
    method: req.method,
    path: req.originalUrl || req.url,
    ip: req.ip, // honors app.set('trust proxy', ...)
    ua: req.get?.('user-agent') || '',
    start: Date.now(),
  };

  // Run downstream middlewares/handlers inside this context
  return runWith(baseCtx, () => {
    // Expose on request with both property names used across the codebase
    req.requestId = reqId; // <- project-wide convention
    req.reqId = reqId;

    // Also provide on res.locals for templates/diagnostics
    res.locals.requestId = reqId;
    res.locals.reqId = reqId;

    // Always echo back to client/proxy/APM
    res.setHeader('X-Request-Id', reqId);
    res.setHeader('X-Correlation-Id', reqId);

    // On response finish, update duration in the context.
    // Bind the handler to preserve ALS context across the event boundary.
    res.on('finish', bind(() => {
      const ctx = getAll();
      if (ctx && typeof ctx.start === 'number') {
        setCtx('durationMs', Date.now() - ctx.start);
      }
    }));

    next();
  });
}

module.exports = correlationIdMiddleware;
