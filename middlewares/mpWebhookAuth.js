// middlewares/mpWebhookAuth.js

const crypto = require('crypto');

const SECRET = process.env.MP_WEBHOOK_SECRET || '';               // <- secret signature do MP (não é o access token)
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true'; // escape hatch p/ dev/sandbox

module.exports = function mpWebhookAuth(req, res, next) {
  if (!SECRET) {
    return res.status(500).json({ message: 'Misconfigured: MP_WEBHOOK_SECRET is missing' });
  }

  // Headers exigidos pelo MP
  const sigHeader = req.get('x-signature') || '';   // formato: "ts=1697144664,v1=abcdef..."
  const requestId = req.get('x-request-id') || '';

  if (!sigHeader || !requestId) {
    if (ALLOW_UNSIGNED) { req.headers['x-zodika-verified'] = 'false'; return next(); }
    return res.status(401).json({ message: 'Unauthorized: Missing x-signature or x-request-id' });
  }

  // Extrai ts e v1 do x-signature
  let ts = '', v1 = '';
  try {
    sigHeader.split(',').forEach((part) => {
      const [k, v] = part.split('=');
      if (!k || !v) return;
      const key = k.trim().toLowerCase();
      const val = v.trim();
      if (key === 'ts') ts = val;
      if (key === 'v1') v1 = val;
    });
  } catch (_) {/* noop */}

  if (!ts || !v1) {
    if (ALLOW_UNSIGNED) { req.headers['x-zodika-verified'] = 'false'; return next(); }
    return res.status(401).json({ message: 'Unauthorized: Invalid x-signature format' });
  }

  // Recupera o id do pagamento/merchant_order do query/body, como o MP costuma enviar
  const q = req.query || {};
  const b = req.body || {};
  const id = q.id || q['data.id'] || b?.data?.id || b?.id || '';
  if (!id) {
    if (ALLOW_UNSIGNED) { req.headers['x-zodika-verified'] = 'false'; return next(); }
    return res.status(400).json({ message: 'Bad Request: missing data.id/id in notification' });
  }

  // Manifesto exigido pelo MP: id + request-id + ts
  const manifest = `id:${id};request-id:${requestId};ts:${ts};`;

  // HMAC-SHA256(manifest, MP_WEBHOOK_SECRET) deve bater com v1
  try {
    const digestHex = crypto.createHmac('sha256', SECRET).update(manifest, 'utf8').digest('hex');
    const a = Buffer.from(digestHex, 'hex');
    const bbuf = Buffer.from(v1, 'hex');
    if (a.length !== bbuf.length || !crypto.timingSafeEqual(a, bbuf)) {
      if (ALLOW_UNSIGNED) { req.headers['x-zodika-verified'] = 'false'; return next(); }
      return res.status(403).json({ message: 'Forbidden: Invalid signature' });
    }
  } catch {
    if (ALLOW_UNSIGNED) { req.headers['x-zodika-verified'] = 'false'; return next(); }
    return res.status(400).json({ message: 'Bad signature format' });
  }

  req.headers['x-zodika-verified'] = 'true';
  return next();
};
