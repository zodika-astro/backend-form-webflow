// payments/mercadoPago/router.webhook.js

const express = require('express');
const router = express.Router();
const mpWebhookAuth = require('../../middlewares/mpWebhookAuth');
const mpController = require('./controller');

const secret = process.env.WEBHOOK_PATH_SECRET || '';
const path = secret ? `/webhook/mercadopago/${secret}` : '/webhook/mercadopago';

router.get(path, (req, res) => res.status(200).send('OK'));
router.post(path, mpWebhookAuth, mpController.handleWebhook);

module.exports = router;
