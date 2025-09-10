'use strict';

/**
 * PagBank Webhook Router
 * ----------------------
 * Goals (production-grade):
 *  - Enforce optional path secret before any processing.
 *  - Soft authentication: verify headers/signature but NEVER block delivery.
 *  - Build a minimal metadata envelope (no secrets/PII).
 *  - Always return 200 to avoid unnecessary provider retries (service is idempotent).
 *
 * Requirements:
 *  - `req.rawBody` must be available (set in app-level body-parser verify hook).
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const service = require('./service');
const { env } = require('../../config/env');

/* --------------------------------- Helpers ---------------------------------- */

/** Resolve a request correlation id and echo back to the client/proxy. */
function getRequestId(req) {
  return req.reqId || req.requestId || req.get('x-request-id') || req.get('x-correlation-id');
}

/** Constant-time compare for base64 signatures. */
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

/** Compute base64(HMAC-SHA256(rawBody, secret)). */
function hmacB64(rawBody, secret) {
  return crypto.createHmac('sha256', String(secret || '')).update(rawBody || '').digest('base64');
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

  // Indicate presence of sensitive headers without leaking values
  out['x-authenticity-token-present'] = Boolean(req.get('x-authenticity-token'));
  out['x-signature-present'] = Boolean(req.get('x-signature'));

  // Compact auth summary flags
  out['auth-summary'] = {
    pathSecretOk: Boolean(authFlags?.pathSecretOk),
    tokenOk: Boolean(authFlags?.tokenOk),
    hmacOk: Boolean(authFlags?.hmacOk),
  };

  return out;
}

/** Build soft-auth flags (token match + HMAC match). Never throws. */
function buildAuthFlags(req) {
  const flags = {
    provider: 'pagbank',
    pathSecretOk: !!(req.webhookAuth && req.webhookAuth.pathSecretOk),
    tokenOk: false,
    hmacOk: false,
  };

  const tokenHeader = req.get('x-authenticity-token'); // Often the API token itself (per PagBank docs/examples)
  const signatureHeader = req.get('x-signature');      // base64(HMAC-SHA256(rawBody, token))
  const secret = env.PAGBANK_API_TOKEN;

  if (tokenHeader && secret && tokenHeader === secret) {
    flags.tokenOk = true;
  }

  if (signatureHeader && secret && req.rawBody) {
    const expected = hmacB64(req.rawBody, secret);
    flags.hmacOk = timingSafeEqualB64(signatureHeader, expected);
  }

  return flags;
}

/** Build the metadata object passed to the service layer (lean, PII-free). */
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
 * Enforce WEBHOOK_PATH_SECRET (optional). Accepted sources (priority):
 *  - URL param : /webhook/pagbank/:secret
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
 * Routes:
 *  - POST /webhook/pagbank
 *  - POST /webhook/pagbank/:secret
 *
 * Order:
 *  1) pathSecretGuard → early reject if path secret mismatches (when configured)
 *  2) soft auth       → set verification flags; never block delivery
 *  3) handler         → forward to service; ALWAYS 200
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
    // Never block provider delivery; still surface to error pipeline for observability.
    try { res.status(200).json({ ok: false }); } catch (_) {}
    next(err);
  }
});

module.exports = router;
