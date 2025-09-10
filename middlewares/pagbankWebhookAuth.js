// middlewares/pagbankWebhookAuth.js
'use strict';

/**
 * PagBank Webhook Auth (soft)
 * ---------------------------
 * - Parse raw JSON into req.body (requires app-level express.raw()).
 * - Soft auth: NEVER block delivery; set verification flags and continue.
 * - Token check:   x-authenticity-token === PAGBANK_API_TOKEN
 * - HMAC check:    x-signature === base64(HMAC-SHA256(rawBody, PAGBANK_API_TOKEN))
 * - Best-effort duplicate flag via in-memory cache (x-request-id or signature).
 *
 * This middleware does NOT persist failures (router/service handle observability).
 */

const crypto = require('crypto');
const { env } = require('../config/env');

/* ----------------------------- In-memory dedupe ----------------------------- */

// key -> expireAt (epoch seconds)
const recentKeys = new Map();

function remember(key, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.max(5, Number(ttlSec) || 300); // default 5 minutes
  recentKeys.set(key, exp);
}

function isRecent(key) {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, exp] of recentKeys.entries()) if (exp <= now) recentKeys.delete(k);
  const exp = recentKeys.get(key);
  return typeof exp === 'number' && exp > now;
}

/* -------------------------------- Utilities -------------------------------- */

function safeParseJsonBuffer(buf) {
  try {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    return text ? JSON.parse(text) : {};
  } catch { return {}; }
}

function hmacB64(rawBody, secret) {
  return crypto.createHmac('sha256', String(secret || '')).update(rawBody || '').digest('base64');
}

function timingSafeEqualB64(a, b) {
  try {
    const A = Buffer.from(String(a) || '', 'base64');
    const B = Buffer.from(String(b) || '', 'base64');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch { return false; }
}

/* -------------------------------- Middleware -------------------------------- */

module.exports = async function pagbankWebhookAuth(req, _res, next) {
  // Ensure raw JSON is parsed downstream
  const raw = req.rawBody || req.body;
  const payload = safeParseJsonBuffer(raw);

  // Prepare flags container used by routers/services
  if (!req.webhookAuth) req.webhookAuth = {};
  const flags = {
    provider: 'pagbank',
    tokenOk: false,
    hmacOk: false,
    isDuplicate: false,
  };

  try {
    const tokenHeader = req.get('x-authenticity-token') || '';
    const signature   = req.get('x-signature') || '';
    const secret      = env.PAGBANK_API_TOKEN; // validated by env in production

    // Token equality check
    if (tokenHeader && secret && tokenHeader === secret) {
      flags.tokenOk = true;
    }

    // HMAC base64 check
    if (signature && secret && req.rawBody) {
      const expected = hmacB64(req.rawBody, secret);
      flags.hmacOk = timingSafeEqualB64(signature, expected);
    }

    // Duplicate flag (no blocking)
    const dedupKey =
      (req.get('x-request-id') && `xreq:${req.get('x-request-id')}`) ||
      (signature && `sig:${signature}`) ||
      null;

    if (dedupKey) {
      flags.isDuplicate = isRecent(dedupKey);
      remember(dedupKey, 300);
    }

    // Expose flags (no secrets/PII)
    req.pagbankSig = {
      tokenOk: flags.tokenOk,
      hmacOk: flags.hmacOk,
      isDuplicate: flags.isDuplicate,
    };
    req.webhookAuth = { ...req.webhookAuth, ...flags };

    req.body = payload;
    return next();
  } catch {
    // On any unexpected failure, keep soft behavior
    req.pagbankSig = { tokenOk: false, hmacOk: false, isDuplicate: false, reason: 'middleware_exception' };
    req.webhookAuth = { ...req.webhookAuth, provider: 'pagbank', tokenOk: false, hmacOk: false, isDuplicate: false, reason: 'middleware_exception' };
    req.body = payload;
    return next();
  }
};
