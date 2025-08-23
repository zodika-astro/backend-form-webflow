// middlewares/pagbankWebhookAuth.js
const crypto = require('crypto');

const TOKEN = process.env.PAGBANK_API_TOKEN || '';
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true'; // sandbox escape hatch

module.exports = function pagbankWebhookAuth(req, res, next) {
  if (!TOKEN) {
    return res.status(500).json({ message: 'Misconfigured: PAGBANK_API_TOKEN is missing' });
  }

  // Header name is case-insensitive, Express normalizes keys to lowercase
  const received = req.get('x-authenticity-token') || '';
  const raw = typeof req.rawBody === 'string' ? req.rawBody : '';

  if (!received) {
    // In sandbox the header may be missing; allow only if explicitly enabled
    if (ALLOW_UNSIGNED) {
      req.headers['x-zodika-verified'] = 'false';
      return next();
    }
    return res.status(401).json({ message: 'Unauthorized: Missing x-authenticity-token' });
  }

  // Compute SHA-256 over `${token}-${rawPayload}` exactly as sent
  const toHash = `${TOKEN}-${raw}`;
  const digestHex = crypto.createHash('sha256').update(toHash, 'utf8').digest('hex');

  // timing-safe compare to avoid subtle attacks
  try {
    const a = Buffer.from(digestHex, 'hex');
    const b = Buffer.from(received, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ message: 'Forbidden: Invalid signature' });
    }
  } catch {
    return res.status(400).json({ message: 'Bad signature format' });
  }

  req.headers['x-zodika-verified'] = 'true'; // we also persist headers in events table
  next();
};
