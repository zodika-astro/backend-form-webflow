// middlewares/pagbankWebhookAuth.js
'use strict';

const crypto = require('crypto');
const db = require('../db/db');

/**
 * PagBank webhook authentication & best-effort anti-replay middleware
 * ------------------------------------------------------------------
 * Validates the `x-authenticity-token` header by computing:
 *   SHA-256 over `${PAGBANK_API_TOKEN}-${<raw body bytes as sent>}`
 *
 * Requirements:
 * - The webhook route MUST be configured with `express.raw()` so `req.rawBody` is a Buffer.
 *   (Your index.js already registers `express.raw()` for `/webhook/pagbank*`.)
 *
 * Security steps:
 *  - Use the *exact* raw bytes for hashing (no string re-encoding).
 *  - Compare digests using `crypto.timingSafeEqual`.
 *  - Provide sandbox escape hatch via `ALLOW_UNSIGNED_WEBHOOKS=true` (dev only).
 *  - Best-effort anti-replay: maintain an in-memory cache of recent request identifiers
 *    (prefer `x-request-id` if present; otherwise fall back to the received signature),
 *    with a short TTL to mitigate rapid replays. This complements DB-level idempotency.
 *
 * After successful verification:
 *  - `req.body` is parsed from the raw JSON buffer (safe to use in controllers).
 *  - `req.pagbankSig = { received, digest, dedupKey, isDuplicate }`
 *  - `req.headers['x-zodika-verified'] = 'true'` for downstream auditing (non-sensitive)
 */

const TOKEN = process.env.PAGBANK_API_TOKEN || '';
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true'; // sandbox/dev only

// Anti-replay configuration (short TTL since PagBank may retry on transient 5xx)
const DEFAULT_DEDUP_TTL_SEC = Number(process.env.PAGBANK_WEBHOOK_DEDUP_TTL_SECONDS || 300); // 5 minutes
const REJECT_DUP = process.env.PAGBANK_REJECT_DUP_REQUEST_ID === 'true'; // if true, 409 on duplicate within TTL

// In-memory cache for recent request identifiers (per-process, complementary to DB idempotency)
const recentIds = new Map(); // key -> expireAt (unix seconds)

function gcRecentIds(nowSec) {
  for (const [k, exp] of recentIds.entries()) {
    if (typeof exp === 'number' && exp <= nowSec) recentIds.delete(k);
  }
}
function rememberId(key) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expireAt = nowSec + DEFAULT_DEDUP_TTL_SEC;
  recentIds.set(key, expireAt);
}
function hasRecentId(key) {
  const nowSec = Math.floor(Date.now() / 1000);
  gcRecentIds(nowSec);
  const exp = recentIds.get(key);
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
  'x-authenticity-token',
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
    let raw_body = null;
    if (parsedBody && typeof parsedBody === 'object') {
      raw_body = sanitizeJson(parsedBody);
    } else if (req?.rawBody || req?.body) {
      const text = Buffer.isBuffer(req.rawBody || req.body)
        ? (req.rawBody || req.body).toString('utf8').slice(0, 4096)
        : safeJsonStringify(req.body);
      raw_body = { raw: text };
    }
    // Try to persist into a dedicated failures table if it exists; ignore errors.
    await db.query(
      `INSERT INTO pagbank_webhook_failures (reason, headers, raw_body)
       VALUES ($1, $2, $3)`,
      [reason, headers, raw_body]
    ).catch(() => {});
  } catch {
    // Intentionally swallow logging errors
  }
}

/* -------------------------------------- Middleware -------------------------------------------- */

module.exports = function pagbankWebhookAuth(req, res, next) {
  try {
    // Basic config guardrails
    if (!TOKEN && !ALLOW_UNSIGNED) {
      return res.status(500).json({ message: 'Misconfigured: PAGBANK_API_TOKEN is missing' });
    }

    // Raw body must be a Buffer (due to express.raw() on this route)
    const raw = req.rawBody || req.body;
    if (!Buffer.isBuffer(raw)) {
      // Misconfiguration: JSON/body-parser likely ran before express.raw()
      logFailure('raw_body_missing_or_not_buffer', req).catch(() => {});
      return res.status(500).json({ message: 'Server not configured for raw body on this route' });
    }

    // Optional dev-mode: accept unsigned webhooks (sandbox/testing only)
    const received = String(req.get('x-authenticity-token') || '');
    if (!received) {
      if (ALLOW_UNSIGNED) {
        const parsed = safeParseJsonBuffer(raw) || {};
        req.body = parsed;
        req.headers['x-zodika-verified'] = 'false';
        req.pagbankSig = { devUnsigned: true };
        return next();
      }
      logFailure('missing_authenticity_token', req).catch(() => {});
      return res.status(401).json({ message: 'Unauthorized: Missing x-authenticity-token' });
    }

    // Compute SHA-256 over `${TOKEN}-<raw bytes>` without re-encoding the raw payload
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from(TOKEN + '-', 'utf8'));
    hash.update(raw); // exact bytes as received
    const digestHex = hash.digest('hex');

    // timing-safe compare (hex to hex)
    let ok = false;
    try {
      const a = Buffer.from(digestHex, 'hex');
      const b = Buffer.from(received, 'hex');
      ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      logFailure('bad_signature_format', req).catch(() => {});
      return res.status(400).json({ message: 'Bad signature format' });
    }
    if (!ok) {
      logFailure('invalid_signature', req).catch(() => {});
      return res.status(403).json({ message: 'Forbidden: Invalid signature' });
    }

    // Best-effort anti-replay: prefer x-request-id; fallback to the received signature
    const dedupKey =
      (req.get('x-request-id') && `xreq:${req.get('x-request-id')}`) ||
      `sig:${received.toLowerCase()}`;

    const dup = hasRecentId(dedupKey);
    if (dup && REJECT_DUP) {
      logFailure('duplicate_request_within_ttl', req).catch(() => {});
      return res.status(409).json({ message: 'Conflict: duplicate webhook within TTL window' });
    }
    // Remember this key (regardless of REJECT_DUP, to help next requests)
    rememberId(dedupKey);

    // Parse JSON safely after signature is verified
    const parsed = safeParseJsonBuffer(raw) || {};
    req.body = parsed;

    // Expose verification context (non-sensitive) for downstream handlers/logging
    req.headers['x-zodika-verified'] = 'true';
    req.pagbankSig = {
      received,         // hex signature from header (not sensitive)
      digest: digestHex, // computed hex (not sensitive)
      dedupKey,
      isDuplicate: dup,
    };

    return next();
  } catch (err) {
    logFailure('middleware_exception', req).catch(() => {});
    return res.status(400).json({ message: 'Signature validation error' });
  }
};
