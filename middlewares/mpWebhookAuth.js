// middlewares/mpWebhookAuth.js
'use strict';

/**
 * Mercado Pago Webhook Auth (soft)
 * --------------------------------
 * - Parse raw JSON into req.body.
 * - Soft path-secret guard (never blocks; router already enforces hard 404).
 * - Signature check:
 *     manifest = "id:{data.id};request-id:{x-request-id};ts:{ts};"
 *     v1 = HMAC_SHA256(MP_WEBHOOK_SECRET, manifest) -> hex
 * - Timestamp tolerance (default 15m) and duplicate flag via in-memory cache.
 * - Never blocks delivery; sets flags and continues.
 */

const crypto = require('crypto');
const db = require('../db/db');
const { get: getSecret } = require('../config/secretProvider');
const { env } = require('../config/env');

const DEFAULT_TOLERANCE_MS = Number.isFinite(Number(process.env.WEBHOOK_TS_TOLERANCE_MS))
  ? Number(process.env.WEBHOOK_TS_TOLERANCE_MS)
  : 15 * 60 * 1000;

/* ------------------------- In-memory best-effort ------------------------- */

const recentRequestIds = new Map(); // x-request-id -> expireAt (epoch seconds)
function gcRecent(nowSec) { for (const [k, exp] of recentRequestIds.entries()) if (exp <= nowSec) recentRequestIds.delete(k); }
function rememberRequestId(id, baseTsSec) {
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = Math.floor(DEFAULT_TOLERANCE_MS / 1000);
  recentRequestIds.set(id, Math.max(baseTsSec || nowSec, nowSec) + ttlSec);
}

const recentLogKeys = new Map(); // small dedupe for failure logs
function shouldLogOnce(key) {
  const now = Math.floor(Date.now() / 1000);
  const exp = recentLogKeys.get(key);
  if (!exp || exp <= now) {
    recentLogKeys.set(key, now + Math.floor(DEFAULT_TOLERANCE_MS / 1000));
    for (const [k, e] of recentLogKeys.entries()) if (e <= now) recentLogKeys.delete(k);
    return true;
  }
  return false;
}

/* ------------------------------- Utilities ------------------------------- */

function safeParseJsonBuffer(buf) {
  try {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    return text ? JSON.parse(text) : {};
  } catch { return {}; }
}

function normalizeTsToMs(tsRaw) {
  const n = Number(tsRaw);
  if (!Number.isFinite(n)) return NaN;
  if (n >= 1e13) return Math.floor(n);        // ms
  if (n >= 1e9)  return Math.floor(n * 1000); // sec
  if (n > 0)     return Math.floor(n * 1000); // small positives -> sec
  return NaN;
}

function parseSignatureHeader(h) {
  if (!h || typeof h !== 'string') return null;
  const parts = h.split(/[;,]\s*/g).map(s => s.trim()).filter(Boolean);
  const out = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  if (!out.ts || !out.v1) return null;
  return { ts: out.ts, v1: out.v1 };
}

function extractEventId(b) {
  if (b?.data?.id != null) return String(b.data.id);
  if (b?.id != null) return String(b.id);
  if (typeof b?.resource === 'string') {
    const m = b.resource.match(/\/(\d+)(?:\?.*)?$/);
    if (m) return m[1];
    if (/^\d+$/.test(b.resource)) return b.resource;
  }
  return null;
}

function buildManifest({ id, requestId, ts }) {
  return `id:${id};request-id:${requestId};ts:${ts};`;
}

