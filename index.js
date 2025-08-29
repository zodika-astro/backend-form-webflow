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
const birthchartRouter = require('./modules/birthchart/router');
const pagbankWebhookRouter = require('./payments/pagBank/router.webhook');
const pagbankReturnRouter  = require('./payments/pagBank/router.return.js');
const pagbankController    = require('./payments/pagBank/controller');

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

// payments modules
app.use('/pagBank', pagbankWebhookRouter);
app.use('/pagBank', pagbankReturnRouter);
app.use('/', pagbankWebhookRouter);

app.get('/pagBank/return', pagbankController.handleReturn);

app.use(errorHandlerMiddleware);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
