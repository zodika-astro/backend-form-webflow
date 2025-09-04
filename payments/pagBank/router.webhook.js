'use strict';

/**
 * PagBank Webhook Router
 * ----------------------
 * Responsibilities:
 *   - Receive & authenticate webhooks (raw body configured at app level).
 *   - Soft-fail on signature/timestamp issues (never drop the request).
 *   - Pass normalized `meta` and a correlation `ctx` to the service layer.
 *   - Respond 200 to avoid unnecessary provider retries; processing is idempotent.
 */

const express = require('express');
const router = express.Router();

const service = require('./service');
const pagbankWebhookAuth = require('../../middlewares/pagbankWebhookAuth');

function correlationHeaders(req) {
  const rid = req.requestId || req.get('x-request-id') || req.get('x-correlation-id');
  return {
    'x-request-id': rid || undefined,
    'x-correlation-id': rid || undefined,
  };
}

router.post('/webhook/pagbank/:secret?', pagbankWebhookAuth, async (req, res, next) => {
  const rid = req.requestId || req.get('x-request-id');
  if (rid) res.set('X-Request-Id', String(rid));

  try {
    const body = req.body || {};
    const meta = {
      headers: correlationHeaders(req),
      query:   req.query || {},
      topic:   body?.type || req.query?.topic || undefined,
      action:  body?.action || undefined,
    };
    const ctx = { requestId: req.requestId, log: req.log };

    const out = await service.processWebhook(body, meta, ctx);
    res.status(200).json(out || { ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
