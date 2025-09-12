// config/env.js
'use strict';

/**
 * Secure environment loading & validation
 * --------------------------------------
 * - Loads `.env` only in non-production to avoid shadowing platform-managed secrets.
 * - Validates variables with `envalid` (never logs secret values).
 * - Treats sensitive keys as required in production (no defaults); in dev, allows safe defaults.
 * - Adds knobs for future secret providers and rate-limit tuning.
 * - Replaces TRUST_PROXY with TRUST_PROXY_HOPS to safely control Express proxy hops.
 * - Migrates from classic reCAPTCHA to reCAPTCHA Enterprise (removes RECAPTCHA_SECRET).
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
    DATABASE_URL: url({ desc: 'Postgres connection string (postgres://...)' }),
    PUBLIC_BASE_URL: url({ desc: 'Public base URL of this backend (https://...)' }),

    // CORS / Referer policy
    ALLOWED_REFERERS: str({
      default: '',
      desc: 'Comma-separated allowed Referers (full URLs or prefixes). Empty = disabled.',
    }),
    ALLOWED_ORIGINS: str({
      default: '',
      desc: 'Comma-separated allowed Origins (scheme + host + optional port). Empty = disabled.',
    }),
    STRICT_ORIGIN_PATHS: str({
      default: '/birthchart',
      desc: 'Comma-separated path prefixes that require a valid Origin header.',
    }),

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
    MP_ACCESS_TOKEN: str({
      default: isProd ? undefined : '',
      desc: 'Mercado Pago Access Token (required in production)',
    }),
    MP_WEBHOOK_URL: url({
      default: isProd ? undefined : 'http://localhost:3000/webhook/mercadopago',
      desc: 'Public webhook URL configured in Mercado Pago (required in production)',
    }),
    MP_WEBHOOK_SECRET: str({
      default: isProd ? undefined : '',
      desc: 'Secret used to verify x-signature HMAC (required in production)',
    }),
    WEBHOOK_PATH_SECRET: str({
      default: '',
      desc: 'Optional path secret appended to /webhook/mercadopago and /webhook/pagbank',
    }),

    // PagBank (secrets required in production)
    PAGBANK_API_TOKEN: str({
      default: isProd ? undefined : '',
      desc: 'PagBank authenticity token used for webhook verification (required in production)',
    }),
    PAGBANK_BASE_URL: url({
      default: 'https://sandbox.api.pagseguro.com',
      desc: 'PagBank API base URL (use the production URL in prod)',
    }),
    PAGBANK_WEBHOOK_URL: url({
      default: isProd ? undefined : 'http://localhost:3000/webhook/pagbank',
      desc: 'Public webhook URL configured in PagBank (required in production)',
    }),

    // Checkout UX
    PAYMENT_PROVIDER: str({
      choices: ['MERCADO_PAGO', 'PAGBANK'],
      default: 'MERCADO_PAGO',
      desc: 'Primary payment provider (MERCADO_PAGO or PAGBANK).',
    }),
    PAYMENT_FAILURE_URL: url({
      default: 'https://www.zodika.com.br/payment-fail',
      desc: 'Fallback URL for payment failures',
    }),

    // Security toggles (must be off in production)
    ALLOW_UNSIGNED_WEBHOOKS: bool({
      default: false,
      desc: 'Dev only: allow unsigned webhooks (MUST be false in production)',
    }),

    // Rate-limiting tuning (optional, safe defaults)
    WEBHOOK_RL_WINDOW_MS: num({ default: 5 * 60 * 1000 }),
    WEBHOOK_RL_MAX: num({ default: 1000 }),
    FORM_RL_WINDOW_MS: num({ default: 10 * 60 * 1000 }),
    FORM_RL_MAX: num({ default: 60 }),

    // Networking / proxy trust (NEW: replaces TRUST_PROXY)
    TRUST_PROXY_HOPS: str({
      default: '',
      desc:
        'Number of reverse proxy hops to trust. ' +
        "Recommended: '1' in production (single LB). Use '0' or 'false' to disable in dev. " +
        'Do NOT use true/trust-all.',
    }),

  
  },
  {
    // Keep error output minimal and non-sensitive if validation fails
    reporter: ({ errors }) => {
      const keys = Object.keys(errors || {});
      if (keys.length > 0) {
        // eslint-disable-next-line no-console
        console.error('Invalid environment configuration. Missing/invalid:', keys.join(', '));
        process.exit(1);
      }
    },
  }
);

// Guardrails forbidding dangerous toggles in production.
if (isProd && env.ALLOW_UNSIGNED_WEBHOOKS) {
  throw new Error('Security violation: ALLOW_UNSIGNED_WEBHOOKS must be false in production.');
}


// Soft deprecation notice for old TRUST_PROXY var (if still present)
if (process.env.TRUST_PROXY && !process.env.TRUST_PROXY_HOPS) {
  // eslint-disable-next-line no-console
  console.warn(
    '[env] TRUST_PROXY is deprecated. Use TRUST_PROXY_HOPS (number of hops, e.g., 1). ' +
      "Example: TRUST_PROXY_HOPS=1 in production, TRUST_PROXY_HOPS=0 or 'false' in dev."
  );
}

module.exports = { env, isProd };
