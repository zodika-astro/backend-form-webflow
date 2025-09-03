// middlewares/cors.js
'use strict';

const cors = require('cors');

/**
 * Production-grade CORS + Origin/Referer enforcement
 * --------------------------------------------------
 * Goals:
 * - Allow only trusted Origins for browser requests.
 * - For *public* endpoints (e.g., /birthchart/**), **require** an Origin header and block if missing.
 * - Validate Referer against an allowlist to reduce CSRF-like abuse (defense-in-depth).
 * - Do NOT interfere with server-to-server endpoints (webhooks) or health checks.
 *
 * Environment:
 * - ALLOWED_ORIGINS   : comma-separated list of allowed origins (e.g., "https://foo.com,https://bar.com")
 * - ALLOWED_REFERERS  : comma-separated list of allowed Referer prefixes or origins
 *                       (e.g., "https://foo.com/forms/,https://bar.com")
 * - STRICT_ORIGIN_PATHS (optional): comma-separated path prefixes that require Origin
 *                       (default: "/birthchart")
 *
 * Notes:
 * - This middleware intentionally does early checks for Origin/Referer and returns 403/401 when invalid.
 * - When allowed, it delegates to `cors()` to emit proper CORS response headers (incl. Vary: Origin).
 * - Webhooks and /health are bypassed completely (no CORS headers needed).
 */

// -------------- Helpers to parse/normalize configuration --------------

const ALLOWED_ORIGINS = parseOrigins(process.env.ALLOWED_ORIGINS || '');
const ALLOWED_REFERERS = parseReferers(process.env.ALLOWED_REFERERS || '');
const STRICT_PATHS = (process.env.STRICT_ORIGIN_PATHS || '/birthchart')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function parseOrigins(list) {
  return new Set(
    list
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(normalizeOrigin)
      .filter(Boolean)
  );
}

function parseReferers(list) {
  return (list || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(normalizeAsPrefix);
}

/** Normalize a value to URL.origin (scheme + host + port). Returns null if invalid. */
function normalizeOrigin(value) {
  try {
    const u = new URL(value);
    return u.origin;
  } catch {
    // Try adding https:// if only host was provided
    try {
      const u2 = new URL(`https://${value}`);
      return u2.origin;
    } catch {
      return null;
    }
  }
}

/** Normalize a value as a prefix string used for startsWith() checks on the Referer. */
function normalizeAsPrefix(value) {
  // If it's a valid URL, keep as full href; otherwise try https:// + value
  try {
    const u = new URL(value);
    return u.href; // keep trailing slash/prefix if provided
  } catch {
    try {
      const u2 = new URL(`https://${value}`);
      return u2.href;
    } catch {
      return value; // best-effort (consumer must provide proper URLs)
    }
  }
}

/** Returns true if the request path starts with any of the given prefixes. */
function pathStartsWithAny(reqPath, prefixes) {
  return prefixes.some(p => reqPath.startsWith(p));
}

/** Identify endpoints where we must not enforce browser CORS (server-to-server). */
function isBypassedPath(req) {
  const p = req.path || '';
  // Webhooks and health checks are typically server-to-server (no Origin)
  if (p.startsWith('/webhook/')) return true;
  if (p === '/health') return true;
  return false;
}

// -------------- Core policy checks --------------

/** Validate Origin against the allowlist. Returns normalized origin or null. */
function validateOrigin(origin) {
  if (!origin) return null;
  let o = null;
  try {
    o = new URL(origin).origin;
  } catch {
    return null;
  }
  return ALLOWED_ORIGINS.has(o) ? o : null;
}

/** Validate Referer using either origin allowlist or explicit allowed prefixes. */
function validateReferer(referer, normalizedOriginIfAny) {
  if (!referer) return true; // absence of Referer is acceptable except where policy requires otherwise
  try {
    const refUrl = new URL(referer);
    const refOrigin = refUrl.origin;
    // Accept if Referer shares an allowed origin OR matches any explicit allowed prefix
    if (ALLOWED_ORIGINS.has(refOrigin)) return true;
    if (ALLOWED_REFERERS.some(prefix => referer.startsWith(prefix))) return true;
    // Optional: if Origin is present and differs from Referer origin, reject (tight coupling)
    if (normalizedOriginIfAny && normalizedOriginIfAny !== refOrigin) return false;
    return false;
  } catch {
    return false;
  }
}

// -------------- CORS application --------------

/**
 * Build a per-request CORS handler. We reflect the Origin only when allowed; otherwise block.
 * For requests without Origin (e.g., curl/server-to-server), we skip setting ACAO.
 */
function applyCorsHeaders(req, res, next, normalizedOrigin) {
  const opts = {
    origin: function (origin, callback) {
      // Reflect only allowed origins; otherwise signal not allowed
      if (normalizedOrigin && origin === normalizedOrigin) {
        return callback(null, true);
      }
      // If no origin provided (non-browser), do not set ACAO
      if (!origin) return callback(null, false);
      // Fallback: double-check dynamically (should rarely happen)
      const val = validateOrigin(origin);
      return callback(null, !!val);
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-Request-Id',
    ],
    credentials: false,          // APIs generally shouldn't reflect credentials unless strictly needed
    optionsSuccessStatus: 204,   // For legacy browsers
    maxAge: 600,                 // Cache preflight for 10 minutes
  };

  return cors(opts)(req, res, next);
}

// -------------- Exported middleware --------------

module.exports = function corsPolicy(req, res, next) {
  // Bypass CORS entirely for server-to-server paths (webhooks/health)
  if (isBypassedPath(req)) return next();

  const originHdr = req.headers.origin || '';
  const refererHdr = req.headers.referer || req.headers.referrer || '';

  // Strict paths require an Origin (browser context)
  const isStrict = pathStartsWithAny(req.path || '', STRICT_PATHS);

  // 1) Enforce presence of Origin on strict public endpoints
  if (isStrict && !originHdr) {
    return res.status(401).json({ message: 'Origin required for this endpoint' });
  }

  // 2) If Origin is present, it must be allowed
  const normalizedOrigin = originHdr ? validateOrigin(originHdr) : null;
  if (originHdr && !normalizedOrigin) {
    return res.status(403).json({ message: 'CORS blocked: origin not allowed' });
  }

  // 3) If Referer exists, validate it (origin or explicit prefixes)
  if (refererHdr && !validateReferer(refererHdr, normalizedOrigin)) {
    return res.status(403).json({ message: 'CORS blocked: referer not allowed' });
  }

  // 4) Delegate to CORS to emit headers (will reflect only if origin is allowed)
  return applyCorsHeaders(req, res, next, normalizedOrigin);
};
