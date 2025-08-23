// middlewares/refererAuth.js

const ALLOWED = ['https://www.zodika.com.br', 'https://zodika.com.br'];
const ok = referer && ALLOWED.some(base => referer.startsWith(base));

function refererAuth(req, res, next) {
    const referer = req.headers.referer;
    
    if (!referer || !referer.startsWith(ALLOWED_REFERER)) {
        return res.status(403).json({ message: 'Forbidden: Invalid referer' });
}
    next();
}

module.exports = refererAuth;
