// payments/payPal/router.return.js
'use strict';

/**
 * PayPal Return Router
 * --------------------
 * - Handle browser-initiated operations for PayPal:
 *   * Create checkout/order
 *   * Capture approved payments
 *   * Optional status polling and SSE stream
 * - No business logic here: delegate to controller.
 * - Production niceties: async error capture, no-store caching, observability headers.
 *
 * Mount point:
 *   app.use('/paypal', paypalReturnRouter);
 *
 * Routes:
 *   POST /paypal/checkout        -> create PayPal order (intent to pay)
 *   POST /paypal/capture         -> capture approved PayPal order
 *   GET  /paypal/status          -> lookup normalized payment status (optional)
 *   GET  /paypal/stream          -> SSE status stream (optional)
 */

const express = require('express');
const router = express.Router();
const paypalController = require('./controller');

/** Wrap async handlers to propagate errors to Express error pipeline. */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Observability/security headers for all responses from this router. */
router.use((req, res, next) => {
  const rid =
    req.reqId ||
    req.requestId ||
    req.get('x-request-id') ||
    req.get('x-correlation-id');

  if (rid) {
    res.set('X-Request-Id', String(rid));
    res.set('X-Correlation-Id', String(rid));
  }

  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

/**
 * POST /paypal/checkout
 * Creates a PayPal order for the given request/product.
 */
router.post('/checkout', asyncHandler(paypalController.createCheckout));

/**
 * POST /paypal/capture
 * Captures an approved PayPal order (called from frontend after onApprove).
 */
router.post('/capture', asyncHandler(paypalController.captureOrder));

/**
 * GET /paypal/status?request_id=...
 * Optional safety polling endpoint to check normalized payment status.
 */
router.get('/status', asyncHandler(paypalController.getPaymentStatus));

/**
 * GET /paypal/stream?request_id=...
 * Optional SSE endpoint to stream payment status updates in real time.
 */
router.get('/stream', asyncHandler(paypalController.streamStatus));

/** 405 for unsupported methods under this mount. */
router.all('*', (req, res) =>
  res.status(405).json({ error: 'method_not_allowed' })
);

module.exports = router;
