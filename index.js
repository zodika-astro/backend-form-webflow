// index.js
'use strict';

require('./config/env'); // validates ENV with envalid (loads .env, etc.)
require('./db/db');      // initializes PG pool

const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
const corsMiddleware = require('./middlewares/cors');
const errorHandlerMiddleware = require('./middlewares/errorHandler');

// Routers and controllers
const birthchartRouter = require('./modules/birthchart/router');

// PagBank
const pagbankWebhookRouter = require('./payments/pagBank/router.webhook');
const pagbankReturnRouter  = require('./payments/pagBank/router.return.js');
const pagbankController    = require('./payments/pagBank/controller');

// Mercado Pago
const mpWebhookRouter = require('./payments/mercadoPago/router.webhook');
const mpReturnRouter  = require('./payments/mercadoPago/router.return');
const mpController    = require('./payments/mercadoPago/controller');

/**
 * Raw body strategy for webhook signature validation
 * --------------------------------------------------
 * Many PSPs (e.g., Mercado Pago, PagBank) require computing an HMAC/signature over the
 * *exact* raw request body bytes. If JSON parsing runs before signature verification,
 * even a single whitespace change can invalidate the signature.
 *
 * Approach:
 * 1) For webhook routes only (`/webhook/...`), we register `express.raw()` so `req.body`
 *    is a Buffer. We also store the original bytes in `req.rawBody` (Buffer) via `verify`.
 * 2) For all other routes, we use `express.json()` and also keep a copy of the raw bytes
 *    in `req.rawBody` for diagnostics (optional).
 *
 * Notes:
 * - The `express.json()` below explicitly *skips* `/webhook/...` paths to avoid double parsing.
 * - In the webhook routers, compute HMAC **against `req.rawBody` (Buffer)** before parsing.
 * - After signature verification, parse with `JSON.parse(req.rawBody)` if you need an object.
 */

// Helper to stash the raw bytes without converting to string (use Buffer for HMAC)
function rawBodySaver(req, res, buf) {
  if (buf && buf.length) {
    req.rawBody = Buffer.from(buf); // keep exact bytes for signature verification
  }
}

// 1) Raw body *only* for webhook endpoints — must be registered BEFORE any JSON parser
app.use('/webhook/mercadopago', express.raw({ type: '*/*', limit: '1mb', verify: rawBodySaver }));
app.use('/webhook/pagbank',     express.raw({ type: '*/*', limit: '1mb', verify: rawBodySaver }));

// 2) Global CORS (safe to run for all routes, including webhooks)
app.use(corsMiddleware);

// 3) JSON parser for non-webhook endpoints, while still keeping a copy of the raw payload
app.use(express.json({
  // Skip JSON parsing for webhook routes to preserve exact bytes
  type: (req) => !req.path.startsWith('/webhook/'),
  limit: '1mb',
  verify: (req, res, buf) => {
    if (!req.path.startsWith('/webhook/')) {
      rawBodySaver(req, res, buf);
    }
  }
}));

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Public assets
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '30d', etag: true }));

// Product modules
app.use('/birthchart', birthchartRouter);

// Payments modules (PagBank)
// - Webhook router exposes e.g. /webhook/pagbank/:token (already covered by express.raw above)
app.use('/pagBank', pagbankWebhookRouter);
if (process.env.PAGBANK_ENABLED === 'true') {
  app.use('/pagBank', pagbankReturnRouter);
  app.use('/', pagbankWebhookRouter);
  app.get('/pagBank/return', pagbankController.handleReturn);
}

// Payments modules (Mercado Pago)
// - Webhook router exposes /webhook/mercadopago[/<secret>] (already covered by express.raw above)
app.use('/mercadoPago', mpReturnRouter); // /mercadoPago/return[/*]
app.use('/', mpWebhookRouter);           // exposes /webhook/mercadopago[/<secret>]
app.get('/mercadoPago/return', mpController.handleReturn); // optional direct shortcut

// Centralized error handler (keep last)
app.use(errorHandlerMiddleware);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on port ${PORT}`);
});
