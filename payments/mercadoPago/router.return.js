// payments/mercadoPago/router.return.js

const express = require('express');
const router = express.Router();
const mpController = require('./controller');

// Mesmo padrão do PagBank — montado sob /mercadopago no app principal
router.get('/return', mpController.handleReturn);

// Aliases opcionais (se usar back_urls do MP)
router.get('/return/success', mpController.handleReturn);
router.get('/return/failure', mpController.handleReturn);
router.get('/return/pending', mpController.handleReturn);

module.exports = router;
