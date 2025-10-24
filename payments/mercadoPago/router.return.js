// payments/mercadoPago/router.return.js
'use strict';

/**
 * Mercado Pago Return Router
 * --------------------------
 * - Handle user redirections after checkout (success/failure/pending).
 * - No business logic here: delegate to controller.
 * - Production niceties: async error capture, HEAD support, no-store caching.
 *
 * Mount point:
 *   app.use('/mercadoPago', mpReturnRouter);
 *
 * Routes:
 *   GET|HEAD /mercadoPago/return[/]
 *   GET|HEAD /mercadoPago/return/success
 *   GET|HEAD /mercadoPago/return/failure
 *   GET|HEAD /mercadoPago/return/pending
 */

const express = require('express');
const router = express.Router();
const mpController = require('./controller');

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

/** Main return endpoint (tolerate trailing slash) */
router.get(['/return', '/return/'], asyncHandler(mpController.handleReturn));
router.head(['/return', '/return/'], asyncHandler(mpController.handleReturn));

/** Back URLs aliases commonly used by MP */
router.get('/return/success', asyncHandler(mpController.handleReturn));
router.get('/return/failure', asyncHandler(mpController.handleReturn));
router.get('/return/pending', asyncHandler(mpController.handleReturn));

router.head('/return/success', asyncHandler(mpController.handleReturn));
router.head('/return/failure', asyncHandler(mpController.handleReturn));
router.head('/return/pending', asyncHandler(mpController.handleReturn));

router.get('/mercadoPago/status', controller.getPaymentStatus);
router.get('/mercadoPago/stream', controller.streamStatus);

/** 405 for unsupported methods under this mount. */
router.all('*', (req, res) => res.status(405).json({ error: 'method_not_allowed' }));

module.exports = router;
