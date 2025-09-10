'use strict';

/**
 * PagBank Webhook Router
 * ----------------------
 * Responsibilities
 * - Receive & authenticate webhooks (raw body is configured at app level).
 * - Enforce optional path secret (WEBHOOK_PATH_SECRET) before heavier work.
 * - Soft auth: verify headers/signature but NEVER block provider delivery.
 * - Build a minimal, PII-free metadata envelope for the service.
 * - Always return 200 to avoid unnecessary provider retries (service is idempotent).
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const service = require('./service');
// const pagbankWebhookAuth = require('../../middlewares/pagbankWebhookAuth'); // replaced by soft auth
const { env } = require('../../config/env');

/* --------------------------------- Helpers ---------------------------------- */

/** Resolve a single, stable correlation id and echo it back to the client/proxy. */
function getRequestId(req) {
  return req.reqId || req.requestId || req.get('x-request-id') || req.get('x-correlation-id');
}

/** Constant-time compare for base64 strings. */
function timingSafeEqualB64(a, b) {
  try {
    const A = Buffer.from(String(a) || '', 'base64');
    const B = Buffer.from(String(b) || '', 'base64');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

/** Compute base64(HMAC-SHA256(rawBody, secret)) */
function hmacB64(rawBody, secret) {
  return crypto.createHmac('sha256', String(secret || '')).update(rawBody || '').digest('base64');
}

/** Pick a safe subset of headers for audit/diagnostics (no secrets). */
function buildSafeHeaders(req, authFlags) {
  const src = req.headers || {};
  const allow = new Set([
    'x-request-id',
    'x-correlation-id',
    'x-idempotency-key',
    // sensitive ones are masked (we only keep presence via authFlags)
    'content-type',
    'user-agent',
  ]);

  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const key = String(k).toLowerCase();
    if (allow.has(key)) out[key] = v;
  }

  // Echo correlation id consistently
  const rid = getRequestId(req);
  if (rid) {
    out['x-request-id'] = String(rid);
    out['x-correlation-id'] = String(rid);
  }

  // Indicate presence of sensitive headers without exposing values
  out['x-authenticity-token-present'] = Boolean(req.get('x-authenticity-token'));
  out['x-signature-present'] = Boolean(req.get('x-signature'));
  out['auth-summary'] = {
    pathSecretOk: authFlags?.pathSecretOk || false,
    tokenOk: authFlags?.tokenOk || false,
    hmacOk: authFlags?.hmacOk || false,
  };

  return out;
}

/** Build auth flags (path-secret + soft verification). */
function buildAuthFlags(req) {
  const flags = {
    provider: 'pagbank',
    pathSecretOk: !!(req.webhookAuth && req.webhookAuth.pathSecretOk),
    tokenOk: false,
    hmacOk: false,
  };

  const tokenHeader = req.get('x-authenticity-token'); // expected to be the API token in many PagBank examples
  const signatureHeader = req.get('x-signature');      // expected base64(HMAC-SHA256(rawBody, token))

  // Soft token check (exact match)
  if (tokenHeader && env.PAGBANK_API_TOKEN && tokenHeader === env.PAGBANK_API_TOKEN) {
    flags.tokenOk = true;
  }

  // Soft HMAC check
  if (signatureHeader && env.PAGBANK_API_TOKEN && req.rawBody) {
    const expected = hmacB64(req.rawBody, env.PAGBANK_API_TOKEN);
    flags.hmacOk = timingSafeEqualB64(signatureHeader, expected);
  }

  return flags;
}

/** Build the metadata object passed to the service layer (lean, no PII). */
function buildMeta(req, body, authFlags) {
  return {
    headers: buildSafeHeaders(req, authFlags),
    query: req.query || {},
    topic: body?.type || req.query?.topic || undefined,
    action: body?.action || undefined,
    auth: authFlags,
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
 *   2) soft auth           → verifica token e HMAC mas NUNCA bloqueia entrega
 *   3) handler             → encaminha ao service; sempre retorna 200
 */
router.post('/webhook/pagbank/:secret?', pathSecretGuard, async (req, res, next) => {
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
    try { res.status(200).json({ ok: false }); } catch (_) {}
    next(err);
  }
});

module.exports = router;
