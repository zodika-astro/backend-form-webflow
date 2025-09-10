// middlewares/recaptcha.js
'use strict';

/**
 * reCAPTCHA verification middleware
 * ---------------------------------
 * Validates client tokens against Google reCAPTCHA.
 * - Supports v3 "classic" (default) and Enterprise (compat) via RECAPTCHA_MODE.
 * - Enforces a minimum score (v3), optional expected action, and optional hostname.
 * - Attaches verification details to req.recaptcha on success.
 *
 * Requirements:
 * - Node.js 18+ (global fetch, AbortController available).
 * - Express behind a correctly configured proxy (set "app.set('trust proxy', <hops>)")
 *   if you want accurate client IP forwarded to Google.
 *
 * Environment variables:
 *  - RECAPTCHA_MODE          : 'classic' (default) | 'enterprise'
 *  - RECAPTCHA_SECRET        : required; must match the key type used by the frontend
 *  - RECAPTCHA_MIN_SCORE     : optional; minimum score threshold (default: 0.5)
 *  - RECAPTCHA_EXPECT_ACTION : optional; enforce a specific action (e.g., 'birthchart_submit')
 *  - RECAPTCHA_EXPECT_HOST   : optional; enforce the hostname returned by Google
 *  - RECAPTCHA_BYPASS        : 'true' to bypass verification (DEV only)
 *
 * Example:
 *   router.post('/birthchart/birthchartsubmit-form', recaptchaVerify(), controller.processForm);
 */

const MODE = (process.env.RECAPTCHA_MODE || 'classic').toLowerCase(); // 'classic' | 'enterprise'
const DEFAULT_MIN_SCORE = Number.isFinite(Number(process.env.RECAPTCHA_MIN_SCORE))
  ? Number(process.env.RECAPTCHA_MIN_SCORE)
  : 0.5;

// Google siteverify endpoints (classic / enterprise compatibility)
const VERIFY_URLS = Object.freeze({
  classic: 'https://www.google.com/recaptcha/api/siteverify',
  enterprise: 'https://www.google.com/recaptcha/enterprise/siteverify',
});
const VERIFY_URL = VERIFY_URLS[MODE] || VERIFY_URLS.classic;

/**
 * Mirrors a request identifier in the response (useful for tracing across systems).
 * @returns {string|undefined} The request id echoed, if any.
 */
function echoRequestId(req, res) {
  const rid = req.requestId || req.get?.('x-request-id') || req.get?.('x-correlation-id');
  if (rid) res.set('X-Request-Id', String(rid));
  return rid;
}

/**
 * Extracts the reCAPTCHA token from common body keys (frontend-compatible).
 * @param {Record<string, any>} [body]
 * @returns {string|null}
 */
function pickCaptchaToken(body = {}) {
  const candidate =
    body.recaptcha_token ??
    body.recaptchaToken ??
    body['g-recaptcha-response'] ??
    body.captcha ??
    null;

  if (candidate == null) return null;
  const token = String(candidate).trim();
  return token.length ? token : null;
}

/**
 * Extracts the expected action provided by the client (if any).
 * @param {Record<string, any>} [reqBody]
 * @returns {string|undefined}
 */
function pickExpectedAction(reqBody = {}) {
  return reqBody.recaptcha_action || reqBody.action || undefined;
}

/**
 * Attempts to resolve the client IP in a proxy-aware manner.
 * Note: ensure Express trust proxy is set to get the correct client IP.
 * @returns {string|undefined}
 */
function getClientIp(req) {
  return (
    req.ip ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.connection?.remoteAddress ||
    undefined
  );
}

/**
 * Calls Google's siteverify endpoint with the provided token and secret.
 * @returns {Promise<{ ok: boolean, data: any, status: number }>}
 */
