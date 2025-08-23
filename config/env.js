// config/env.js

const dotenv = require('dotenv');
const { cleanEnv, url, str, num } = require('envalid');

dotenv.config();

const env = cleanEnv(process.env, {
  DATABASE_URL: url({ desc: 'Postgres connection string' }),
  PAGBANK_API_TOKEN: str({ desc: 'PagBank API authentication token' }),
  PAGBANK_BASE_URL: url({ desc: 'PagBank URL' }),
  ALLOWED_REFERERS: str({ desc: ''  }),
  ALLOWED_ORIGINS:  str({ desc: ''  }),
});

module.exports = { env };
