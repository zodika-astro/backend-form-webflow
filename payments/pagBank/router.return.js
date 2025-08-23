// payments/pagbank/router.return.js

const express = require('express');
const router = express.Router();
const pagbankController = require('./controller');

router.get('/return', pagbankController.handleReturn);

module.exports = router;
