// index.js

require('./config/env'); // valida ENV com envalid
require('./db/db');      // inicializa pool do PG

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const path = require('path');

// Middlewares
const corsMiddleware = require('./middlewares/cors');
const errorHandlerMiddleware = require('./middlewares/errorHandler');

// Routers and controllers
const birthchartRouter      = require('./modules/birthchart/router');

// PagBank
const pagbankWebhookRouter  = require('./payments/pagBank/router.webhook');
const pagbankReturnRouter   = require('./payments/pagBank/router.return.js');
const pagbankController     = require('./payments/pagBank/controller');

// ✅ Mercado Pago
const mpWebhookRouter       = require('./payments/mercadoPago/router.webhook');
const mpReturnRouter        = require('./payments/mercadoPago/router.return');
const mpController          = require('./payments/mercadoPago/controller');

// Global Middleware 
app.use(corsMiddleware);
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// public
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '30d', etag: true }));

// product modules
app.use('/birthchart', birthchartRouter);

// payments modules (PagBank)
app.use('/pagBank', pagbankWebhookRouter);
app.use('/pagBank', pagbankReturnRouter);
app.use('/', pagbankWebhookRouter);
app.get('/pagBank/return', pagbankController.handleReturn);

// payments modules (Mercado Pago)
app.use('/mercadoPago', mpReturnRouter); // /mercadoPago/return[/*]
app.use('/', mpWebhookRouter);           // expõe /webhook/mercadopago[/<secret>]
app.get('/mercadoPago/return', mpController.handleReturn); // atalho direto (opcional)

app.use(errorHandlerMiddleware);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
