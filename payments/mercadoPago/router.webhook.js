'use strict';

/**
 * Mercado Pago Webhook Router
 * ---------------------------
 * Responsibilities:
 *   - Receive webhook posts (raw body is configured at app level).
 *   - Authenticate & soft-fail via middleware (never drop webhooks).
 *   - Forward a normalized `meta` + correlation context (`ctx`) to the service.
 *   - Always return 200 to prevent provider retries due to handler errors
 *     (the service implements idempotent persistence and we log failures).
 */

const express = require('express');
const router = express.Router();

const service = require('./service');
const mpWebhookAuth = require('../../middlewares/mpWebhookAuth');

// Build correlation headers for downstream calls/logs (no PII).
function correlationHeaders(req) {
  const rid = req.requestId || req.get('x-request-id') || req.get('x-correlation-id');
  return {
    'x-request-id': rid || undefined,
    'x-correlation-id': rid || undefined,
  };
}

router.post('/webhook/mercadopago/:secret?', mpWebhookAuth, async (req, res, next) => {
  // Attach the request id back to clients/proxies for observability.
  const rid = req.requestId || req.get('x-request-id');
  if (rid) res.set('X-Request-Id', String(rid));

  try {
    // `req.body` is parsed by the auth middleware from the raw buffer.
    const body = req.body || {};

    // Meta is kept lean (structured, no PII).
    const meta = {
      headers: correlationHeaders(req),
      query:   req.query || {},
      topic:   body?.type || req.query?.topic || undefined,
      action:  body?.action || undefined,
    };

    // Context for structured logging within the service.
    const ctx = { requestId: req.requestId, log: req.log };

    const out = await service.processWebhook(body, meta, ctx);

    // Webhooks should reply 200 even when we internally soft-fail;
    // the provider will handle at-least-once delivery and we are idempotent.
    res.status(200).json(out || { ok: true });
  } catch (err) {
    // We still use the centralized error handler for consistency.
    next(err);
  }
});

module.exports = router;
