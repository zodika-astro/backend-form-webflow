// middlewares/mpWebhookAuth.js
'use strict';

const crypto = require('crypto');
const db = require('../db/db');

/**
 * Mercado Pago webhook authentication & anti-replay middleware
 * -----------------------------------------------------------
 * Validates the `x-signature` header against a manifest built from:
 *   `id:{data.id};request-id:{x-request-id};ts:{ts};`
 *
 * Security steps:
 *  - Require presence of MP secret (`MP_WEBHOOK_SECRET`).
 *  - Parse `x-signature` => extract `ts` and `v1` (HMAC-SHA256).
 *  - Extract `id` from the *raw* JSON body (Buffer) to avoid parser-induced mutations.
 *  - Enforce timestamp tolerance window (default: 5 minutes) to mitigate replay.
 *  - Compare HMAC using `crypto.timingSafeEqual`.
 *  - Optionally detect duplicate `x-request-id` within the tolerance window (best-effort).
 *  - Sanitize any failure logs to avoid leaking secrets/PII.
 *
 * After successful verification:
 *  - `req.mpSig = { id, ts, v1, xRequestId }`
 *  - `req.body` is replaced with the parsed JSON object (safe to use in controllers).
 */

const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true';
const DEFAULT_TOLERANCE_SEC = Number(process.env.MP_WEBHOOK_TOLERANCE_SECONDS || 300); // 5 minutes
const REJECT_DUP = process.env.MP_WEBHOOK_REJECT_DUP_REQUEST_ID === 'true';

// Best-effort in-memory dedupe of x-request-id within the tolerance window.
// NOTE: This is per-process only and complements DB-level idempotency.
const recentRequestIds = new Map(); // key -> expireAt(unixtime)

function gcRecentIds(nowSec) {
  for (const [k, exp] of recentRequestIds.entries()) {
    if (exp <= nowSec) recentRequestIds.delete(k);
  }
}

function rememberRequestId(id, tsSec) {
  const expireAt = Math.max(tsSec, Math.floor(Date.now() / 1000)) + DEFAULT_TOLERANCE_SEC;
  recentRequestIds.set(id, expireAt);
}

function hasRecentRequestId(id, nowSec) {
  const exp = recentRequestIds.get(id);
  return typeof exp === 'number' && exp > nowSec;
}

/* -------------------- Sanitization utilities (headers + arbitrary JSON) -------------------- */

// Header names that must be redacted (case-insensitive)
const SENSITIVE_HEADER_SET = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-access-token',
  'x-client-secret',
  'x-signature',
]);

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
  'authorization', 'access_token', 'refresh_token', 'id_token', 'token',
  'secret', 'client_secret', 'api_key', 'apikey', 'password', 'pwd',
  'signature', 'hmac', 'security_code', 'cvv', 'cvc', 'card_number', 'pan', 'card',
];

const PII_KEYS = [
  'email', 'e-mail', 'mail', 'tax_id', 'document', 'cpf', 'cnpj',
  'phone', 'phone_number', 'mobile', 'whatsapp',
];

function maskEmail(value) {
  const s = String(value || '');
  const [user, domain] = s.split('@');
  if (!domain) return '[REDACTED_EMAIL]';
  const u = user.length <= 2 ? '*'.repeat(user.length) : user[0] + '*'.repeat(user.length - 2) + user[user.length - 1];
  const d = domain.replace(/^[^.]*/, m => (m.length <= 2 ? '*'.repeat(m.length) : m[0] + '*'.repeat(m.length - 2) + m[m.length - 1]));
  return `${u}@${d}`;
}

function maskDigits(value, visible = 2) {
  const s = String(value || '').replace(/\D+/g, '');
  if (!s) return '[REDACTED_DIGITS]';
  const keep = Math.min(visible, s.length);
  return '*'.repeat(s.length - keep) + s.slice(-keep);
}
function maskPhone(value) { return maskDigits(value, 4); }
function maskTaxId(value) { return maskDigits(value, 3); }

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

