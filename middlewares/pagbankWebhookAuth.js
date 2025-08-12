// src/middlewares/pagbankWebhookAuth.js
const crypto = require('crypto');
const PAGBANK_API_TOKEN = process.env.PAGBANK_API_TOKEN;
function pagbankWebhookAuth(req, res, next) {
    
    const receivedSignature = req.headers['x-authenticity-token'];
    if (!receivedSignature) {
        return res.status(401).json({ message: 'Unauthorized: Missing signature' });
    }

    const rawPayload = req.rawBody || JSON.stringify(req.body);

    const stringToHash = `${PAGBANK_API_TOKEN}-${rawPayload}`;

    const hash = crypto.createHash('sha256');
    hash.update(stringToHash);
    const generatedSignature = hash.digest('hex');
    
    if (generatedSignature !== receivedSignature) {
        return res.status(403).json({ message: 'Forbidden: Invalid signature' });
    }

    next();
}

module.exports = pagbankWebhookAuth;