function hmacSha256(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

async function resolveMpSecret() {
  const fromProvider = await getSecret('MP_WEBHOOK_SECRET').catch(() => null);
  return fromProvider || env.MP_WEBHOOK_SECRET || process.env.MP_WEBHOOK_SECRET || null;
}

function checkPathSecret(req) {
  const configured = env.WEBHOOK_PATH_SECRET || process.env.WEBHOOK_PATH_SECRET || null;
  if (!configured) return { ok: true };
  const supplied =
    (req.params && req.params.secret) ||
    req.query?.s ||
    req.get('x-webhook-secret') ||
    '';
  return { ok: String(supplied) === String(configured), reason: supplied ? 'mismatch' : 'missing' };
}

async function logFailure(reason, req, parsedBody) {
  try {
    await db.query(
      `INSERT INTO mp_webhook_failures (reason, headers, raw_body)
       VALUES ($1,$2,$3)`,
      [reason, { redacted: true }, { redacted: true }]
    );
  } catch { /* swallow */ }
}

/* -------------------------------- Middleware -------------------------------- */

module.exports = async function mpWebhookAuth(req, _res, next) {
  const raw = req.rawBody || req.body;
  const payload = safeParseJsonBuffer(raw);

  if (!req.security) req.security = {};
  if (!req.security.mp) req.security.mp = {};

  try {
    // 1) Optional path secret (soft)
    const ps = checkPathSecret(req);
    if (!ps.ok) {
      const reason = `path_secret_${ps.reason}`;
      if (shouldLogOnce(`ps:${reason}`)) await logFailure(reason, req, payload);
      req.security.mp = { verified: false, reason };
      req.webhookAuth = { ok: false, pathSecretOk: false, signatureOk: false, reason };
      req.mpSig = { verify: 'soft-fail', reason };
      req.body = payload;
      return next();
    }

    // 2) Signature parts and ids
    const sig = parseSignatureHeader(req.get('x-signature') || '');
    const xRequestId = req.get('x-request-id') || req.get('x-correlation-id') || '';
    const id = extractEventId(payload);

    if (!sig || !xRequestId || !id) {
      const reason = 'bad_signature_format';
      if (shouldLogOnce(`fmt:${xRequestId || 'no-xrid'}`)) await logFailure(reason, req, payload);
      req.security.mp = { verified: false, reason };
      req.webhookAuth = { ok: false, pathSecretOk: true, signatureOk: false, reason };
      req.mpSig = { verify: 'soft-fail', reason, xRequestId, id };
      req.body = payload;
      return next();
    }

    // 3) Timestamp tolerance
    const tsMs = normalizeTsToMs(sig.ts);
    if (!Number.isFinite(tsMs)) {
      const reason = 'invalid_ts';
      if (shouldLogOnce(`ts:${xRequestId}`)) await logFailure(reason, req, payload);
      req.security.mp = { verified: false, reason };
      req.webhookAuth = { ok: false, pathSecretOk: true, signatureOk: false, reason };
      req.mpSig = { verify: 'soft-fail', reason, xRequestId, id };
      req.body = payload;
      return next();
    }
    const isStale = Math.abs(Date.now() - tsMs) > DEFAULT_TOLERANCE_MS;

    // 4) Secret
    const secret = await resolveMpSecret();
    if (!secret) {
      const reason = 'no_secret';
      if (shouldLogOnce(`sec:${xRequestId}`)) await logFailure(reason, req, payload);
      req.security.mp = { verified: false, reason };
      req.webhookAuth = { ok: false, pathSecretOk: true, signatureOk: false, reason };
      req.mpSig = { verify: 'soft-fail', reason, xRequestId, id };
      req.body = payload;
      return next();
    }

    // 5) HMAC(v1)
    const manifest = buildManifest({ id, requestId: xRequestId, ts: String(sig.ts) });
    const expected = hmacSha256(String(secret), manifest);

    let signatureOk = false;
    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(sig.v1, 'hex');
      signatureOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { signatureOk = false; }

    // 6) Duplicate flag
    const nowSec = Math.floor(Date.now() / 1000);
    gcRecent(nowSec);
    const isDup = recentRequestIds.has(xRequestId);
    rememberRequestId(xRequestId, Math.floor(tsMs / 1000));

    // 7) Outcome (never block)
    if (!signatureOk) {
      const reason = 'invalid_signature';
      if (shouldLogOnce(`sig:${xRequestId}`)) await logFailure(reason, req, payload);
      req.security.mp = { verified: false, reason, ts: tsMs, requestId: xRequestId, dataId: id };
      req.webhookAuth = { ok: false, pathSecretOk: true, signatureOk: false, reason };
      req.mpSig = { verify: 'soft-fail', reason, xRequestId, id };
    } else if (isDup) {
      const reason = 'duplicate_request_id';
      if (shouldLogOnce(`dup:${xRequestId}`)) await logFailure(reason, req, payload);
      req.security.mp = { verified: false, reason, ts: tsMs, requestId: xRequestId, dataId: id };
      req.webhookAuth = { ok: false, pathSecretOk: true, signatureOk: true, reason };
      req.mpSig = { verify: 'soft-fail', reason, xRequestId, id };
    } else if (isStale) {
      const reason = 'ignored_stale_ts';
      if (shouldLogOnce(`stale:${xRequestId}`)) await logFailure(reason, req, payload);
      req.security.mp = { verified: true, stale: true, ts: tsMs, requestId: xRequestId, dataId: id };
      req.webhookAuth = { ok: true, pathSecretOk: true, signatureOk: true, reason };
      req.mpSig = { id, ts: Math.floor(tsMs / 1000), v1: sig.v1, xRequestId, stale: true };
    } else {
      req.security.mp = { verified: true, ts: tsMs, requestId: xRequestId, dataId: id };
      req.webhookAuth = { ok: true, pathSecretOk: true, signatureOk: true };
      req.mpSig = { id, ts: Math.floor(tsMs / 1000), v1: sig.v1, xRequestId };
    }

    req.body = payload;
    return next();
  } catch {
    // Soft-fail on any exception
    try { await logFailure('middleware_exception', req, payload); } catch {}
    req.security.mp = { verified: false, reason: 'middleware_exception' };
    req.webhookAuth = { ok: false, pathSecretOk: true, signatureOk: false, reason: 'middleware_exception' };
    req.mpSig = { verify: 'soft-fail', reason: 'middleware_exception' };
    req.body = payload;
    return next();
  }
};