function safeJsonStringify(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

function safeParseJsonBuffer(buf) {
  try {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/* --------------------------------- Failure logging (sanitized) -------------------------------- */

async function logFailure(reason, req, parsedBody = null) {
  try {
    const headers = sanitizeHeaders(req?.headers || null);
    // Store either the sanitized parsed body or a minimal fallback object with a truncated raw string
    let raw_body = null;
    if (parsedBody && typeof parsedBody === 'object') {
      raw_body = sanitizeJson(parsedBody);
    } else if (req?.rawBody || req?.body) {
      const text = Buffer.isBuffer(req.rawBody || req.body)
        ? (req.rawBody || req.body).toString('utf8').slice(0, 4096)
        : safeJsonStringify(req.body);
      raw_body = { raw: text };
    }
    await db.query(
      `INSERT INTO mp_webhook_failures (reason, headers, raw_body)
       VALUES ($1, $2, $3)`,
      [reason, headers, raw_body]
    );
  } catch (_) {
    // Intentionally swallow logging errors
  }
}

/* --------------------------------- Signature parsing & HMAC ----------------------------------- */

function parseSignatureHeader(sigHeader) {
  if (!sigHeader || typeof sigHeader !== 'string') return null;
  // Accept separators "," or ";" with optional spaces
  const parts = sigHeader.split(/[;,]\s*/g).map(s => s.trim()).filter(Boolean);
  const obj = {};
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx > 0) {
      const k = p.slice(0, idx).trim();
      const v = p.slice(idx + 1).trim();
      if (k && v) obj[k] = v;
    }
  }
  if (!obj.ts || !obj.v1) return null;
  return { ts: obj.ts, v1: obj.v1 };
}

// Extracts `data.id` (v1 payload) or last numeric segment from `resource` (v2)
function extractEventId(parsedBody) {
  if (!parsedBody) return null;
  if (parsedBody.data && parsedBody.data.id != null) return String(parsedBody.data.id);
  if (parsedBody.resource && typeof parsedBody.resource === 'string') {
    const m = parsedBody.resource.match(/\/(\d+)(?:\?.*)?$/);
    if (m) return m[1];
  }
  if (parsedBody.resource && /^\d+$/.test(String(parsedBody.resource))) return String(parsedBody.resource);
  return null;
}

function buildManifest({ id, requestId, ts }) {
  // Exact format required by Mercado Pago
  return `id:${id};request-id:${requestId};ts:${ts};`;
}

function hmacSha256(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/* -------------------------------------- Middleware -------------------------------------------- */

function mpWebhookAuth(req, res, next) {
  try {
    // Basic config guardrails
    if (!MP_WEBHOOK_SECRET && !ALLOW_UNSIGNED) {
      // Misconfiguration: without secret, we cannot verify
      return res.status(500).json({ message: 'Webhook secret not configured' });
    }

    // Raw body should be a Buffer (because app uses express.raw() on this route)
    const raw = req.rawBody || req.body;
    const parsedBody = safeParseJsonBuffer(raw);

    if (ALLOW_UNSIGNED) {
      // Dev-mode: accept unsigned but still parse body for downstream handlers
      req.body = parsedBody || {};
      req.mpSig = { devUnsigned: true };
      return next();
    }

    // 1) Parse headers
    const sigHeader = req.header('x-signature');
    const xRequestId = req.header('x-request-id');
    const parsedSig = parseSignatureHeader(sigHeader);
    const id = extractEventId(parsedBody);

    if (!parsedSig || !xRequestId || !id) {
      logFailure('bad_signature_format', req, parsedBody).catch(() => {});
      return res.status(400).json({ message: 'Bad signature format' });
    }

    // 2) Anti-replay: timestamp tolerance check
    const nowSec = Math.floor(Date.now() / 1000);
    const tsSec = Number(parsedSig.ts);
    if (!Number.isFinite(tsSec)) {
      logFailure('invalid_ts', req, parsedBody).catch(() => {});
      return res.status(400).json({ message: 'Invalid timestamp' });
    }

    const skew = Math.abs(nowSec - tsSec);
    if (skew > DEFAULT_TOLERANCE_SEC) {
      logFailure('stale_or_future_timestamp', req, parsedBody).catch(() => {});
      return res.status(401).json({ message: 'Unauthorized: timestamp outside tolerance window' });
    }

    // Optional: duplicate x-request-id detection within tolerance window
    gcRecentIds(nowSec);
    if (REJECT_DUP && hasRecentRequestId(xRequestId, nowSec)) {
      logFailure('duplicate_request_id', req, parsedBody).catch(() => {});
      return res.status(409).json({ message: 'Conflict: duplicate x-request-id' });
    }

    // 3) Compute HMAC over the manifest and compare using constant-time
    const manifest = buildManifest({ id, requestId: xRequestId, ts: parsedSig.ts });
    const computed = hmacSha256(MP_WEBHOOK_SECRET, manifest);

    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(parsedSig.v1, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      logFailure('invalid_signature', req, parsedBody).catch(() => {});
      return res.status(403).json({ message: 'Forbidden: invalid signature' });
    }

    // Passed: remember this request-id (best-effort) to flag potential rapid replays
    rememberRequestId(xRequestId, tsSec);

    // Expose verification context and parsed JSON for downstream handlers
    req.mpSig = { id, ts: tsSec, v1: parsedSig.v1, xRequestId };
    req.body = parsedBody || {};

    return next();
  } catch (err) {
    // Ensure we log sanitized data on unexpected errors
    logFailure('middleware_exception', req).catch(() => {});
    return res.status(400).json({ message: 'Signature validation error' });
  }
}

module.exports = mpWebhookAuth;
