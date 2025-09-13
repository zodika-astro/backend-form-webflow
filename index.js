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



/* -------------------------------- Proxy trust -------------------------------- */

function resolveTrustProxySetting() {
  const raw = (process.env.TRUST_PROXY_HOPS || '').trim().toLowerCase();
  if (raw === 'false' || raw === '0') return false;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  const env = (process.env.NODE_ENV || 'development').toLowerCase();
  return env === 'production' ? 1 : false;
}
const TRUST_PROXY_SETTING = resolveTrustProxySetting();
app.set('trust proxy', TRUST_PROXY_SETTING);

/* ----------------------------- Security headers ------------------------------ */

app.use(helmet({ ieNoOpen: false }));
app.disable('x-powered-by');

/* ------------------------------- Correlation ID ------------------------------ */

const correlationId = require('./middlewares/correlationId');
app.use(correlationId);


/* ---------------------------- Shared middlewares ----------------------------- */

const corsMiddleware = require('./middlewares/cors');
const errorHandlerMiddleware = require('./middlewares/errorHandler');

/* --------------------------------- Routers ----------------------------------- */

const birthchartRouter     = require('./modules/birthchart/router');
const pagbankWebhookRouter = require('./payments/pagBank/router.webhook');
const pagbankReturnRouter  = require('./payments/pagBank/router.return.js');
const mpWebhookRouter      = require('./payments/mercadoPago/router.webhook');
const mpReturnRouter       = require('./payments/mercadoPago/router.return');

/* ----------------------- Raw body for webhook signatures ---------------------- */
/**
 * Webhooks must validate signatures against the exact raw bytes.
 * 1) Register `express.raw()` BEFORE any JSON parser.
 * 2) Keep reasonable body limits.
 */
function rawBodySaver(req, res, buf) {
  if (buf && buf.length) req.rawBody = Buffer.from(buf);
}
app.use('/webhook/mercadopago', express.raw({ type: '*/*', limit: '1mb', verify: rawBodySaver }));
app.use('/webhook/pagbank',     express.raw({ type: '*/*', limit: '1mb', verify: rawBodySaver }));

/* -------------------------------- Rate limiting ------------------------------ */

const toInt = (v, d) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};

const createRateLimiter = ({ windowMs, limit, message, trustProxy = TRUST_PROXY_SETTING }) =>
  rateLimit({
    windowMs,
    limit,
    message: { message },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    trustProxy,
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

/* ---------------------------------- CORS ------------------------------------- */

app.use(corsMiddleware);

/* --------------------------- JSON (non-webhook) parser ----------------------- */

app.use(
  express.json({
    type: (req) => !req.path.startsWith('/webhook/'),
    limit: '1mb',
    verify: (req, res, buf) => {
      if (!req.path.startsWith('/webhook/')) rawBodySaver(req, res, buf);
    },
  })
);

/* ---------------------------- Health & metrics -------------------------------- */

app.get('/health', (req, res) => res.status(200).send('OK'));

const { metricsMiddleware, metricsRouter } = require('./middlewares/metrics');
app.use(metricsMiddleware);
app.use('/metrics', metricsRouter);

const healthzRouter = require('./observability/healthz');
app.use('/healthz', healthzRouter);

/* -------------------------------- Static files -------------------------------- */

app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '30d', etag: true }));

/* ------------------------------ Product modules ------------------------------ */

app.use('/birthchart', formLimiter, birthchartRouter);

/* ------------------------------- Payments: PB -------------------------------- */

app.use('/webhook/pagbank', webhookLimiter);
app.use('/', pagbankWebhookRouter);

/* ------------------------------ Payments: MP --------------------------------- */

app.use('/webhook/mercadopago', webhookLimiter);
app.use('/mercadoPago', mpReturnRouter);
app.use('/', mpWebhookRouter);

/* --------------------------- Central error handler --------------------------- */

app.use(errorHandlerMiddleware);

module.exports = app;
