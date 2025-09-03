// middlewares/metrics.js
'use strict';

/**
 * Prometheus metrics for HTTP requests with graceful fallback.
 *
 * - If 'prom-client' is available, we expose:
 *     - default process/node metrics (prefixed 'zodika_')
 *     - a histogram: zodika_http_request_duration_seconds{method,route,status}
 *     - GET /metrics with Prometheus format
 * - If 'prom-client' is NOT installed, middleware is a no-op and /metrics returns 204.
 *
 * Usage (in your index.js):
 *   const { metricsMiddleware, metricsRouter } = require('./middlewares/metrics');
 *   app.use(metricsMiddleware);
 *   app.use('/metrics', metricsRouter);
 *
 * Notes:
 * - We intentionally avoid logging here to keep this middleware ultra-light.
 * - Route label tries req.route?.path; falls back to req.path (may be high-cardinality).
 */

const express = require('express');
let prom = null;

try {
  // Optional dependency — safe to miss in production until you enable it
  prom = require('prom-client');
} catch (_) {
  prom = null;
}

/* -------------------- No-op fallback (no prom-client) -------------------- */
if (!prom) {
  const noopMiddleware = (_req, _res, next) => next();
  const router = express.Router();
  router.get('/', (_req, res) => res.status(204).end()); // empty when metrics disabled
  module.exports = { metricsMiddleware: noopMiddleware, metricsRouter: router };
  return;
}

/* -------------------- Real implementation (with prom-client) ------------- */

// Collect default metrics (process, event loop, memory, etc.)
prom.collectDefaultMetrics({ prefix: 'zodika_' });

// Histogram for request duration
const httpHistogram = new prom.Histogram({
  name: 'zodika_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  // Buckets tuned for API latencies (adjust if needed)
  buckets: [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8],
});

function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  // Finish listener runs no matter what (success or error)
  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const seconds = Number(end - start) / 1e9;

    const method = (req.method || 'GET').toUpperCase();
    // Prefer the declared route path (e.g. '/api/foo/:id'), fallback to concrete path
    const route = (req.route && req.route.path) || req.path || 'unknown';
    const status = String(res.statusCode || 0);

    httpHistogram.labels(method, route, status).observe(seconds);
  });

  next();
}

// /metrics endpoint (Prometheus text format)
const metricsRouter = express.Router();
metricsRouter.get('/', async (_req, res) => {
  try {
    res.set('Content-Type', prom.register.contentType);
    const body = await prom.register.metrics();
    res.status(200).end(body);
  } catch {
    res.status(500).json({ message: 'metrics collection error' });
  }
});

module.exports = { metricsMiddleware, metricsRouter };
