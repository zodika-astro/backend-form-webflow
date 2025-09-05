// middlewares/refererAuth.js
'use strict';

/**
 * Referer/Origin gate for public form endpoints
 * ---------------------------------------------
 * Purpose:
 *  - Defense-in-depth on top of CORS for browser-originated requests.
 *  - Ensure requests to public forms originate from trusted sites.
 *
 * Behavior:
 *  - Requires an allowed `Origin` header (browser requests).
 *  - If `Referer` is present, it must be allowed AND (when Origin exists) share the same origin.
 *  - Returns generic 401/403 messages (no internal details leaked).
 *
 * Environment:
 *  - ALLOWED_ORIGINS   (CSV) exact origins and/or wildcards:
 *      e.g. "https://www.zodika.com.br,https://zodika.webflow.io,*.zodika.com.br"
 *  - ALLOWED_REFERERS  (CSV) allowed Referer prefixes or full URLs:
 *      e.g. "https://www.zodika.com.br/articles/,https://zodika.webflow.io/"
 *
 * Notes:
 *  - This middleware is intended to be mounted only on public form routes
 *    (e.g., /birthchart/birthchartsubmit-form). Do NOT mount on provider webhooks.
 *  - Keeps logic minimal and consistent with the CORS layer.
 */

const NODE_ENV = (process.env.NODE_ENV || 'production').toLowerCase();
const IS_PROD = NODE_ENV === 'production';

const {
  exactOrigins: EXACT_ORIGINS,
  wildcardHosts: WILDCARD_HOSTS,
} = parseOrigins(process.env.ALLOWED_ORIGINS || '');

const ALLOWED_REFERERS = parseReferers(process.env.ALLOWED_REFERERS || '');

// In non-prod, if no allowlist is provided, allow common localhost origins (DX-friendly defaults)
if (!IS_PROD && EXACT_ORIGINS.size === 0 && WILDCARD_HOSTS.length === 0) {
  [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
  ].forEach((o) => EXACT_ORIGINS.add(o));
}

/* ------------------------------ Middleware ------------------------------ */

module.exports = function refererAuth(req, res, next) {
  const originHdr = req.get('origin') || '';
  const refererHdr = req.get('referer') || req.get('referrer') || '';

  // 1) Require Origin (public browser endpoint)
  if (!originHdr) {
    return res.status(401).json({ message: 'Origin required for this endpoint' });
  }

  // 2) Validate Origin against allowlist
  const normalizedOrigin = validateOrigin(originHdr);
  if (!normalizedOrigin) {
    return res.status(403).json({ message: 'CORS blocked: origin not allowed' });
  }

  // 3) If Referer exists, validate it (origin or explicit prefixes) and tie it to Origin
  if (refererHdr && !validateReferer(refererHdr, normalizedOrigin)) {
    return res.status(403).json({ message: 'CORS blocked: referer not allowed' });
  }

  // Passed all checks
  return next();
};

/* ------------------------------ Helpers ------------------------------ */

function parseOrigins(list) {
  const exactOrigins = new Set();
  const wildcardHosts = [];

  for (const raw of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith('*.') || raw.includes('://*.')) {
      const host = normalizeWildcardHost(raw);
      if (host) wildcardHosts.push(host); // store as ".example.com"
      continue;
    }
    const origin = normalizeOrigin(raw);
    if (origin) exactOrigins.add(origin);
  }
  return { exactOrigins, wildcardHosts };
}

function parseReferers(list) {
  return (list || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeAsPrefix);
}

/** Normalize a value to URL.origin (scheme+host+port). Returns null if invalid. */
function normalizeOrigin(value) {
  try {
    const u = new URL(value);
    return u.origin;
  } catch {
    try {
      const u2 = new URL(`https://${value}`);
      return u2.origin;
    } catch {
      return null;
    }
  }
}

/** Extract wildcard host suffix from patterns like "*.example.com" -> ".example.com" */
function normalizeWildcardHost(value) {
  try {
    const v = String(value).replace(/^[a-z]+:\/\//i, '');
    const host = v.replace(/^\*\./, '');
    if (!host || host.startsWith('*')) return null;
    return `.${host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** Validate Origin against exact allowlist or host wildcards. */
function validateOrigin(origin) {
  try {
    const u = new URL(origin);
    const normalized = u.origin;

    if (EXACT_ORIGINS.has(normalized)) return normalized;

    const host = u.hostname.toLowerCase();
    for (const suffix of WILDCARD_HOSTS) {
      // Require a real subdomain match; example.com (no subdomain) is not allowed for "*.example.com"
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
 * Validate Referer:
 *  - Allowed when its origin is allowed, OR it starts with any allowed prefix.
 *  - If `normalizedOriginIfAny` is provided, Referer.origin must match it.
 */
function validateReferer(referer, normalizedOriginIfAny) {
  try {
    const refUrl = new URL(referer);
    const refOrigin = refUrl.origin;

    if (EXACT_ORIGINS.has(refOrigin)) {
      return !normalizedOriginIfAny || normalizedOriginIfAny === refOrigin;
    }

    if (WILDCARD_HOSTS.length) {
      const host = refUrl.hostname.toLowerCase();
      const wildcardOk = WILDCARD_HOSTS.some(
        (sfx) => host.endsWith(sfx) && host.length > sfx.length
      );
      if (wildcardOk) {
        return !normalizedOriginIfAny || normalizedOriginIfAny === refOrigin;
      }
    }

    if (ALLOWED_REFERERS.some((prefix) => referer.startsWith(prefix))) {
      // When Origin is present, still require origin match
      return !normalizedOriginIfAny || normalizedOriginIfAny === refOrigin;
    }

    return false;
  } catch {
    return false;
  }
}

/** Normalize a value as a prefix string used for startsWith() checks on the Referer. */
function normalizeAsPrefix(value) {
  try {
    const u = new URL(value);
    return u.href;
  } catch {
    try {
      const u2 = new URL(`https://${value}`);
      return u2.href;
    } catch {
      return value;
    }
  }
}
