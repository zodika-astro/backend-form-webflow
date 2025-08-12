// index.js
// Carrega variáveis de ambiente e configura o pool do banco de dados antes de tudo.
require('./config/env'); // valida ENV com envalid
require('./db/db');      // inicializa pool do PG

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares centrais
const corsMiddleware = require('./middlewares/cors');
const errorHandlerMiddleware = require('./middlewares/errorHandler');

// Routers e controllers
const birthchartRouter = require('./modules/birthchart/router');
const pagbankWebhookRouter = require('./payments/pagBank/router.webhook');
const pagbankReturnRouter  = require('./payments/pagBank/router.return.js');
const pagbankController    = require('./payments/pagBank/controller');

// Middleware globais
app.use(corsMiddleware);
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));


// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// ======================
// Módulo Birthchart
// ======================
app.use('/birthchart', birthchartRouter);

// ======================
// Módulo PagBank
// ======================
// Padrão do projeto em /pagBank
app.use('/pagBank', pagbankWebhookRouter);
app.use('/pagBank', pagbankReturnRouter);

// ---- Compatibilidade de rotas ----
// Mantém o endpoint público já configurado no PagBank:
app.use('/', pagbankWebhookRouter); // serve POST /webhook/pagbank

// Garante o retorno em camel case exatamente como desejado:
app.get('/pagBank/return', pagbankController.handleReturn);

// Handler de erros (por último)
app.use(errorHandlerMiddleware);

// Start
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
