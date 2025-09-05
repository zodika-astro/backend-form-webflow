// index.js
'use strict';

/**
 * App bootstrap
 * -------------
 * - Loads and validates environment variables (envalid)
 * - Initializes the PostgreSQL connection pool
 * - Instantiates Express and configures security, parsing, rate limiting, and routing
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
 * NEVER use `true` (trust-all). Control hops via TRUST_PROXY_HOPS.
 * Prod default: 1 hop (typical LB). Dev default: disabled.
 */
function resolveTrustProxySetting() {
  const raw = (process.env.TRUST_PROXY_HOPS || '').trim().toLowerCase();
  if (raw === 'false' || raw === '0') return false;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  const env = (process.env.NODE_ENV || 'production').toLowerCase();
  return env === 'production' ? 1 : false;
}
const TRUST_PROXY_SETTING = resolveTrustProxySetting();
app.set('trust proxy', TRUST_PROXY_SETTING);

/**
 * HTTP security headers (Helmet)
 * ------------------------------
 * - Minimal but strong CSP for API/redirect responses (safe for JSON).
 * - Disable X-Powered-By to avoid stack disclosure.
 * If you need to loosen CSP for HTML pages served here in the future, adjust directives.
 */
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "base-uri": ["'none'"],
        "frame-ancestors": ["'none'"],
        "form-action": ["'self'"],
        "connect-src": ["'self'"],
        // The lines below are conservative and safe for API/static assets.
        "img-src": ["'self'"],
        "style-src": ["'self'"],
        "script-src": ["'none'"],
        "frame-src": ["'none'"],
        "object-src": ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    xFrameOptions: true,
    xDnsPrefetchControl: true,
    xDownloadOptions: true,
    noSniff: true,
    ieNoOpen: true,
    hidePoweredBy: true,
  })
);
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
 * - Global CORS (safe across routes; does not replace backend origin verification)
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
 * 1) Register `express.raw()` parsers BEFORE any JSON/urlencoded parser;
 * 2) Keep body limits reasonable to avoid hashing large payloads.
 */
function rawBodySaver(req, res, buf) {
  if (buf && buf.length) req.rawBody = Buffer.from(buf);
}

// Raw parsers dedicated to webhook endpoints (MUST be before the global parsers)
app.use('/webhook/mercadopago', express.raw({ type: '*/*', limit: '1mb', verify: rawBodySaver }));
app.use('/webhook/pagbank',     express.raw({ type: '*/*', limit: '1mb', verify: rawBodySaver }));

/**
 * Rate limiting (express-rate-limit)
 * ----------------------------------
 * The limiter MUST mirror the Express proxy trust policy by passing `trustProxy`.
 */
const toInt = (v, d) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};
const createRateLimiter = ({
  windowMs,
  limit,
  message,
  trustProxy = TRUST_PROXY_SETTING,
}) =>
  rateLimit({
    windowMs,
    limit,
    message: { message },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    trustProxy,
  });

// Webhook limiter (allow higher throughput but bounded)
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
 * JSON / URL-encoded parsers for non-webhook routes
 * -------------------------------------------------
 * We also keep a raw copy for non-webhook routes when useful.
 */
const nonWebhookType = (req) => !req.path.startsWith('/webhook/');
app.use(
  express.json({
    type: nonWebhookType,
    limit: '1mb',
    verify: (req, res, buf) => {
      if (nonWebhookType(req)) rawBodySaver(req, res, buf);
    },
  })
);
app.use(
  express.urlencoded({
    type: nonWebhookType,
    extended: false,
    limit: '100kb',
    verify: (req, res, buf) => {
      if (nonWebhookType(req)) rawBodySaver(req, res, buf);
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
