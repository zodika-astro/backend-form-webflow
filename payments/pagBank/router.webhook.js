// payments/pagbank/router.webhook.js
'use strict';

const express = require('express');
const router = express.Router();
const pagbankWebhookAuth = require('../../middlewares/pagbankWebhookAuth');
const pagbankController = require('./controller');

/**
 * PagBank Webhook Router
 * ----------------------
 * - Path supports an optional secret suffix for obscurity-through-URL. This is NOT a substitute
 *   for signature verification — `pagbankWebhookAuth` is mandatory.
 * - The application (index.js) must register `express.raw()` for the `/webhook/pagbank*` prefix
 *   *before* any JSON parsers, so `req.rawBody` remains an exact Buffer of the incoming payload.
 * - This router does not attach any body parsers to avoid double-parsing.
 */

const secret = process.env.WEBHOOK_PATH_SECRET || '';
const path = secret ? `/webhook/pagbank/${secret}` : '/webhook/pagbank';

// Lightweight liveness endpoint for monitors (does not validate signatures)
router.get(path, (req, res) => res.status(200).send('OK'));

// Optional: HEAD for health checks behind certain load balancers
router.head(path, (req, res) => res.sendStatus(200));

// Webhook receiver (POST only): signature/anti-replay enforced by `pagbankWebhookAuth`.
// The controller should return quickly (200/204) so the PSP does not redeliver excessively.
router.post(path, pagbankWebhookAuth, pagbankController.handleWebhook);

// Fail closed for any other method to reduce the attack surface
router.all(path, (req, res) => res.status(405).json({ message: 'Method Not Allowed' }));

module.exports = router;
