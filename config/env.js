// config/env.js

import dotenv from 'dotenv';
import { cleanEnv, url, str } from 'envalid';

dotenv.config();

export const env = cleanEnv(process.env, {
  DATABASE_URL: url({ desc: 'Postgres connection string' }),
  PAGBANK_TOKEN: str({ desc: 'PagBank authentication token' })
});
