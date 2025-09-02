// config/env.js

const dotenv = require('dotenv');
const { cleanEnv, url, str, num, bool } = require('envalid');

dotenv.config();

const env = cleanEnv(process.env, {
  // Core
  DATABASE_URL: url({ desc: 'Postgres connection string' }),
  PUBLIC_BASE_URL: url({ desc: 'Public base URL of this backend (https://... )' }),
  ALLOWED_REFERERS: str({ default: '', desc: 'Comma-separated allowed Referers' }),
  ALLOWED_ORIGINS:  str({ default: '', desc: 'Comma-separated allowed Origins' }),

  // Google
  GOOGLE_MAPS_API_KEY: str({ default: '' }),

  // Mercado Pago
  MP_ACCESS_TOKEN:   str({ desc: 'Mercado Pago Access Token' }),
  MP_WEBHOOK_URL:    url({ desc: 'Public webhook URL configured in Mercado Pago' }),
  MP_WEBHOOK_SECRET: str({ desc: 'Secret used to verify x-signature HMAC' }),
  WEBHOOK_PATH_SECRET: str({ default: '', desc: 'Optional path secret appended to /webhook/mercadopago' }),

  // Checkout UX
  PAYMENT_FAILURE_URL: url({ default: 'https://www.zodika.com.br/payment-fail' }),

  // Dev toggles / providers
  ALLOW_UNSIGNED_WEBHOOKS: bool({ default: false }),
  PAGBANK_ENABLED: bool({ default: false }),

  // Legacy PagBank
  PAGBANK_API_TOKEN: str({ default: '' }),
  PAGBANK_BASE_URL:  url({ default: 'https://sandbox.api.pagseguro.com' }),
});

module.exports = { env };
