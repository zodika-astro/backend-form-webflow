// payments/mercadoPago/router.webhook.js
'use strict';

/**
 * Mercado Pago Webhook Router
 * ---------------------------
 * Responsibilities
 * - Receive webhook posts (raw body is configured at app level for /webhook/mercadopago).
 * - Enforce optional path secret (WEBHOOK_PATH_SECRET) before any heavy work.
 * - Authenticate via middleware (signature/time-skew), but never drop provider delivery
 *   due to internal errors — service layer is idempotent.
 * - Build a minimal, PII-free metadata envelope for the service.
 * - Always return 200 to avoid unnecessary provider retries.
 */

const express = require('express');
const router = express.Router();

const service = require('./service');
const mpWebhookAuth = require('../../middlewares/mpWebhookAuth'); // signature/anti-replay
const { env } = require('../../config/env'); // provides WEBHOOK_PATH_SECRET

// --------------------------------- Helpers ----------------------------------

/** Echo a single, stable correlation id back to clients/proxies. */
function getRequestId(req) {
  return req.reqId || req.requestId || req.get('x-request-id') || req.get('x-correlation-id');
}

/** Pick a safe subset of headers for audit/diagnostics (no PII). */
function buildSafeHeaders(req) {
  const src = req.headers || {};
  const allow = new Set([
    'x-request-id',
    'x-correlation-id',
    'x-idempotency-key',
    'x-signature',          // value is sanitized/redacted downstream
    'content-type',
    'user-agent',
  ]);

  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const key = String(k).toLowerCase();
    if (allow.has(key)) out[key] = v;
  }

  // Ensure correlation id is present/consistent
  const rid = getRequestId(req);
  if (rid) {
    out['x-request-id'] = String(rid);
    out['x-correlation-id'] = String(rid);
  }
  return out;
}

/** Merge auth flags from path-secret guard (this router) and mpWebhookAuth (req.mpSig). */
function buildAuthFlags(req) {
  const base = req.webhookAuth || {};
  const sig = req.mpSig || null;

  // Interpret mpWebhookAuth outcome:
  // - Valid / stale: no `verify` field, carries ids; treat as signatureOk=true (stale flagged).
  // - Soft-fail: has `verify: 'soft-fail'`.
  const signatureOk = !!(sig && !sig.verify && (sig.id || sig.ts || sig.v1));
  const signatureStale = !!(sig && sig.stale);

  return {
    provider: 'mercadopago',
    pathSecretOk: !!base.pathSecretOk,
    signatureOk,
    signatureStale,
    reason: base.reason || (sig && sig.verify ? sig.verify : undefined),
  };
}

/** Build the metadata object passed to the service layer (kept lean, no PII). */
function buildMeta(req, body) {
  return {
    headers: buildSafeHeaders(req),
    query: req.query || {},
    topic: body?.type || req.query?.topic || undefined,
    action: body?.action || undefined,
    auth: buildAuthFlags(req),
  };
}

// ------------------------------ Path-secret guard ----------------------------

/**
 * Guard that enforces an optional path secret before signature verification.
 * Sources (in order of precedence):
 *   - URL param : /webhook/mercadopago/:secret
 *   - Query     : ?s=... or ?secret=...
 *   - Header    : x-webhook-secret
 *
 * Behavior:
 *   - If WEBHOOK_PATH_SECRET is unset/empty -> pass-through (no enforcement).
 *   - If set and mismatch -> respond 404 (conceal route) + no-store.
 *   - If set and matches -> mark `req.webhookAuth.pathSecretOk = true` and continue.
 */
function pathSecretGuard(req, res, next) {
  const expected = String(env.WEBHOOK_PATH_SECRET || '').trim();
  if (!expected) return next(); // not configured -> no-op

  const provided =
    (req.params && req.params.secret && String(req.params.secret).trim()) ||
    (req.query && (String(req.query.s || req.query.secret || '').trim())) ||
    (req.get('x-webhook-secret') && String(req.get('x-webhook-secret')).trim()) ||
    '';

  if (!req.webhookAuth) req.webhookAuth = {};

  if (provided && provided === expected) {
    req.webhookAuth.pathSecretOk = true;
    return next();
  }

  // Conceal the route and avoid cache
  res.set('Cache-Control', 'no-store');
  return res.status(404).send('Not found');
}

// ----------------------------------- Route ----------------------------------

/**
 * Route shape:
 *   POST /webhook/mercadopago
 *   POST /webhook/mercadopago/:secret
 *
 * Order matters:
 *   1) pathSecretGuard   → cheap rejection if secret mismatch (when configured)
 *   2) mpWebhookAuth     → signature + anti-replay (uses req.rawBody)
 *   3) handler           → forwards to service (always returns 200)
 */
router.post('/webhook/mercadopago/:secret?',
  pathSecretGuard,
  mpWebhookAuth,
  async (req, res, next) => {
    // Observability headers
    const rid = getRequestId(req);
    if (rid) res.set('X-Request-Id', String(rid));
    res.set('Cache-Control', 'no-store');

    try {
      // Body is parsed by mpWebhookAuth from the raw buffer
      const body = req.body || {};
      const meta = buildMeta(req, body);
      const ctx = { requestId: rid, log: req.log };

      const out = await service.processWebhook(body, meta, ctx);
      // Always 200 (service/repo layers are idempotent)
      res.status(200).json(out || { ok: true });
    } catch (err) {
      // Still respond 200 to avoid provider retry storms; delegate logging upstream
      try { res.status(200).json({ ok: false }); } catch (_) {}
      next(err);
    }
  }
);

module.exports = router;
