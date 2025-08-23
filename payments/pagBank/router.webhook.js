// payments/pagbank/router.webhook.js

const express = require('express');
const router = express.Router();
const pagbankWebhookAuth = require('../../middlewares/pagbankWebhookAuth');
const pagbankController = require('./controller');

const secret = process.env.WEBHOOK_PATH_SECRET || ''; 
const path = secret ? `/webhook/pagbank/${secret}` : '/webhook/pagbank';

router.post(path, pagbankWebhookAuth, pagbankController.handleWebhook);

module.exports = router;
