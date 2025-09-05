// middlewares/mpWebhookAuth.js
'use strict';

/**
 * Mercado Pago Webhook Auth (soft-fail)
 * -------------------------------------
 * What this middleware guarantees:
 *  - Parses the raw body (JSON) into req.body (keeps req.rawBody intact).
 *  - (Optional) Path secret guard via WEBHOOK_PATH_SECRET (param | ?s= | x-webhook-secret).
 *  - Verifies HMAC-SHA256 signature from `x-signature` header:
 *        manifest = "id:{data.id};request-id:{x-request-id};ts:{ts};"
 *        signature = HMAC_SHA256(MP_WEBHOOK_SECRET, manifest) -> hex (v1)
 *  - Accepts ts in seconds OR milliseconds; checks skew (default 15 min, tunable).
 *  - Best-effort duplicate guard via in-memory cache of x-request-id.
 *  - NEVER drops the webhook: attaches result to `req.webhookAuth` (and `req.mpSig` for
 *    backward-compat) and calls `next()` so router/service can respond 200.
 *
 * Privacy / Ops:
 *  - No secrets or tokens are logged. Optional DB logging of failures is sanitized.
 *  - Keep this middleware fast and tolerant; persistence & idempotency live in the service/repo.
 */

const crypto = require('crypto');
const db = require('../db/db'); // optional failure audit; errors are swallowed
const { get: getSecret } = require('../config/secretProvider');

/* ----------------------------- Config knobs ----------------------------- */

const DEFAULT_TOLERANCE_MS = Number.isFinite(Number(process.env.WEBHOOK_TS_TOLERANCE_MS))
  ? Number(process.env.WEBHOOK_TS_TOLERANCE_MS)
  : 15 * 60 * 1000; // 15 minutes

/* ------------------------- In-memory best-effort ------------------------- */

// x-request-id -> expireAt (epoch seconds)
const recentRequestIds = new Map();
function gcRecent(nowSec) {
  for (const [k, exp] of recentRequestIds.entries()) if (exp <= nowSec) recentRequestIds.delete(k);
}
function rememberRequestId(id, baseTsSec) {
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = Math.floor(DEFAULT_TOLERANCE_MS / 1000);
  const expireAt = Math.max(baseTsSec || nowSec, nowSec) + ttlSec;
  recentRequestIds.set(id, expireAt);
}

// failure-log dedupe: key -> expireAt
const recentLogKeys = new Map();
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

/* ----------------------------- Sanitization ----------------------------- */

const SENSITIVE_HEADER_SET = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-access-token', 'x-client-secret', 'x-signature',
]);

function safeJsonStringify(obj) { try { return JSON.stringify(obj); } catch { return String(obj); } }
function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase();
    out[k] = SENSITIVE_HEADER_SET.has(key) ? '[REDACTED]' : (typeof v === 'string' ? v : safeJsonStringify(v));
  }
  return out;
}

const SENSITIVE_JSON_KEYS = [
  'authorization','access_token','refresh_token','id_token','token','secret','client_secret','api_key','apikey',
  'password','pwd','signature','hmac','security_code','cvv','cvc','card_number','pan','card',
];
const PII_KEYS = ['email','e-mail','mail','tax_id','document','cpf','cnpj','phone','phone_number','mobile','whatsapp'];

function maskEmail(value) {
  const s = String(value || ''); const [u, d] = s.split('@'); if (!d) return '[REDACTED_EMAIL]';
  const uu = u.length <= 2 ? '*'.repeat(u.length) : u[0] + '*'.repeat(u.length - 2) + u[u.length - 1];
  const dd = d.replace(/^[^.]+/, m => (m.length <= 2 ? '*'.repeat(m.length) : m[0] + '*'.repeat(m.length - 2) + m[m.length - 1]));
  return `${uu}@${dd}`;
}
function maskDigits(v, keep = 2) { const s = String(v || '').replace(/\D+/g, ''); if (!s) return '[REDACTED_DIGITS]'; return '*'.repeat(Math.max(0, s.length - keep)) + s.slice(-keep); }
function maskPhone(v) { return maskDigits(v, 4); }
function maskTaxId(v) { return maskDigits(v, 3); }

