// payments/pagbank/router.return.js
'use strict';

/**
 * PagBank Return Router
 * ---------------------
 * - Handle user redirections after checkout.
 * - No business logic here: delegate to controller.
 * - Production niceties: async error capture, HEAD support, no-store caching.
 *
 * Mount point:
 *   app.use('/pagBank', pagbankReturnRouter);
 *
 * Routes:
 *   GET|HEAD /pagBank/return[/]
 */

const express = require('express');
const router = express.Router();
const pagbankController = require('./controller');

/** Wrap async handlers to propagate errors to Express error pipeline. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Observability/security headers for all responses from this router. */
router.use((req, res, next) => {
  const rid = req.reqId || req.requestId || req.get('x-request-id') || req.get('x-correlation-id');
  if (rid) {
    res.set('X-Request-Id', String(rid));
    res.set('X-Correlation-Id', String(rid));
  }
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

/** GET/HEAD aliases (tolerate trailing slash). */
router.get(['/return', '/return/'], asyncHandler(pagbankController.handleReturn));
router.head(['/return', '/return/'], asyncHandler(pagbankController.handleReturn));

/** 405 for unsupported methods under this mount. */
router.all('*', (req, res) => res.status(405).json({ error: 'method_not_allowed' }));

module.exports = router;
