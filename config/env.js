// config/env.js

const dotenv = require('dotenv');
const envalid = require('envalid');
const { cleanEnv, url, str, num } = envalid;

dotenv.config();

export const env = cleanEnv(process.env, {
  DATABASE_URL: url({ desc: 'Postgres connection string' }),
  PAGBANK_TOKEN: str({ desc: 'PagBank authentication token' }),
  WEBFLOW_DOMAIN: url({ desc: 'Webflow site domain for referer validation' })
});