function maskValueByKey(key, value) {
  const k = String(key).toLowerCase();
  if (SENSITIVE_JSON_KEYS.includes(k)) return '[REDACTED]';
  if (PII_KEYS.includes(k)) {
    if (k.includes('email') || k === 'mail' || k === 'e-mail') return maskEmail(value);
    if (k.includes('phone') || k === 'mobile' || k === 'whatsapp') return maskPhone(value);
    if (k === 'tax_id' || k === 'document' || k === 'cpf' || k === 'cnpj') return maskTaxId(value);
    return '[REDACTED_PII]';
  }
  return value;
}

function sanitizeJson(value, depth = 0) {
  if (value == null) return value;
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => sanitizeJson(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const masked = maskValueByKey(k, v);
    out[k] = (typeof masked === 'object' && masked !== null) ? sanitizeJson(masked, depth + 1) : masked;
  }
  return out;
}

/* ------------------------------- Utilities ------------------------------- */

function safeParseJsonBuffer(buf) {
  try {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    return text ? JSON.parse(text) : {};
  } catch { return {}; }
}

/** seconds or milliseconds -> ms */
function normalizeTsToMs(tsRaw) {
  const n = Number(tsRaw);
  if (!Number.isFinite(n)) return NaN;
  if (n >= 1e13) return Math.floor(n);           // already ms
  if (n >= 1e9)  return Math.floor(n * 1000);    // seconds
  if (n > 0)     return Math.floor(n * 1000);    // small positives as seconds
  return NaN;
}

function parseSignatureHeader(h) {
  if (!h || typeof h !== 'string') return null;
  const parts = h.split(/[;,]\s*/g).map(s => s.trim()).filter(Boolean);
  const obj = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i > 0) {
      const k = p.slice(0, i).trim();
      const v = p.slice(i + 1).trim();
      if (k && v) obj[k] = v;
    }
  }
  if (!obj.ts || !obj.v1) return null;
  return { ts: obj.ts, v1: obj.v1 };
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
  // The exact order and trailing semicolon are important.
  return `id:${id};request-id:${requestId};ts:${ts};`;
}

function hmacSha256(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

async function resolveMpSecret() {
  const fromProvider = await getSecret('MP_WEBHOOK_SECRET').catch(() => null);
  return fromProvider || process.env.MP_WEBHOOK_SECRET || null;
}

function checkPathSecret(req) {
  const configured = process.env.WEBHOOK_PATH_SECRET || null;
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
    const headers = sanitizeHeaders(req?.headers || null);
    const body = parsedBody && typeof parsedBody === 'object'
      ? sanitizeJson(parsedBody)
      : { raw: safeJsonStringify(parsedBody) };
    await db.query(
      `INSERT INTO mp_webhook_failures (reason, headers, raw_body) VALUES ($1,$2,$3)`,
      [reason, headers, body]
    );
  } catch { /* swallow */ }
}

/* -------------------------------- Middleware -------------------------------- */

module.exports = async function mpWebhookAuth(req, res, next) {
  // Always parse raw → JSON for downstream handlers
  const raw = req.rawBody || req.body;
  const payload = safeParseJsonBuffer(raw);

  // Prepare containers expected by routers/services
  if (!req.security) req.security = {};
  if (!req.security.mp) req.security.mp = {};

  try {
    // 1) Optional path secret guard (soft-fail)
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

    // 2) Extract signature parts and identifiers
    const sigHeader = req.get('x-signature') || '';
    const sig = parseSignatureHeader(sigHeader);
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

    // 3) Timestamp normalization + staleness
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

    // 4) Resolve secret (soft-fail if missing)
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

    // 5) Compute/compare HMAC
    const manifest = buildManifest({ id, requestId: xRequestId, ts: String(sig.ts) });
    const expected = hmacSha256(String(secret), manifest);

    let signatureOk = false;
    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(sig.v1, 'hex');
      signatureOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { signatureOk = false; }

    // 6) Duplicate detection (best-effort)
    const nowSec = Math.floor(Date.now() / 1000);
    gcRecent(nowSec);
    const isDup = recentRequestIds.has(xRequestId);
    rememberRequestId(xRequestId, Math.floor(tsMs / 1000));

    // 7) Compose outcome (never block)
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
  } catch (err) {
    // Any unexpected failure becomes a soft-fail; still continue
    try { await logFailure('middleware_exception', req, payload); } catch {}
    req.security.mp = { verified: false, reason: 'middleware_exception' };
    req.webhookAuth = { ok: false, pathSecretOk: true, signatureOk: false, reason: 'middleware_exception' };
    req.mpSig = { verify: 'soft-fail', reason: 'middleware_exception' };
    req.body = payload;
    return next();
  }
};
