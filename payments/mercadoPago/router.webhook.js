// payments/mercadoPago/router.webhook.js
'use strict';

const express = require('express');
const router = express.Router();
const mpWebhookAuth = require('../../middlewares/mpWebhookAuth');
const mpController = require('./controller');

/**
 * Webhook endpoint for Mercado Pago
 * ---------------------------------
 * - Path can include an optional secret suffix for obscurity-through-URL (not a replacement for HMAC).
 * - The Express app registers `express.raw()` for `/webhook/mercadopago*` so `req.body` is a Buffer.
 * - The mpWebhookAuth middleware will validate signature/timestamp and then parse JSON safely.
 */
const secret = process.env.WEBHOOK_PATH_SECRET || '';
const path = secret ? `/webhook/mercadopago/${secret}` : '/webhook/mercadopago';

// Simple liveness check for monitoring
router.get(path, (req, res) => res.status(200).send('OK'));

// Webhook receiver (POST): signature & anti-replay are enforced in `mpWebhookAuth`
router.post(path, mpWebhookAuth, mpController.handleWebhook);

module.exports = router;
