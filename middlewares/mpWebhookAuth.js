// middlewares/mpWebhookAuth.js
const crypto = require('crypto');
const db = require('../db/db');

const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true'; // escape hatch p/ dev/sandbox

// Loga falhas sem travar o fluxo (sem await aqui)
async function logFailure(reason, req) {
  try {
    await db.query(
      `INSERT INTO mp_webhook_failures (reason, headers, raw_body)
       VALUES ($1, $2, $3)`,
      [reason, req?.headers || null, req?.body || null]
    );
  } catch (_) { /* swallow */ }
}

function parseSignatureHeader(sigHeader) {
  // Ex.: x-signature: ts=1690000000,v1=abcdef...
  // Aceita separadores com vírgula ou ponto e vírgula
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

function buildManifest({ id, requestId, ts }) {
  // Padrão documentado pelo MP (varia por integração):
  // "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
  return `id:${id};request-id:${requestId};ts:${ts};`;
}

function hmacSha256(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// Middleware sem async/await (compatível com Node/Express comum)
function mpWebhookAuth(req, res, next) {
  try {
    if (ALLOW_UNSIGNED) return next();

    // Headers que precisamos
    const sigHeader = req.header('x-signature');
    const xRequestId = req.header('x-request-id');
    const { id } = (req.body && req.body.data) || {};
    const parsed = parseSignatureHeader(sigHeader);

    // Valida formato do header
    if (!parsed || !xRequestId || !id) {
      logFailure('bad_signature_format', req).catch(() => {});
      return res.status(400).json({ message: 'Bad signature format' });
    }

    // Monta manifesto e calcula HMAC
    const manifest = buildManifest({ id, requestId: xRequestId, ts: parsed.ts });
    const computed = hmacSha256(MP_WEBHOOK_SECRET, manifest);

    // Compara
    if (!computed || computed !== parsed.v1) {
      logFailure('invalid_signature', req).catch(() => {});
      return res.status(403).json({ message: 'Forbidden: Invalid signature' });
    }

    // Opcional: anexar info útil para logs/debug nas próximas etapas
    req.mpSig = { ts: parsed.ts, v1: parsed.v1, xRequestId, id };

    return next();
  } catch (err) {
    // Se algo der ruim aqui, loga e bloqueia (fail-closed)
    logFailure('middleware_exception', req).catch(() => {});
    return res.status(400).json({ message: 'Signature validation error' });
  }
}

module.exports = mpWebhookAuth;
