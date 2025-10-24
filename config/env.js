// config/env.js
'use strict';

/**
 * Secure environment loading & validation
 * --------------------------------------
 * - Loads `.env` only in non-production to avoid shadowing platform-managed secrets.
 * - Validates variables with `envalid` (never logs secret values).
 * - Treats sensitive keys as required in production (no defaults).
 * - Adds knobs for secret providers and rate-limit tuning.
 */

const isProd = process.env.NODE_ENV === 'production';

// Load dotenv only for local/dev workflows.
if (!isProd) {
  // eslint-disable-next-line global-require
  require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
}

const { cleanEnv, url, str, num, bool } = require('envalid');

const env = cleanEnv(
  process.env,
  {
    /* ----------------------------- Runtime mode ----------------------------- */
    NODE_ENV: str({
      choices: ['development', 'test', 'production'],
      default: 'development',
      desc: 'Runtime environment',
    }),

    /* --------------------------------- Core -------------------------------- */
    DATABASE_URL: url({ desc: 'Postgres connection string (postgres://...)' }),
    PUBLIC_BASE_URL: url({ desc: 'Public base URL of this backend (https://...)' }),

    /* ----------------------------- CORS / Referer --------------------------- */
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

    /* -------------------------- Secret provider knobs ---------------------- */
    SECRET_PROVIDER: str({
      default: 'env',
      desc: 'Secret backend: env | gcp | aws | vault | doppler (reserved for future use)',
    }),
    SECRET_CACHE_TTL_MS: num({
      default: 5 * 60 * 1000,
      desc: 'In-memory secret cache TTL (ms), for external secret managers',
    }),

    /* -------------------------------- Google ------------------------------- */
    GOOGLE_MAPS_API_KEY: str({
      default: isProd ? undefined : '',
      desc: 'Google Maps API key (required in production)',
    }),

    /* ---------------------------- Mercado Pago ----------------------------- */
    MP_ACCESS_TOKEN: str({
      default: isProd ? undefined : '',
      desc: 'Mercado Pago Access Token (required in production)',
    }),
    MP_WEBHOOK_URL: url({
      default: isProd ? undefined : 'https://example.invalid/webhook/mercadopago',
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

    /* -------------------------------- PagBank ------------------------------ */
    PAGBANK_API_TOKEN: str({
      default: isProd ? undefined : '',
      desc: 'PagBank authenticity token used for webhook verification (required in production)',
    }),
    PAGBANK_BASE_URL: url({
      default: 'https://sandbox.api.pagseguro.com',
      desc: 'PagBank API base URL (use the production URL in prod)',
    }),
    PAGBANK_WEBHOOK_URL: url({
      default: isProd ? undefined : 'https://example.invalid/webhook/pagbank',
      desc: 'Public webhook URL configured in PagBank (required in production)',
    }),

    /* --------------------------- Checkout strategy ------------------------- */
    PAYMENT_PROVIDER: str({
      choices: ['MERCADO_PAGO', 'PAGBANK'],
      default: 'MERCADO_PAGO',
      desc: 'Primary payment provider (MERCADO_PAGO or PAGBANK).',
    }),
    PAYMENT_FAILURE_URL: url({
      default: 'https://www.zodika.com.br/payment-fail',
      desc: 'Fallback URL for payment failures',
    }),

    /* ----------------------------- Product hooks --------------------------- */
    EPHEMERIS_API_URL: url({
      default: 'https://ephemeris-api-production.up.railway.app/api/v1/ephemeris',
      desc: 'Ephemeris API endpoint',
    }),
    EPHEMERIS_API_KEY: str({
      default: isProd ? undefined : '',
      desc: 'Ephemeris API key (X-API-KEY header). Required in production.',
    }),
    EPHEMERIS_BASIC_USER: str({
      default: '',
      desc: 'Optional Basic Auth username for Ephemeris (if required).',
    }),
    EPHEMERIS_BASIC_PASS: str({
      default: '',
      desc: 'Optional Basic Auth password for Ephemeris (if required).',
    }),

    WEBHOOK_URL_PAID: url({
      default: isProd ? undefined : '',
      desc: 'n8n webhook URL for PAID flow (required when PAID flow enabled)',
    }),
    WEBHOOK_URL_REJECTED: url({
      default: isProd ? undefined : '',
      desc: 'n8n webhook URL for REJECTED flow (immediate).',
    }),
    WEBHOOK_URL_PENDING_10M: url({
      default: isProd ? undefined : '',
      desc: 'n8n webhook URL for PENDING after 10 minutes.',
    }),
    WEBHOOK_URL_PENDING_24H: url({
      default: isProd ? undefined : '',
      desc: 'n8n webhook URL for PENDING after 24 hours.',
    }),


    /* ----------------------------- Timezone sources ------------------------ */
    GEONAMES_USERNAME: str({
      default: isProd ? undefined : '',
      desc: 'GeoNames username for timezoneJSON (required in production for historical TZ).',
    }),

    /* --------------------------- Security toggles -------------------------- */
    ALLOW_UNSIGNED_WEBHOOKS: bool({
      default: false,
      desc: 'Dev only: allow unsigned webhooks (MUST be false in production)',
    }),

    /* ------------------------- Rate-limiting tuning ------------------------ */
    WEBHOOK_RL_WINDOW_MS: num({ default: 5 * 60 * 1000 }),
    WEBHOOK_RL_MAX: num({ default: 1000 }),
    FORM_RL_WINDOW_MS: num({ default: 10 * 60 * 1000 }),
    FORM_RL_MAX: num({ default: 60 }),

    /* ------------------------------ HTTP Client ---------------------------- */
    HTTP_ALLOWED_HOSTS: str({
      default:
        [
          'api.mercadopago.com',
          'api.pagbank.com.br',
          'sandbox.api.pagseguro.com',
          'ephemeris-api-production.up.railway.app',
          'hook.us1.make.com',
          'hook.eu1.make.com',
        ].join(','),
      desc:
        'Comma-separated allowlist of HTTPS hosts the httpClient can call. ' +
        'Extend when adding new providers.',
    }),
    HTTP_DEFAULT_TIMEOUT_MS: num({ default: 10_000 }),
    HTTP_DEFAULT_RETRIES: num({ default: 0 }),

    TZ_PROVIDER_TIMEOUT_MS: num({ default: 6000 }),
    TZ_CACHE_TTL_MS: num({ default: 12 * 60 * 60 * 1000 }),
    TZ_CACHE_MAX_ENTRIES: num({ default: 500 }),

    EPHEMERIS_HTTP_TIMEOUT_MS: num({ default: 12_000 }),
    MAKE_HTTP_TIMEOUT_MS: num({ default: 10_000 }),

    /* ---------------------- Networking / proxy trust ----------------------- */
    TRUST_PROXY_HOPS: str({
      default: '',
      desc:
        'Number of reverse proxy hops to trust. ' +
        "Recommended: '1' in production (single LB). Use '0' or 'false' in dev.",
    }),
  },
  {
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

// Guardrails
if (isProd && env.ALLOW_UNSIGNED_WEBHOOKS) {
  throw new Error('Security violation: ALLOW_UNSIGNED_WEBHOOKS must be false in production.');
}

// Soft deprecation notice for old TRUST_PROXY var (if still present)
if (process.env.TRUST_PROXY && !process.env.TRUST_PROXY_HOPS) {
  // eslint-disable-next-line no-console
  console.warn(
    '[env] TRUST_PROXY is deprecated. Use TRUST_PROXY_HOPS (number of hops, e.g., 1).'
  );
}

module.exports = { env, isProd };
