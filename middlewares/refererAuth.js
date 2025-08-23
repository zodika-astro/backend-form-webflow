// middlewares/refererAuth.js

const { URL } = require('url');

const ALLOWED = (process.env.ALLOWED_REFERERS).split(',').map(s => s.trim().replace(/\/+$/, '')); // strip trailing slash

function isAllowedHost(val) {
  if (!val) return false;
  try {
    const u = new URL(val);
    const host = `${u.protocol}//${u.host}`; 
    return ALLOWED.some(base => host === base);
  } catch {
    return false; 
  }
}

module.exports = function refererAuth(req, res, next) {
  const referer = req.get('referer') || '';
  const origin  = req.get('origin')  || '';

  if (isAllowedHost(referer) || isAllowedHost(origin)) {
    return next();
  }

  return res.status(403).json({
    message: 'Forbidden: Invalid referer/origin',

  });
};
