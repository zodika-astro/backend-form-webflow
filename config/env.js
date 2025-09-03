// config/env.js
'use strict';

/**
 * Secure environment loading & validation
 * --------------------------------------
 * - Loads `.env` only in non-production to avoid shadowing managed secrets in prod.
 * - Validates variables with `envalid` (no secret values are ever logged).
 * - Marks sensitive keys as *required* in production (no defaults); in dev, allows empty defaults.
 * - Adds knobs for future secret providers (SECRET_PROVIDER) and rate-limit tuning.
 */

const isProd = process.env.NODE_ENV === 'production';

// Load dotenv only for local/dev workflows. In production, rely on the platform's secret store.
if (!isProd) {
  // You can override the path with ENV_FILE=.env.local, for example.
  // eslint-disable-next-line global-require
  require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
}

const { cleanEnv, url, str, num, bool } = require('envalid');

const env = cleanEnv(
  process.env,
  {
    // Runtime mode
    NODE_ENV: str({
      choices: ['development', 'test', 'production'],
      default: 'development',
      desc: 'Runtime environment',
    }),

    // Core
    DATABASE_URL: url({ desc: 'Postgres connection string' }),
    PUBLIC_BASE_URL: url({ desc: 'Public base URL of this backend (https://...)' }),

    // CORS/Referer policy
    ALLOWED_REFERERS: str({ default: '', desc: 'Comma-separated allowed Referers (full URLs/prefixes)' }),
    ALLOWED_ORIGINS:  str({ default: '', desc: 'Comma-separated allowed Origins (scheme + host + port)' }),
    STRICT_ORIGIN_PATHS: str({ default: '/birthchart', desc: 'Comma-separated path prefixes that require Origin' }),

    // Secret provider knobs (plug-in ready; default to env variables)
    SECRET_PROVIDER: str({
      default: 'env',
      desc: 'Secret backend: env | gcp | aws | vault | doppler (reserved for future use)',
    }),
    SECRET_CACHE_TTL_MS: num({
      default: 5 * 60 * 1000,
      desc: 'In-memory secret cache TTL (ms), for external secret managers',
    }),

    // Google (treat as secret in prod)
    GOOGLE_MAPS_API_KEY: str({
      default: isProd ? undefined : '',
      desc: 'Google Maps API key (required in production)',
    }),

    // Mercado Pago (secrets required in production)
    MP_ACCESS_TOKEN:   str({ default: isProd ? undefined : '', desc: 'Mercado Pago Access Token' }),
    MP_WEBHOOK_URL:    url({ default: isProd ? undefined : 'http://localhost:3000/webhook/mercadopago', desc: 'Public webhook URL configured in Mercado Pago' }),
    MP_WEBHOOK_SECRET: str({ default: isProd ? undefined : '', desc: 'Secret used to verify x-signature HMAC' }),
    WEBHOOK_PATH_SECRET: str({ default: '', desc: 'Optional path secret appended to /webhook/mercadopago and /webhook/pagbank' }),

    // PagBank (secrets required in production)
    PAGBANK_API_TOKEN: str({ default: isProd ? undefined : '', desc: 'PagBank authenticity token used for webhook verification' }),
    PAGBANK_BASE_URL:  url({ default: 'https://sandbox.api.pagseguro.com', desc: 'PagBank API base URL (use production URL in prod)' }),
    PAGBANK_ENABLED:   bool({ default: false, desc: 'Toggle to enable PagBank return routes' }),

    // Checkout UX
    PAYMENT_FAILURE_URL: url({ default: 'https://www.zodika.com.br/payment-fail' }),

    // Security toggles (must be off in production)
    ALLOW_UNSIGNED_WEBHOOKS: bool({ default: false, desc: 'Dev only: allow unsigned webhooks' }),

    // Rate-limiting tuning (optional, with safe defaults)
    WEBHOOK_RL_WINDOW_MS: num({ default: 5 * 60 * 1000 }),
    WEBHOOK_RL_MAX:       num({ default: 1000 }),
    FORM_RL_WINDOW_MS:    num({ default: 10 * 60 * 1000 }),
    FORM_RL_MAX:          num({ default: 60 }),

    // Networking/proxy
    TRUST_PROXY: str({ default: 'true', desc: 'Express trust proxy setting (true/false or hop count)' }),
  },
  {
    // Don’t print the whole environment if validation fails
    reporter: ({ errors }) => {
      if (Object.keys(errors).length > 0) {
        // Minimal, non-sensitive output
        const missing = Object.entries(errors)
          .filter(([, err]) => err && /required/i.test(String(err)))
          .map(([key]) => key);
        // eslint-disable-next-line no-console
        console.error('Invalid environment configuration.', missing.length ? `Missing: ${missing.join(', ')}` : '');
        // Exit with non-zero status
        process.exit(1);
      }
    },
  }
);

// Guardrails forbidding dangerous toggles in production
if (isProd && env.ALLOW_UNSIGNED_WEBHOOKS) {
  throw new Error('Security violation: ALLOW_UNSIGNED_WEBHOOKS must be false in production.');
}

module.exports = { env, isProd };
