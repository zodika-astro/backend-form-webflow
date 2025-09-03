// observability/healthz.js
'use strict';

/**
 * Lightweight /healthz endpoint with DB ping.
 * - Returns 200 {"status":"ok","db":"ok"} when DB is reachable.
 * - Returns 503 when DB ping fails (no sensitive info leaked).
 *
 * Usage (in your index.js):
 *   const healthzRouter = require('./observability/healthz');
 *   app.use('/healthz', healthzRouter);
 */

const express = require('express');
const router = express.Router();
const db = require('../db/db'); // keep your existing DB wrapper

router.get('/', async (_req, res) => {
  try {
    await db.query('SELECT 1'); // trivial ping
    return res.status(200).json({ status: 'ok', db: 'ok' });
  } catch {
    // Do not expose error details here to avoid leaking infra internals
    return res.status(503).json({ status: 'degraded', db: 'unreachable' });
  }
});

module.exports = router;
