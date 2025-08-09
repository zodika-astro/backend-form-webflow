middlewares/refererAuth.js
const ALLOWED_REFERER = process.env.WEBFLOW_DOMAIN; 

function refererAuth(req, res, next) {
    const referer = req.headers.referer;

    
    if (!referer || !referer.startsWith(ALLOWED_REFERER)) {
        return res.status(403).json({ message: 'Forbidden: Invalid referer' });
    }

    next();
}

module.exports = refererAuth;
