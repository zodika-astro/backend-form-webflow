// index.js
'use strict';

/**
 * App bootstrap
 * -------------
 * - Loads and validates environment variables (envalid)
 * - Initializes the PostgreSQL connection pool
 * - Instantiates Express and configures security, parsing, and rate limiting
 */
require('./config/env');
require('./db/db');

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Networking / Proxy trust
 * ------------------------
 * This app runs behind a reverse proxy (Railway/Render/Fly/Cloud Run, etc.).
 * NEVER use `true` (trust-all): it allows forging `X-Forwarded-For` and
 * breaks IP-based rate-limiting (express-rate-limit throws ERR_ERL_PERMISSIVE_TRUST_PROXY).
 *
 * Strategy:
 * - Control the trusted proxy hops via env var (TRUST_PROXY_HOPS).
 * - Production default: 1 hop (typical single load balancer).
 * - Local/dev default: 0 (disabled).
 *
 * Examples:
 *   TRUST_PROXY_HOPS=1        -> app.set('trust proxy', 1)
 *   TRUST_PROXY_HOPS=0/false  -> app.set('trust proxy', false)
 */
function resolveTrustProxySetting() {
  const raw = (process.env.TRUST_PROXY_HOPS || '').trim().toLowerCase();

  // Explicitly disabled
  if (raw === 'false' || raw === '0') return false;

  // Numeric hop count, if provided
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) return n;

  // Safe defaults
  const env = (process.env.NODE_ENV || 'development').toLowerCase();
  return env === 'production' ? 1 : false;
}

const TRUST_PROXY_SETTING = resolveTrustProxySetting();
app.set('trust proxy', TRUST_PROXY_SETTING);

/**
 * HTTP security headers
 * ---------------------
 * - Helmet applies a set of security-related headers.
 * - Also disable Express 'X-Powered-By' to avoid stack disclosure.
 * (CSP is not enabled here to avoid breaking frontend; add it later with
 *  proper domain/origin allowlists if needed.)
 */
app.use(helmet({
  // Avoid duplicate X-Download-Options configuration if another part
  // of the app already enables it via `xDownloadOptions` or `helmet.ieNoOpen()`.
  ieNoOpen: false,
}));
app.disable('x-powered-by');

/**
 * Correlation ID
 * --------------
 * Generates/propagates a per-request identifier to correlate logs end-to-end.
 */
const correlationId = require('./middlewares/correlationId');
app.use(correlationId);

/**
 * Infra middlewares
 * -----------------
 * - Global CORS (safe across routes; does not replace backend origin validation)
 * - Centralized error handler (registered last)
 */
const corsMiddleware = require('./middlewares/cors');
const errorHandlerMiddleware = require('./middlewares/errorHandler');

/**
 * Domain routers
 * --------------
 * - Birthchart (public form)
 * - PagBank / Mercado Pago (webhooks + return endpoints)
 */
const birthchartRouter = require('./modules/birthchart/router');
const pagbankWebhookRouter = require('./payments/pagBank/router.webhook');
const pagbankReturnRouter  = require('./payments/pagBank/router.return.js');
const mpWebhookRouter = require('./payments/mercadoPago/router.webhook');
const mpReturnRouter  = require('./payments/mercadoPago/router.return');

/**
 * Raw body for webhook signature validation
 * -----------------------------------------
 * Webhooks must validate provider signatures against the exact raw bytes.
 * Therefore:
 * 1) Register `express.raw()` parsers BEFORE any JSON parser;
 * 2) Keep body limits reasonable to avoid hashing large payloads.
 */
function rawBodySaver(req, res, buf) {
  if (buf && buf.length) req.rawBody = Buffer.from(buf);
}

// Raw parsers dedicated to webhook endpoints (MUST be before the global JSON parser)
app.use('/webhook/mercadopago', express.raw({ type: '*/*', limit: '1mb', verify: rawBodySaver }));
app.use('/webhook/pagbank',     express.raw({ type: '*/*', limit: '1mb', verify: rawBodySaver }));

