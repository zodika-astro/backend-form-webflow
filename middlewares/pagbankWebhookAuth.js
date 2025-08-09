// src/middlewares/pagbankWebhookAuth.js
const crypto = require('crypto');
const PAGBANK_AUTH_TOKEN = process.env.PAGBANK_AUTH_TOKEN;
function pagbankWebhookAuth(req, res, next) {
    
    const receivedSignature = req.headers['x-authenticity-token'];
    if (!receivedSignature) {
        return res.status(401).json({ message: 'Unauthorized: Missing signature' });
    }

    const rawPayload = JSON.stringify(req.body);

    const stringToHash = `${PAGBANK_AUTH_TOKEN}-${rawPayload}`;

    const hash = crypto.createHash('sha256');
    hash.update(stringToHash);
    const generatedSignature = hash.digest('hex');
    
    if (generatedSignature !== receivedSignature) {
        return res.status(403).json({ message: 'Forbidden: Invalid signature' });
    }

    next();
}

module.exports = pagbankWebhookAuth;
