// payments/pagBank/router.return.js
'use strict';

/**
 * PagBank Return Router
 * ---------------------
 * Purpose
 *  - Handle user redirections coming back from PagBank after checkout.
 *  - Delegate the actual processing to the controller (no business logic here).
 *  - Keep responses non-cacheable and echo a stable correlation id header.
 *
 * Mount point (important):
 *  - This router is mounted under /pagBank (capital B) in the main app:
 *      app.use('/pagBank', pagbankReturnRouter);
 *
 * Route
 *  - GET /pagBank/return
 */

const express = require('express');
const router = express.Router();

const pagbankController = require('./controller');

// Observability middleware: echo correlation id and disable caches
router.use((req, res, next) => {
  // Support both properties just in case (req.reqId from correlation middleware; req.requestId used elsewhere)
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
router.get('/return', pagbankController.handleReturn);

module.exports = router;
