// payments/payPal/router.webhook.js
'use strict';

/**
 * PayPal Webhook Router
 * ---------------------
 * Production goals:
 *  - Enforce optional path secret before any processing.
 *  - Soft authentication: capture headers/flags, mas NÃO bloquear entrega.
 *  - Build a minimal, PII-free metadata envelope.
 *  - Sempre retornar 200 (service layer é idempotente).
 *
 * Requirements:
 *  - `req.rawBody` deve estar disponível (configurado no app-level com verify hook).
 *
 * Rotas:
 *  - POST /webhook/paypal
 *  - POST /webhook/paypal/:secret
 */

const express = require('express');
const router = express.Router();

const service = require('./service');
const { env } = require('../../config/env');

/* --------------------------------- Helpers ---------------------------------- */

/** Resolve a request correlation id and echo it back to clients/proxies. */
function getRequestId(req) {
  return (
    req.reqId ||
    req.requestId ||
    req.get('x-request-id') ||
    req.get('x-correlation-id')
  );
}

/** Build a safe header snapshot for auditing (no secret values). */
function buildSafeHeaders(req, authFlags) {
  const src = req.headers || {};
  const allow = new Set([
    'x-request-id',
    'x-correlation-id',
    'x-idempotency-key',
    'content-type',
    'user-agent',
  ]);

  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const key = String(k).toLowerCase();
    if (allow.has(key)) out[key] = v;
  }

  // Normalize correlation id presence
  const rid = getRequestId(req);
  if (rid) {
    out['x-request-id'] = String(rid);
    out['x-correlation-id'] = String(rid);
  }

  // Flags de presença de headers sensíveis (sem logar o valor)
  out['paypal-transmission-id-present'] = Boolean(
    req.get('paypal-transmission-id')
  );
  out['paypal-transmission-sig-present'] = Boolean(
    req.get('paypal-transmission-sig')
  );
  out['paypal-cert-url-present'] = Boolean(req.get('paypal-cert-url'));
  out['paypal-auth-algo-present'] = Boolean(req.get('paypal-auth-algo'));
  out['paypal-webhook-id-present'] = Boolean(req.get('paypal-webhook-id'));

  // Compact auth summary flags
  out['auth-summary'] = {
    pathSecretOk: Boolean(authFlags?.pathSecretOk),
    signatureOk: Boolean(authFlags?.signatureOk),
  };

  return out;
}

/**
 * Build soft-auth flags.
 *
 * Para PayPal, a verificação real de assinatura deve ser feita
 * via API `/v1/notifications/verify-webhook-signature` no service.
 * Aqui só marcamos a presença dos headers relevantes.
 */
function buildAuthFlags(req) {
  return {
    provider: 'paypal',
    pathSecretOk: !!(req.webhookAuth && req.webhookAuth.pathSecretOk),
    signatureOk: false, // será ajustado pelo service se/ver quando verificar de fato
    hasTransmissionSig: Boolean(req.get('paypal-transmission-sig')),
  };
}

/** Build the metadata object passed to the service layer (lean, PII-free). */
function buildMeta(req, body, authFlags) {
  return {
    headers: buildSafeHeaders(req, authFlags),
    query: req.query || {},
    topic: body?.event_type || undefined, // PayPal usa event_type
    auth: authFlags,
  };
}

/* ------------------------------ Path-secret guard ---------------------------- */
/**
 * Enforce WEBHOOK_PATH_SECRET (optional). Accepted sources (priority):
 *  - URL param : /webhook/paypal/:secret
 *  - Query     : ?s=... or ?secret=...
 *  - Header    : x-webhook-secret
 *
 * If configured and mismatched, respond 404 (hide route) with no-store caching.
 */
function pathSecretGuard(req, res, next) {
  const expected = String(env.WEBHOOK_PATH_SECRET || '').trim();
  if (!expected) return next(); // not configured

  const provided =
    (req.params && req.params.secret && String(req.params.secret).trim()) ||
    (req.query && String(req.query.s || req.query.secret || '').trim()) ||
    (req.get('x-webhook-secret') &&
      String(req.get('x-webhook-secret')).trim()) ||
    '';

  if (!req.webhookAuth) req.webhookAuth = {};

  if (provided && provided === expected) {
    req.webhookAuth.pathSecretOk = true;
    return next();
  }

  res.set('Cache-Control', 'no-store');
  return res.status(404).send('Not found');
}

/* ----------------------------------- Route ---------------------------------- */
/**
 * Order:
 *  1) pathSecretGuard → early reject se path secret não bater (quando configurado)
 *  2) soft auth       → marca flags; NUNCA bloqueia entrega
 *  3) handler         → encaminha pro service; SEMPRE 200
 */
router.post('/webhook/paypal/:secret?', pathSecretGuard, async (req, res, next) => {
  const rid = getRequestId(req);
  if (rid) res.set('X-Request-Id', String(rid));
  res.set('Cache-Control', 'no-store');

  try {
    const body = req.body || {};
    const authFlags = buildAuthFlags(req);
    const meta = buildMeta(req, body, authFlags);
    const ctx = { requestId: rid, log: req.log };

    const out = await service.processWebhook(body, meta, ctx);
    res.status(200).json(out || { ok: true });
  } catch (err) {
    // Nunca bloquear entrega do PayPal; ainda assim, jogar pro error pipeline.
    try {
      res.status(200).json({ ok: false });
    } catch (_) {}
    next(err);
  }
});

module.exports = router;
