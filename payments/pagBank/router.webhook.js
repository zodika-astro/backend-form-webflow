// payments/pagbank/router.webhook.js

const express = require('express');
const router = express.Router();
const pagbankWebhookAuth = require('../../middlewares/pagbankWebhookAuth');
const pagbankController = require('./controller');

router.post('/webhook/pagbank', pagbankWebhookAuth, pagbankController.handleWebhook);

module.exports = router;
