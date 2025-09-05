// payments/mercadoPago/router.return.js
'use strict';

/**
 * Mercado Pago Return Router
 * --------------------------
 * Purpose
 *  - Handle user redirections coming back from Mercado Pago after checkout.
 *  - Delegate the actual processing to the controller (no business logic here).
 *  - Keep responses non-cacheable and echo a stable correlation id header.
 *
 * Mount point (important):
 *  - This router is mounted under /mercadoPago in the main app:
 *      app.use('/mercadoPago', mpReturnRouter);
 *
 * Routes
 *  - GET /mercadoPago/return
 *  - GET /mercadoPago/return/success
 *  - GET /mercadoPago/return/failure
 *  - GET /mercadoPago/return/pending
 */

const express = require('express');
const router = express.Router();

const mpController = require('./controller');

// Observability middleware: echo correlation id and disable caches
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
  next();
});

// Main return endpoint (controller decides how to render/redirect)
router.get('/return', mpController.handleReturn);

// Optional aliases matching MP back_urls
router.get('/return/success', mpController.handleReturn);
router.get('/return/failure', mpController.handleReturn);
router.get('/return/pending', mpController.handleReturn);

module.exports = router;
