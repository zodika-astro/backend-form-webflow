// config/env.js

const dotenv = require('dotenv');
const envalid = require('envalid');
const { cleanEnv, url, str, num } = envalid;

dotenv.config();

module.exports = cleanEnv(process.env, {
  DATABASE_URL: url({ desc: 'Postgres connection string' }),
  PAGBANK_API_TOKEN: str({ desc: 'PagBank API authentication token' }),
  WEBFLOW_DOMAIN: url({ desc: 'Webflow site domain for referer validation' }),
});
