// middlewares/cors.js
'use strict';

const cors = require('cors');

/**
 * Production-grade CORS + Origin/Referer enforcement
 * --------------------------------------------------
 * Goals
 * - Allow only trusted Origins for browser requests.
 * - For *public* endpoints (e.g., /birthchart/**), REQUIRE an Origin header (block non-browser).
 * - Validate Referer against an allowlist (defense-in-depth).
 * - Do NOT interfere with server-to-server endpoints (webhooks), health checks, metrics, or static assets.
 *
 * Env
 * - ALLOWED_ORIGINS:   CSV of allowed origins or host wildcards
 *                      e.g. "https://www.zodika.com.br,https://zodika.webflow.io,*.zodika.com.br"
 * - ALLOWED_REFERERS:  CSV of allowed Referer prefixes or full URLs
 *                      e.g. "https://www.zodika.com.br/articles/,https://zodika.webflow.io/"
 * - STRICT_ORIGIN_PATHS (optional): CSV of path prefixes that REQUIRE an Origin (default "/birthchart")
 *
 * Notes
 * - This middleware performs early allow/deny and then delegates to `cors()` for headers.
 * - Webhooks/health/metrics/static assets are bypassed entirely (no CORS headers needed).
 * - Wildcards are host-only: "*.example.com" allows foo.example.com, bar.example.com, not example.com itself.
 */

// ------------------------- Parse / normalize configuration -------------------------

const NODE_ENV = (process.env.NODE_ENV || 'production').toLowerCase();
const IS_PROD = NODE_ENV === 'production';


const {
  exactOrigins: EXACT_ORIGINS,
  wildcardHosts: WILDCARD_HOSTS,
} = parseOrigins(process.env.ALLOWED_ORIGINS || '');

const ALLOWED_REFERERS = parseReferers(process.env.ALLOWED_REFERERS || '');

const STRICT_PATHS = (process.env.STRICT_ORIGIN_PATHS || '/birthchart')
  .split(',')
  .map((s) => normalizePathPrefix(s))
  .filter(Boolean);

// Sensible dev defaults if no allowlist provided
if (!IS_PROD && EXACT_ORIGINS.size === 0 && WILDCARD_HOSTS.length === 0) {
  [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
  ].forEach((o) => EXACT_ORIGINS.add(o));
}

/** Normalize a path prefix (ensure it starts with '/', trim whitespace). */
function normalizePathPrefix(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (!t) return '';
  return t.startsWith('/') ? t : `/${t}`;
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

// ------------------------------ Origin / Referer parsing ------------------------------

/**
 * Parse a CSV of origins into:
 *  - exactOrigins: Set of normalized origins (scheme+host+port)
 *  - wildcardHosts: array of host suffixes for patterns like "*.example.com"
 */
function parseOrigins(list) {
  const exactOrigins = new Set();
  const wildcardHosts = [];

  for (const raw of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith('*.') || raw.includes('://*.')) {
      // "*.domain.com" or "https://*.domain.com"
      const host = normalizeWildcardHost(raw);
      if (host) wildcardHosts.push(host); // store ".domain.com"
      continue;
    }
    const origin = normalizeOrigin(raw);
    if (origin) exactOrigins.add(origin);
  }
  return { exactOrigins, wildcardHosts };
}

/** Normalize a value to URL.origin (scheme+host+port). Returns null if invalid. */
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

/** Extract wildcard host suffix from patterns like "*.example.com" or "https://*.example.com" -> ".example.com" */
function normalizeWildcardHost(value) {
  try {
    // Strip scheme if present
    const v = String(value).replace(/^[a-z]+:\/\//i, '');
    const host = v.replace(/^\*\./, ''); // remove "*."
    if (!host || host.startsWith('*')) return null;
    return `.${host.toLowerCase()}`; // store with leading dot for endsWith checks
  } catch {
    return null;
  }
}

/** Parse a CSV of referer prefixes into normalized href prefixes. */
function parseReferers(list) {
  return (list || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeAsPrefix);
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

// ------------------------------ Core policy validators ------------------------------

/**
 * Validate Origin against allowlist.
 *  - Exact match against normalized origin
 *  - Host wildcard match (*.example.com) against the request hostname
 * Returns the normalized origin (to reflect) or null if not allowed.
 */
function validateOrigin(origin) {
  if (!origin) return null;

  let normalized;
  try {
    const u = new URL(origin);
    normalized = u.origin;

    if (EXACT_ORIGINS.has(normalized)) return normalized;

    const host = u.hostname.toLowerCase();
    for (const suffix of WILDCARD_HOSTS) {
      // Require a subdomain: "foo.example.com" endsWith ".example.com" but "example.com" does not
      if (host.endsWith(suffix) && host.length > suffix.length) {
        return normalized;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validate Referer using either origin allowlist or explicit allowed prefixes.
 * Behavior:
 * - If no Referer header: return true (absence is acceptable).
 * - If present: allow when (a) its origin is in ALLOWED_ORIGINS OR (b) it startsWith any allowed prefix.
 * - If an Origin header is present and mismatches the Referer origin: reject (tight coupling).
 */
function validateReferer(referer, normalizedOriginIfAny) {
  if (!referer) return true;
  try {
    const refUrl = new URL(referer);
    const refOrigin = refUrl.origin;

    if (EXACT_ORIGINS.has(refOrigin)) return true;
    if (WILDCARD_HOSTS.length) {
      const host = refUrl.hostname.toLowerCase();
      if (WILDCARD_HOSTS.some((sfx) => host.endsWith(sfx) && host.length > sfx.length)) return true;
    }
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
      if (!origin) return callback(null, false); // non-browser: no ACAO
      const val = validateOrigin(origin);
      return callback(null, !!val);
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Accept',
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-Request-Id',
    ],
    credentials: false,          // Keep false unless you truly need cookies/auth
    optionsSuccessStatus: 204,   // Legacy compatibility
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

  // Apply "strict" policy only to configured public path prefixes
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
