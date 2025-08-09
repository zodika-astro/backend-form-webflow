// src/config/env.js

const dotenv = require('dotenv');
const envalid = require('envalid');
const { cleanEnv, url, str, num } = envalid;

dotenv.config();

module.exports = cleanEnv(process.env, {
  // Variável de ambiente para a string de conexão do banco de dados
  DATABASE_URL: url({ desc: 'Postgres connection string' }),

  // Token para autenticação com a API do PagBank
  PAGBANK_API_TOKEN: str({ desc: 'PagBank API authentication token' }),

  // Chave secreta para verificar a autenticidade dos webhooks do PagBank
  PAGBANK_WEBHOOK_SECRET: str({ desc: 'PagBank webhook secret key' }),

  // Domínio do seu site no Webflow para validação do cabeçalho Referer
  WEBFLOW_DOMAIN: url({ desc: 'Webflow site domain for referer validation' }),

  // Preço do produto de mapa astral em centavos
  BIRTHCHART_PRICE_CENTS: num({ desc: 'Birthchart price in cents' }),

  // URL para a qual o PagBank deve enviar as notificações de webhook
  PAGBANK_WEBHOOK_URL: url({ desc: 'PagBank webhook URL' }),
});
