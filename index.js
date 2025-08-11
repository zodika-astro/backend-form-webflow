// Carrega variáveis de ambiente e configura o pool do banco de dados antes de tudo.
require('./config/env');
const db = require('./db/db');

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Importa os middlewares centrais
const corsMiddleware = require('./middlewares/cors');
const errorHandlerMiddleware = require('./middlewares/errorHandler');

// Importa os roteadores de cada módulo
const birthchartRouter = require('./modules/birthchart/router');
const pagbankWebhookRouter = require('./modules/pagBank/router.webhook');
const pagbankReturnRouter = require('./modules/pagBank/router.return');

// Middleware para habilitar CORS e processar JSON
app.use(corsMiddleware);
app.use(express.json());

// Health check da API
app.get('/health', (req, res) => res.status(200).send('OK'));

// Rotas do Módulo Birthchart
// A rota principal para o seu produto de mapa astral.
app.use('/birthchart', birthchartRouter);

// Rotas do Módulo PagBank
// Rota para o webhook do PagBank
app.use('/pagBank', pagbankWebhookRouter);

// Rota de retorno para o cliente após o checkout do PagBank
app.use('/pagBank', pagbankReturnRouter);

// Handler de erros centralizado (deve ser o último middleware)
app.use(errorHandlerMiddleware);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
