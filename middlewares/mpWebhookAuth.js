// middlewares/mpWebhookAuth.js
'use strict';

const crypto = require('crypto');
const db = require('../db/db');
const { get: getSecret } = require('../config/secretProvider');

/**
 * Mercado Pago webhook authentication & anti-replay middleware
 * -----------------------------------------------------------
 * Validates the `x-signature` header against a manifest built from:
 *   "id:{id};request-id:{x-request-id};ts:{ts};"
 *
 * Goals:
 *  - Security: verify HMAC & timestamp skew (seconds OR milliseconds).
 *  - Resilience: NEVER drop the webhook; controller will always run and persist events.
 *  - Noise control: "stale but valid" requests are logged once as `ignored_stale_ts`.
 *  - Privacy: sanitize headers/body before persisting diagnostics.
 *
 * Outcome:
 *  - Success (fresh):  req.mpSig = { id, ts, v1, xRequestId }, req.body = parsed JSON.
 *  - Success (stale):  req.mpSig = { id, ts, v1, xRequestId, stale: true }, req.body parsed.
 *  - Soft-fail:        req.mpSig = { verify: 'soft-fail', reason, xRequestId, id }, parsed body.
 *  - Always calls next() so the controller logs and handles idempotently.
 */

// Fixed tolerance window: 15 minutes (milliseconds)
const TOLERANCE_MS = 15 * 60 * 1000;

// In-memory dedupe of x-request-id (per-process, best-effort)
const recentRequestIds = new Map(); // id -> expireAt (epoch seconds)
function gcRecentIds(nowSec) {
  for (const [k, exp] of recentRequestIds.entries()) if (exp <= nowSec) recentRequestIds.delete(k);
}
function rememberRequestId(id, tsSec) {
  const expireAt = Math.max(tsSec, Math.floor(Date.now() / 1000)) + Math.floor(TOLERANCE_MS / 1000);
  recentRequestIds.set(id, expireAt);
}

// Best-effort dedupe for failure logs: avoid spamming same (requestId + reason)
const recentLogKeys = new Map(); // key -> expireAt (epoch seconds)
function shouldLogOnce(key) {
  const now = Math.floor(Date.now() / 1000);
  const exp = recentLogKeys.get(key);
  // GC occasionally
  if (!exp || exp <= now) {
    // expire this key in tolerance window
    recentLogKeys.set(key, now + Math.floor(TOLERANCE_MS / 1000));
    // also sweep others lazily
    for (const [k, e] of recentLogKeys.entries()) if (e <= now) recentLogKeys.delete(k);
    return true;
  }
  return false;
}

/* -------------------- Sanitization & helpers -------------------- */

const SENSITIVE_HEADER_SET = new Set(['authorization','cookie','set-cookie','x-api-key','x-access-token','x-client-secret','x-signature']);
function safeJsonStringify(obj){ try { return JSON.stringify(obj); } catch { return String(obj); } }
function sanitizeHeaders(headers){
  if (!headers || typeof headers !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase();
    out[k] = SENSITIVE_HEADER_SET.has(key) ? '[REDACTED]' : (typeof v === 'string' ? v : safeJsonStringify(v));
  }
  return out;
}
function maskEmail(value){
  const s = String(value || ''); const [u,d] = s.split('@'); if(!d) return '[REDACTED_EMAIL]';
  const uu = u.length<=2? '*'.repeat(u.length): u[0]+'*'.repeat(u.length-2)+u[u.length-1];
  const dd = d.replace(/^[^.]*/, m => (m.length<=2? '*'.repeat(m.length): m[0]+'*'.repeat(m.length-2)+m[m.length-1]));
  return `${uu}@${dd}`;
}
function maskDigits(v, keep=2){ const s=String(v||'').replace(/\D+/g,''); if(!s) return '[REDACTED_DIGITS]'; return '*'.repeat(Math.max(0, s.length-keep))+s.slice(-keep); }
function maskPhone(v){ return maskDigits(v,4); }
function maskTaxId(v){ return maskDigits(v,3); }
const SENSITIVE_JSON_KEYS = ['authorization','access_token','refresh_token','id_token','token','secret','client_secret','api_key','apikey','password','pwd','signature','hmac','security_code','cvv','cvc','card_number','pan','card'];
const PII_KEYS = ['email','e-mail','mail','tax_id','document','cpf','cnpj','phone','phone_number','mobile','whatsapp'];
function maskValueByKey(key,value){
  const k=String(key).toLowerCase();
  if (SENSITIVE_JSON_KEYS.includes(k)) return '[REDACTED]';
  if (PII_KEYS.includes(k)) {
    if (k.includes('email')||k==='mail'||k==='e-mail') return maskEmail(value);
    if (k.includes('phone')||k==='mobile'||k==='whatsapp') return maskPhone(value);
    if (k==='tax_id'||k==='document'||k==='cpf'||k==='cnpj') return maskTaxId(value);
    return '[REDACTED_PII]';
  }
  return value;
}
function sanitizeJson(value,depth=0){
  if (value==null) return value;
  if (depth>8) return '[TRUNCATED_DEPTH]';
  if (typeof value!=='object') return value;
  if (Array.isArray(value)) return value.map(v=>sanitizeJson(v,depth+1));
  const out={}; for (const [k,v] of Object.entries(value)){ const m=maskValueByKey(k,v); out[k]=(typeof m==='object' && m!==null)?sanitizeJson(m,depth+1):m; }
  return out;
}
function safeParseJsonBuffer(buf){ try{ const t=Buffer.isBuffer(buf)?buf.toString('utf8'):String(buf||''); return t?JSON.parse(t):null; } catch { return null; } }

/** Normalize a timestamp (string/number) to milliseconds since epoch.
 *  - Accepts seconds (10 digits) and milliseconds (13 digits).
 *  - Returns NaN if not parseable. */
