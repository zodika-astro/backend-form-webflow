// config/env.js

const dotenv = require('dotenv');
const envalid = require('envalid');
const { cleanEnv, url, str, num } = envalid;

dotenv.config();

module.exports = cleanEnv(process.env, {
  // Variável de ambiente para a string de conexão do banco de dados
  DATABASE_URL: url({ desc: 'Postgres connection string' }),

  // Token para autenticação com a API do PagBank
  PAGBANK_API_TOKEN: str({ desc: 'PagBank API authentication token' }),

});
