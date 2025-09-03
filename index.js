'use strict';

require('./config/env'); // validates ENV with envalid (loads .env, etc.)
require('./db/db');      // initializes PG pool

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Networking / proxy settings
 * --------------------------
 * Railway/Render/Fly/Cloud Run place a reverse proxy in front of your app.
 * DO NOT use `true` (trust-all). That allows spoofing X-Forwarded-For and breaks
 * IP-based rate limiting (express-rate-limit will throw ERR_ERL_PERMISSIVE_TRUST_PROXY).
 *
 * Strategy:
 * - Use an env var to define how many proxy hops to trust.
 * - Default to 1 hop in production (typical single LB/proxy).
 * - Allow disabling in local dev by setting to 0/false.
 *
 * Examples:
 *   TRUST_PROXY_HOPS=1        -> app.set('trust proxy', 1)
 *   TRUST_PROXY_HOPS=0/false  -> app.set('trust proxy', false)
 */
function resolveTrustProxySetting() {
  const raw = (process.env.TRUST_PROXY_HOPS || '').trim().toLowerCase();

  // Explicit off
  if (raw === 'false' || raw === '0') return false;

  // Numeric hops if provided
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) return n;

  // Sensible default: in production trust 1 hop; in dev trust none.
  if ((process.env.NODE_ENV || 'production') === 'production') return 1;
  return false;
}

const TRUST_PROXY_SETTING = resolveTrustProxySetting();
app.set('trust proxy', TRUST_PROXY_SETTING);

// Middlewares
const corsMiddleware = require('./middlewares/cors');
const errorHandlerMiddleware = require('./middlewares/errorHandler');

// Routers
const birthchartRouter = require('./modules/birthchart/router');
const pagbankWebhookRouter = require('./payments/pagBank/router.webhook');
const pagbankReturnRouter  = require('./payments/pagBank/router.return.js');
const mpWebhookRouter = require('./payments/mercadoPago/router.webhook');
const mpReturnRouter  = require('./payments/mercadoPago/router.return');

/**
 * Raw body strategy for webhook signature validation
 * --------------------------------------------------
 * (unchanged)
 */
function rawBodySaver(req, res, buf) {
  if (buf && buf.length) {
    req.rawBody = Buffer.from(buf);
  }
}

// 1) Raw body *only* for webhook endpoints — must be registered BEFORE any JSON parser
app.use('/webhook/mercadopago', express.raw({ type: '*/*', limit: '1mb', verify: rawBodySaver }));
app.use('/webhook/pagbank',     express.raw({ type: '*/*', limit: '1mb', verify: rawBodySaver }));

/**
 * HTTP hardening — Helmet
 * -----------------------
 */
app.use(helmet());

/**
 * Rate limiting policies (express-rate-limit)
 * -------------------------------------------
 * IMPORTANT: The limiter must use the same trust policy as Express.
 * Passing the exact value avoids ERR_ERL_* validation errors and prevents IP spoofing.
 */
const toInt = (v, d) => {
  const n = parseInt(String(v || ''), 10);
  return Number.isFinite(n) ? n : d;
};

const createRateLimiter = ({
  windowMs,
  limit,
  message,
  // Mirror Express trust proxy configuration here (boolean|number|function)
  trustProxy = TRUST_PROXY_SETTING,
}) => rateLimit({
  windowMs,
  limit,
  message: { message },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  trustProxy, // ← critical: aligns with app 'trust proxy'
});

const webhookLimiter = createRateLimiter({
  windowMs: toInt(process.env.WEBHOOK_RL_WINDOW_MS, 5 * 60 * 1000),
  limit: toInt(process.env.WEBHOOK_RL_MAX, 1000),
  message: 'Too many webhook requests, please retry later.',
});

const formLimiter = createRateLimiter({
  windowMs: toInt(process.env.FORM_RL_WINDOW_MS, 10 * 60 * 1000),
  limit: toInt(process.env.FORM_RL_MAX, 60),
  message: 'Too many requests, slow down.',
});

// 2) Global CORS (safe to run for all routes, including webhooks)
app.use(corsMiddleware);

// 3) JSON parser for non-webhook endpoints, while still keeping a copy of the raw payload
app.use(express.json({
  type: (req) => !req.path.startsWith('/webhook/'),
  limit: '1mb',
  verify: (req, res, buf) => {
    if (!req.path.startsWith('/webhook/')) {
      rawBodySaver(req, res, buf);
    }
  },
}));

// Health check (skip limiters)
app.get('/health', (req, res) => res.status(200).send('OK'));

// metrics
const { metricsMiddleware, metricsRouter } = require('./middlewares/metrics');
app.use(metricsMiddleware);
app.use('/metrics', metricsRouter);

// healthcheck
const healthzRouter = require('./observability/healthz');
app.use('/healthz', healthzRouter);


// Public assets
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '30d', etag: true }));

// Product modules (apply stricter limiter to public form endpoints)
app.use('/birthchart', formLimiter, birthchartRouter);

/**
 * Payments modules (PagBank)
 * --------------------------
 */
app.use('/webhook/pagbank', webhookLimiter);
app.use('/', pagbankWebhookRouter);

if (process.env.PAGBANK_ENABLED === 'true') {
  app.use('/pagBank', pagbankReturnRouter);
}

/**
 * Payments modules (Mercado Pago)
 * -------------------------------
 */
app.use('/webhook/mercadopago', webhookLimiter);
app.use('/mercadoPago', mpReturnRouter);
app.use('/', mpWebhookRouter);

// Centralized error handler (keep last)
app.use(errorHandlerMiddleware);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