async function verifyWithGoogle({ secret, response, remoteip, timeoutMs = 6000 }) {
  const params = new URLSearchParams();
  params.append('secret', String(secret));
  params.append('response', String(response));
  if (remoteip) params.append('remoteip', String(remoteip));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(timeoutMs));

  try {
    const resp = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
      signal: ctrl.signal,
    });

    let data = {};
    try {
      data = await resp.json();
    } catch {
      // Keep empty data on JSON parse errors; caller will handle.
    }

    return { ok: resp.ok, data, status: resp.status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalizes Google's response into a single shape:
 * {
 *   success: boolean,
 *   score?: number,
 *   action?: string,
 *   hostname?: string,
 *   challenge_ts?: string,
 *   error_codes?: string[]
 * }
 */
function normalizeGoogleResponse(raw) {
  if (!raw || typeof raw !== 'object') return { success: false };

  // Enterprise (compat siteverify) response fields
  if (MODE === 'enterprise' && raw.tokenProperties) {
    const { valid, action, hostname, createTime } = raw.tokenProperties;
    const score = raw.riskAnalysis?.score;
    return {
      success: !!valid,
      score: Number.isFinite(Number(score)) ? Number(score) : undefined,
      action,
      hostname,
      challenge_ts: createTime,
      error_codes: Array.isArray(raw['error-codes']) ? raw['error-codes'] : undefined,
    };
  }

  // Classic v3 response
  return {
    success: !!raw.success,
    score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : undefined,
    action: raw.action,
    hostname: raw.hostname,
    challenge_ts: raw.challenge_ts,
    error_codes: Array.isArray(raw['error-codes']) ? raw['error-codes'] : undefined,
  };
}

/**
 * Factory that returns the Express middleware which validates reCAPTCHA.
 * - Validates presence of secret and token.
 * - Verifies token with Google.
 * - Enforces minimum score, action, and hostname (if configured).
 * - Attaches verification info to req.recaptcha on success.
 */
function recaptchaVerify({ minScore = DEFAULT_MIN_SCORE, timeoutMs = 6000 } = {}) {
  return async function recaptchaVerifyMiddleware(req, res, next) {
    const rid = echoRequestId(req, res);

    // Explicit opt-out for local development only
    if (String(process.env.RECAPTCHA_BYPASS).toLowerCase() === 'true') {
      req.recaptcha = { success: true, bypass: true };
      return next();
    }

    const secret = process.env.RECAPTCHA_SECRET;
    if (!secret) {
      return res.status(500).json({
        error: 'recaptcha_misconfigured',
        message: 'Server reCAPTCHA secret not configured',
        request_id: rid,
      });
    }

    const token = pickCaptchaToken(req.body || {});
    if (!token) {
      return res.status(400).json({
        error: 'recaptcha_missing',
        message: 'reCAPTCHA token is missing',
        request_id: rid,
      });
    }

    const expectedActionFromBody = pickExpectedAction(req.body || {});
    const expectedActionFromEnv = process.env.RECAPTCHA_EXPECT_ACTION;
    const expectedAction = expectedActionFromBody || expectedActionFromEnv || undefined;

    try {
      const remoteip = getClientIp(req);
      const { ok, data } = await verifyWithGoogle({
        secret,
        response: token,
        remoteip,
        timeoutMs,
      });

      // Use 4xx to preserve CORS behavior across proxies/load balancers
      if (!ok) {
        return res.status(400).json({
          error: 'recaptcha_unavailable',
          message: 'reCAPTCHA verification unavailable, please try again',
          request_id: rid,
        });
      }

      const norm = normalizeGoogleResponse(data);

      if (!norm.success) {
        return res.status(400).json({
          error: 'recaptcha_failed',
          message: 'reCAPTCHA verification failed',
          details: norm.error_codes ? { codes: norm.error_codes } : undefined,
          request_id: rid,
        });
      }

      if (Number.isFinite(norm.score) && norm.score < Number(minScore)) {
        return res.status(400).json({
          error: 'recaptcha_low_score',
          message: 'reCAPTCHA score too low',
          details: { score: norm.score },
          request_id: rid,
        });
      }

      if (expectedAction && norm.action && String(norm.action) !== String(expectedAction)) {
        return res.status(400).json({
          error: 'recaptcha_action_mismatch',
          message: 'reCAPTCHA action mismatch',
          details: { expected: String(expectedAction), got: String(norm.action) },
          request_id: rid,
        });
      }

      const expectHost = process.env.RECAPTCHA_EXPECT_HOST;
      if (expectHost && norm.hostname && String(norm.hostname) !== String(expectHost)) {
        return res.status(400).json({
          error: 'recaptcha_hostname_mismatch',
          message: 'reCAPTCHA hostname mismatch',
          details: { expected: String(expectHost), got: String(norm.hostname) },
          request_id: rid,
        });
      }

      // Attach verification details for downstream handlers (for logging/auditing)
      req.recaptcha = {
        success: true,
        mode: MODE,
        score: norm.score,
        action: norm.action,
        timestamp: norm.challenge_ts,
        hostname: norm.hostname,
        remoteip,
      };

      return next();
    } catch (err) {
      // Return 4xx to avoid downstream proxies stripping CORS on 5xx
      const isAbort = err?.name === 'AbortError';
      return res.status(400).json({
        error: isAbort ? 'recaptcha_timeout' : 'recaptcha_error',
        message: isAbort ? 'reCAPTCHA verification timed out' : 'reCAPTCHA verification error',
        request_id: rid,
      });
    }
  };
}

module.exports = recaptchaVerify;
