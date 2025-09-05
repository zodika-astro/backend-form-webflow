// payments/pagBank/router.webhook.js
'use strict';

/**
 * PagBank Webhook Router
 * ----------------------
 * Responsibilities
 * - Receive & authenticate webhooks (raw body is configured at app level).
 * - Enforce optional path secret (WEBHOOK_PATH_SECRET) before heavier work.
 * - Authenticate via middleware (signature/timestamp), but never drop provider delivery.
 * - Build a minimal, PII-free metadata envelope for the service.
 * - Always return 200 to avoid unnecessary provider retries (service is idempotent).
 */

const express = require('express');
const router = express.Router();

const service = require('./service');
const pagbankWebhookAuth = require('../../middlewares/pagbankWebhookAuth');
const { env } = require('../../config/env');

/* --------------------------------- Helpers ---------------------------------- */

/** Resolve a single, stable correlation id and echo it back to the client/proxy. */
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
    'x-authenticity-token', // PagBank signature header (valor é sanitizado em camadas de repositório)
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

/** Build auth flags (combina path-secret guard e resultado do middleware). */
function buildAuthFlags(req) {
  // O middleware pagbankWebhookAuth define x-zodika-verified = 'true' em caso de assinatura válida.
  const signatureOk = String(req.get('x-zodika-verified') || '').toLowerCase() === 'true';
  const sigMeta = req.pagbankSig || null;

  return {
    provider: 'pagbank',
    pathSecretOk: !!(req.webhookAuth && req.webhookAuth.pathSecretOk),
    signatureOk,
    // Sinaliza possível replay detectado pelo middleware (cache in-memory)
    isDuplicate: !!(sigMeta && sigMeta.isDuplicate),
    reason: (req.webhookAuth && req.webhookAuth.reason) || undefined,
  };
}

/** Build the metadata object passed to the service layer (lean, no PII). */
function buildMeta(req, body) {
  return {
    headers: buildSafeHeaders(req),
    query: req.query || {},
    topic: body?.type || req.query?.topic || undefined,
    action: body?.action || undefined,
    auth: buildAuthFlags(req),
  };
}

/* ------------------------------ Path-secret guard ---------------------------- */

/**
 * Guard que aplica WEBHOOK_PATH_SECRET antes da verificação de assinatura.
 * Fontes aceitas (ordem de prioridade):
 *   - URL param : /webhook/pagbank/:secret
 *   - Query     : ?s=... ou ?secret=...
 *   - Header    : x-webhook-secret
 *
 * Comportamento:
 *   - Se WEBHOOK_PATH_SECRET não estiver configurada → pass-through (sem checagem).
 *   - Se configurada e o valor não bater → 404 (oculta rota) + no-store.
 *   - Se bater → marca `req.webhookAuth.pathSecretOk = true` e segue.
 */
function pathSecretGuard(req, res, next) {
  const expected = String(env.WEBHOOK_PATH_SECRET || '').trim();
  if (!expected) return next(); // não configurado → sem verificação

  const provided =
    (req.params && req.params.secret && String(req.params.secret).trim()) ||
    (req.query && String(req.query.s || req.query.secret || '').trim()) ||
    (req.get('x-webhook-secret') && String(req.get('x-webhook-secret')).trim()) ||
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
 * Route shape:
 *   POST /webhook/pagbank
 *   POST /webhook/pagbank/:secret
 *
 * Ordem:
 *   1) pathSecretGuard     → rejeita cedo se secreto de caminho não bater (quando configurado)
 *   2) pagbankWebhookAuth  → verifica assinatura e anti-replay (usa req.rawBody)
 *   3) handler             → encaminha ao service; sempre retorna 200
 */
router.post('/webhook/pagbank/:secret?',
  pathSecretGuard,
  pagbankWebhookAuth,
  async (req, res, next) => {
    const rid = getRequestId(req);
    if (rid) res.set('X-Request-Id', String(rid));
    res.set('Cache-Control', 'no-store');

    try {
      const body = req.body || {};
      const meta = buildMeta(req, body);
      const ctx = { requestId: rid, log: req.log };

      const out = await service.processWebhook(body, meta, ctx);
      // Sempre 200 (camadas de service/repo são idempotentes)
      res.status(200).json(out || { ok: true });
    } catch (err) {
      try { res.status(200).json({ ok: false }); } catch (_) {}
      next(err);
    }
  }
);

module.exports = router;
