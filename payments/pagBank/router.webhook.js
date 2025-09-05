// payments/pagBank/router.webhook.js
'use strict';

/**
 * PagBank Webhook Router
 * ----------------------
 * Responsibilities
 * - Receive & authenticate webhooks (raw body is configured at app level).
 * - Authenticate via middleware (path secret + signature/timestamp), but soft-fail (never drop delivery).
 * - Build a minimal, PII-free metadata envelope for the service.
 * - Always return 200 to avoid unnecessary provider retries (service is idempotent).
 */

const express = require('express');
const router = express.Router();

const service = require('./service');
const pagbankWebhookAuth = require('../../middlewares/pagbankWebhookAuth'); // verifies WEBHOOK_PATH_SECRET and signature (if configured)

/* --------------------------------- Helpers ---------------------------------- */

/** Resolve a single, stable correlation id and echo it back to the client/proxy. */
function getRequestId(req) {
  return req.requestId || req.get('x-request-id') || req.get('x-correlation-id');
}

/** Pick a safe subset of headers for audit/diagnostics (no PII). */
function buildSafeHeaders(req) {
  const src = req.headers || {};
  const allow = new Set([
    'x-request-id',
    'x-correlation-id',
    'x-idempotency-key',
    'x-signature',          // signature value is sanitized/redacted downstream
    'x-webhook-secret',
    'content-type',
    'user-agent',
  ]);

  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const key = String(k).toLowerCase();
    if (allow.has(key)) out[key] = v;
  }

  // Ensure correlation id is present/consistent.
  const rid = getRequestId(req);
  if (rid) {
    out['x-request-id'] = String(rid);
    out['x-correlation-id'] = String(rid);
  }
  return out;
}

/** Build the metadata object passed to the service layer (lean, no PII). */
function buildMeta(req, body) {
  return {
    headers: buildSafeHeaders(req),
    query: req.query || {},
    topic: body?.type || req.query?.topic || undefined,
    action: body?.action || undefined,
    // Auth results produced by pagbankWebhookAuth (e.g., signature/path-secret checks)
    auth: req.webhookAuth ? {
      ok: !!req.webhookAuth.ok,
      pathSecretOk: !!req.webhookAuth.pathSecretOk,
      signatureOk: !!req.webhookAuth.signatureOk,
      reason: req.webhookAuth.reason || undefined,
      provider: 'pagbank',
    } : undefined,
  };
}

/* ----------------------------------- Route ---------------------------------- */

/**
 * Route shape:
 *   POST /webhook/pagbank
 *   POST /webhook/pagbank/:secret
 *
 * pagbankWebhookAuth:
 *   - Validates path secret (param, query ?s=, or header x-webhook-secret) against WEBHOOK_PATH_SECRET
 *   - Validates signature when PAGBANK_API_TOKEN/secret is configured, using req.rawBody
 *   - Parses JSON body after verification and assigns to req.body
 *   - Populates req.webhookAuth = { ok, pathSecretOk, signatureOk, reason }
 */
router.post('/webhook/pagbank/:secret?', pagbankWebhookAuth, async (req, res, next) => {
  // Observability headers
  const rid = getRequestId(req);
  if (rid) res.set('X-Request-Id', String(rid));
  res.set('Cache-Control', 'no-store');

  try {
    // Body has been parsed by the auth middleware (from raw) after verification.
    const body = req.body || {};

    // Build lean meta (keeps only safe headers and auth flags)
    const meta = buildMeta(req, body);

    // Context for structured logging within the service
    const ctx = { requestId: rid, log: req.log };

    const out = await service.processWebhook(body, meta, ctx);

    // Always 200 to avoid provider retry storms (service/repo are idempotent).
    res.status(200).json(out || { ok: true });
  } catch (err) {
    // Keep central error handling; still emit 200 to the provider as a last resort.
    try {
      res.status(200).json({ ok: false });
    } catch (_) {
      // Best-effort fallback; intentionally swallow to avoid 5xx to the provider.
    }
    next(err);
  }
});

module.exports = router;
