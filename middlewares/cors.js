// middlewares/cors.js
'use strict';

const cors = require('cors');

/**
 * Production-grade CORS + Origin/Referer enforcement
 * --------------------------------------------------
 * Goals
 * - Allow only trusted Origins for browser requests.
 * - For *public* endpoints (e.g., /birthchart/**), REQUIRE an Origin header (block non-browser).
 * - Validate Referer against an allowlist (defense-in-depth against CSRF-like abuse).
 * - Do NOT interfere with server-to-server endpoints (webhooks), health checks, metrics, or static assets.
 *
 * Environment
 * - ALLOWED_ORIGINS:   comma-separated list of allowed origins
 *                      e.g., "https://www.zodika.com.br,https://zodika.webflow.io"
 * - ALLOWED_REFERERS:  comma-separated list of allowed Referer prefixes or full origins
 *                      e.g., "https://www.zodika.com.br/articles/,https://zodika.webflow.io/"
 * - STRICT_ORIGIN_PATHS (optional): comma-separated path prefixes that REQUIRE an Origin
 *                      default: "/birthchart"
 *
 * Notes
 * - This middleware performs early allow/deny and then delegates to `cors()` for response headers.
 * - Webhooks, health, metrics, and static assets are bypassed entirely (no CORS headers needed).
 * - Designed to scale: to protect additional public forms, just append their prefixes to STRICT_ORIGIN_PATHS.
 */

// ------------------------- Parse / normalize configuration -------------------------

const ALLOWED_ORIGINS = parseOrigins(process.env.ALLOWED_ORIGINS || '');
const ALLOWED_REFERERS = parseReferers(process.env.ALLOWED_REFERERS || '');
const STRICT_PATHS = (process.env.STRICT_ORIGIN_PATHS || '/birthchart')
  .split(',')
  .map((s) => normalizePathPrefix(s))
  .filter(Boolean);

/** Normalize a path prefix (ensure it starts with '/', trim whitespace). */
function normalizePathPrefix(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (!t) return '';
  return t.startsWith('/') ? t : `/${t}`;
}

/** Parse a comma-separated list of origins into a Set of normalized origins. */
function parseOrigins(list) {
  return new Set(
    list
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizeOrigin)
      .filter(Boolean)
  );
}

/** Parse a comma-separated list of referer prefixes into an array of normalized href prefixes. */
function parseReferers(list) {
  return (list || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeAsPrefix);
}

/** Normalize a value to URL.origin (scheme + host + port). Returns null if invalid. */
function normalizeOrigin(value) {
  try {
    const u = new URL(value);
    return u.origin;
  } catch {
    // Best-effort: allow host-only inputs (assume https)
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
  try {
    const u = new URL(value);
    return u.href; // keep trailing slash/prefix if provided
  } catch {
    try {
      const u2 = new URL(`https://${value}`);
      return u2.href;
    } catch {
      // Last resort: return raw value (consumer should provide proper URLs)
      return value;
    }
  }
}

/** Return the path without query string, preferring originalUrl (more accurate under routers). */
function getRequestPath(req) {
  const raw = (req.originalUrl || req.path || '').split('?')[0];
  return raw || '/';
}

/** Returns true if the request path starts with any of the given prefixes. */
function pathStartsWithAny(reqPath, prefixes) {
  return prefixes.some((p) => reqPath.startsWith(p));
}

/** Identify endpoints where we must not enforce browser CORS (server-to-server, health, metrics, static). */
function isBypassedPath(req) {
  const p = getRequestPath(req);
  if (p.startsWith('/webhook/')) return true;     // provider callbacks (no browsers)
  if (p === '/health' || p.startsWith('/healthz')) return true;
  if (p.startsWith('/metrics')) return true;      // Prometheus metrics
  if (p.startsWith('/assets')) return true;       // static assets
  if (p === '/favicon.ico') return true;
  return false;
}

// ------------------------------ Core policy validators ------------------------------

/** Validate Origin against the allowlist. Returns normalized origin or null. */
function validateOrigin(origin) {
  if (!origin) return null;
  try {
    const normalized = new URL(origin).origin;
    return ALLOWED_ORIGINS.has(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Validate Referer using either origin allowlist or explicit allowed prefixes.
 * Behavior:
 * - If no Referer header: return true (absence is acceptable unless your policy says otherwise).
 * - If present: allow when (a) its origin is in ALLOWED_ORIGINS OR (b) it starts with any allowed prefix.
 * - If an Origin header is present and mismatches the Referer origin: reject (tight coupling).
 */
function validateReferer(referer, normalizedOriginIfAny) {
  if (!referer) return true;
  try {
    const refUrl = new URL(referer);
    const refOrigin = refUrl.origin;

    if (ALLOWED_ORIGINS.has(refOrigin)) return true;
    if (ALLOWED_REFERERS.some((prefix) => referer.startsWith(prefix))) return true;

    if (normalizedOriginIfAny && normalizedOriginIfAny !== refOrigin) return false;
    return false;
  } catch {
    return false;
  }
}

// ------------------------------ CORS application layer ------------------------------

/**
 * Build a per-request CORS handler. We reflect the Origin only when allowed; otherwise do not set ACAO.
 * For requests without Origin (e.g., curl/server-to-server), we skip ACAO entirely.
 */
function applyCorsHeaders(req, res, next, normalizedOrigin) {
  const opts = {
    origin(origin, callback) {
      // Reflect only allowed origins; otherwise signal not allowed
      if (normalizedOrigin && origin === normalizedOrigin) {
        return callback(null, true);
      }
      // If no origin provided (non-browser), do not set ACAO
      if (!origin) return callback(null, false);
      // Fallback validation (should rarely be needed)
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
    credentials: false,          // Typically false for pure APIs; enable only if you truly need cookies/auth
    optionsSuccessStatus: 204,   // For legacy browsers
    maxAge: 600,                 // Cache preflight for 10 minutes
  };

  return cors(opts)(req, res, next);
}

// --------------------------------- Exported middleware ---------------------------------

module.exports = function corsPolicy(req, res, next) {
  // Bypass CORS entirely for server-to-server, health, metrics, and static paths
  if (isBypassedPath(req)) return next();

  const path = getRequestPath(req);
  const originHdr = req.headers.origin || '';
  const refererHdr = req.headers.referer || req.headers.referrer || '';

  // Apply "strict" policy only to configured public path prefixes (scales with more products/forms)
  const isStrict = pathStartsWithAny(path, STRICT_PATHS);

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
