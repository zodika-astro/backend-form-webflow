// middlewares/mpWebhookAuth.js
const crypto = require('crypto');
const db = require('../db/db');

const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true';

// log sem await
async function logFailure(reason, req) {
  try {
    await db.query(
      `INSERT INTO mp_webhook_failures (reason, headers, raw_body)
       VALUES ($1, $2, $3)`,
      [reason, req?.headers || null, req?.body || null]
    );
  } catch (_) {}
}

function parseSignatureHeader(sigHeader) {
  if (!sigHeader || typeof sigHeader !== 'string') return null;
  const parts = sigHeader.split(/[;,]\s*/g).map(s => s.trim());
  const obj = {};
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k && v) obj[k] = v;
  }
  if (!obj.ts || !obj.v1) return null;
  return { ts: obj.ts, v1: obj.v1 };
}

// extrai id de v1 (data.id) ou v2 (resource URL)
function extractEventId(body) {
  if (!body) return null;
  // v1
  if (body.data && body.data.id) return String(body.data.id);
  // v2: "resource": "https://api.mercadolibre.com/merchant_orders/33672950180"
  if (body.resource && typeof body.resource === 'string') {
    const m = body.resource.match(/\/(\d+)(?:\?.*)?$/);
    if (m) return m[1];
  }
  // às vezes "resource" traz só o id
  if (body.resource && /^\d+$/.test(String(body.resource))) return String(body.resource);
  return null;
}

function buildManifest({ id, requestId, ts }) {
  // padrão: id:<id>;request-id:<x-request-id>;ts:<ts>;
  return `id:${id};request-id:${requestId};ts:${ts};`;
}

function hmacSha256(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function mpWebhookAuth(req, res, next) {
  try {
    if (ALLOW_UNSIGNED) return next();

    const sigHeader = req.header('x-signature');
    const xRequestId = req.header('x-request-id');
    const parsed = parseSignatureHeader(sigHeader);
    const id = extractEventId(req.body);

    if (!parsed || !xRequestId || !id) {
      logFailure('bad_signature_format', req).catch(() => {});
      return res.status(400).json({ message: 'Bad signature format' });
    }

    const manifest = buildManifest({ id, requestId: xRequestId, ts: parsed.ts });
    const computed = hmacSha256(MP_WEBHOOK_SECRET, manifest);

    if (!computed || computed !== parsed.v1) {
      logFailure('invalid_signature', req).catch(() => {});
      return res.status(403).json({ message: 'Forbidden: Invalid signature' });
    }

    req.mpSig = { id, ts: parsed.ts, v1: parsed.v1, xRequestId };
    return next();
  } catch (err) {
    logFailure('middleware_exception', req).catch(() => {});
    return res.status(400).json({ message: 'Signature validation error' });
  }
}

module.exports = mpWebhookAuth;