function normalizeTsToMs(tsRaw){
  if (tsRaw == null) return NaN;
  const n = Number(tsRaw);
  if (!Number.isFinite(n)) return NaN;
  if (n >= 1e13) return Math.floor(n);         // already ms (13+ digits)
  if (n >= 1e9)  return Math.floor(n * 1000);  // seconds → ms (10+ digits)
  // Fallback: treat small positives as seconds
  if (n > 0) return Math.floor(n * 1000);
  return NaN;
}

async function logFailure(reason, req, parsedBody=null){
  try {
    const headers = sanitizeHeaders(req?.headers || null);
    let raw_body = null;
    if (parsedBody && typeof parsedBody==='object') raw_body = sanitizeJson(parsedBody);
    else if (req?.rawBody || req?.body) {
      const text = Buffer.isBuffer(req.rawBody || req.body) ? (req.rawBody || req.body).toString('utf8').slice(0,4096) : safeJsonStringify(req.body);
      raw_body = { raw: text };
    }
    await db.query(
      `INSERT INTO mp_webhook_failures (reason, headers, raw_body) VALUES ($1,$2,$3)`,
      [reason, headers, raw_body]
    );
  } catch { /* swallow */ }
}

/* -------------------- Signature & manifest -------------------- */

function parseSignatureHeader(h){
  if (!h || typeof h!=='string') return null;
  const parts=h.split(/[;,]\s*/g).map(s=>s.trim()).filter(Boolean);
  const obj={}; for(const p of parts){ const i=p.indexOf('='); if(i>0){ const k=p.slice(0,i).trim(); const v=p.slice(i+1).trim(); if(k&&v) obj[k]=v; } }
  if (!obj.ts || !obj.v1) return null;
  return { ts: obj.ts, v1: obj.v1 };
}

// Extract id from body for manifest (data.id | id | resource last segment)
function extractEventId(b){
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
function hmacSha256(secret, data){
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/* -------------------- Middleware -------------------- */

module.exports = async function mpWebhookAuth(req, res, next) {
  // Always parse raw → JSON for downstream handlers
  const raw = req.rawBody || req.body;
  const payload = safeParseJsonBuffer(raw) || {};

  try {
    const secret = await getSecret('MP_WEBHOOK_SECRET'); // throws if not configured
    const sigHeader = req.header('x-signature');
    const xRequestId = req.header('x-request-id') || '';

    const sig = parseSignatureHeader(sigHeader);
    const id  = extractEventId(payload);

    // If we don't even have the basic parts, soft-fail early (still let it through)
    if (!sig || !xRequestId || !id) {
      const reason = 'bad_signature_format';
      const key = `${xRequestId || 'no-xrid'}:${reason}`;
      if (shouldLogOnce(key)) await logFailure(reason, req, payload).catch(()=>{});
      req.mpSig = { verify: 'soft-fail', reason, xRequestId, id };
      req.body = payload;
      return next();
    }

    // Normalize timestamp for skew check (seconds OR milliseconds)
    const tsMs = normalizeTsToMs(sig.ts);
    if (!Number.isFinite(tsMs)) {
      const reason = 'invalid_ts';
      const key = `${xRequestId}:${reason}`;
      if (shouldLogOnce(key)) await logFailure(reason, req, payload).catch(()=>{});
      req.mpSig = { verify: 'soft-fail', reason, xRequestId, id };
      req.body = payload;
      return next();
    }

    // Check skew and mark stale, but don't block
    const isStale = Math.abs(Date.now() - tsMs) > TOLERANCE_MS;

    // Compute/compare HMAC over the exact manifest (ts EXACTLY as sent)
    const manifest = buildManifest({ id, requestId: xRequestId, ts: String(sig.ts) });
    const expected = hmacSha256(secret, manifest);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig.v1, 'hex');
    const hmacOk = (a.length === b.length) && crypto.timingSafeEqual(a, b);

    // Duplicate request-id best-effort check (after HMAC)
    const nowSec = Math.floor(Date.now()/1000);
    gcRecentIds(nowSec);
    const isDup = recentRequestIds.has(xRequestId);
    rememberRequestId(xRequestId, Math.floor(tsMs/1000) || nowSec);

    // Decide outcome and logging
    if (!hmacOk) {
      const reason = 'invalid_signature';
      const key = `${xRequestId}:${reason}`;
      if (shouldLogOnce(key)) await logFailure(reason, req, payload).catch(()=>{});
      req.mpSig = { verify: 'soft-fail', reason, xRequestId, id };
    } else if (isDup) {
      const reason = 'duplicate_request_id';
      const key = `${xRequestId}:${reason}`;
      if (shouldLogOnce(key)) await logFailure(reason, req, payload).catch(()=>{});
      req.mpSig = { verify: 'soft-fail', reason, xRequestId, id };
    } else if (isStale) {
      // Signature valid but outside tolerance: accept & mark stale; log once as "ignored"
      const reason = 'ignored_stale_ts';
      const key = `${xRequestId}:${reason}`;
      if (shouldLogOnce(key)) await logFailure(reason, req, payload).catch(()=>{});
      req.mpSig = { id, ts: Math.floor(tsMs/1000), v1: sig.v1, xRequestId, stale: true };
    } else {
      // Fresh & valid
      req.mpSig = { id, ts: Math.floor(tsMs/1000), v1: sig.v1, xRequestId };
    }

    req.body = payload;
    return next();
  } catch {
    // On unexpected errors (missing secret, etc.), still proceed to avoid webhooks loss
    await logFailure('middleware_exception', req, payload).catch(()=>{});
    req.mpSig = { verify: 'soft-fail', reason: 'middleware_exception' };
    req.body = payload;
    return next();
  }
};