/**
 * Rate limiting (express-rate-limit)
 * ----------------------------------
 * Rules:
 * - The limiter MUST mirror the Express proxy trust policy by passing
 *   `trustProxy: TRUST_PROXY_SETTING`. This avoids ERR_ERL_PERMISSIVE_TRUST_PROXY
 *   and prevents IP spoofing via X-Forwarded-For.
 * - Conservative defaults with env overrides.
 */
const toInt = (v, d) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};

const createRateLimiter = ({
  windowMs,
  limit,
  message,
  // Must mirror the app's trust proxy setting (boolean|number|function)
  trustProxy = TRUST_PROXY_SETTING,
}) =>
  rateLimit({
    windowMs,
    limit,
    message: { message },
    standardHeaders: 'draft-7', // emits modern RateLimit-* headers
    legacyHeaders: false,
    trustProxy,                 // CRITICAL: aligned with app 'trust proxy'
  });

// Webhook limiter (allow higher throughput but still bounded)
const webhookLimiter = createRateLimiter({
  windowMs: toInt(process.env.WEBHOOK_RL_WINDOW_MS, 5 * 60 * 1000), // 5 min
  limit: toInt(process.env.WEBHOOK_RL_MAX, 1000),
  message: 'Too many webhook requests, please retry later.',
});

// Public form limiter (stricter)
const formLimiter = createRateLimiter({
  windowMs: toInt(process.env.FORM_RL_WINDOW_MS, 10 * 60 * 1000), // 10 min
  limit: toInt(process.env.FORM_RL_MAX, 60),
  message: 'Too many requests, slow down.',
});

/**
 * Global CORS
 * -----------
 * Safe for all routes, including webhooks (PSPs do not use browsers).
 * Placed early so headers are present on early failures as well.
 */
app.use(corsMiddleware);

/**
 * JSON parser for non-webhook routes
 * ----------------------------------
 * We also keep a raw copy for non-webhook routes when useful.
 * Note: 'type' is a function to exclude webhook paths.
 */
app.use(
  express.json({
    type: (req) => !req.path.startsWith('/webhook/'),
    limit: '1mb',
    verify: (req, res, buf) => {
      if (!req.path.startsWith('/webhook/')) rawBodySaver(req, res, buf);
    },
  })
);

/**
 * Health and metrics
 * ------------------
 * - /health: liveness probe
 * - /metrics: application metrics
 * - /healthz: extended health checks
 */
app.get('/health', (req, res) => res.status(200).send('OK'));

const { metricsMiddleware, metricsRouter } = require('./middlewares/metrics');
app.use(metricsMiddleware);
app.use('/metrics', metricsRouter);

const healthzRouter = require('./observability/healthz');
app.use('/healthz', healthzRouter);

/**
 * Static assets
 * -------------
 * Proper cache control with ETag enabled.
 */
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '30d', etag: true }));

/**
 * Product module (public form)
 * ----------------------------
 * Applies a stricter rate limit to the form endpoints.
 */
app.use('/birthchart', formLimiter, birthchartRouter);

/**
 * Payments - PagBank
 * ------------------
 * - Limiter on the webhook prefix (before the router).
 * - Webhook router mounted at root ('/') since it defines full paths internally.
 * - Return router mounted under /pagBank when enabled via env.
 */
app.use('/webhook/pagbank', webhookLimiter);
app.use('/', pagbankWebhookRouter);

if (process.env.PAGBANK_ENABLED === 'true') {
  app.use('/pagBank', pagbankReturnRouter);
}

/**
 * Payments - Mercado Pago
 * -----------------------
 * - Limiter on the webhook prefix (before the router).
 * - Return routes under /mercadoPago.
 */
app.use('/webhook/mercadopago', webhookLimiter);
app.use('/mercadoPago', mpReturnRouter);
app.use('/', mpWebhookRouter);

/**
 * Centralized error handler
 * -------------------------
 * MUST be the last middleware.
 */
app.use(errorHandlerMiddleware);

module.exports = app;
