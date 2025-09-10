'use strict';

/**
 * reCAPTCHA verification middleware
 * ---------------------------------
 * Supports reCAPTCHA v3 (classic) by default, with optional Enterprise mode.
 * It validates the token sent by the client, enforces a minimum score, and can
 * optionally verify the expected action and hostname.
 *
 * Environment variables:
 *  - RECAPTCHA_MODE          : 'classic' (default) | 'enterprise'
 *  - RECAPTCHA_SECRET        : required; must match the key type used on the frontend
 *  - RECAPTCHA_MIN_SCORE     : optional; minimum score threshold (default: 0.5)
 *  - RECAPTCHA_EXPECT_ACTION : optional; enforce a specific action (e.g., 'birthchart_submit')
 *  - RECAPTCHA_EXPECT_HOST   : optional; enforce the hostname returned by Google
 *  - RECAPTCHA_BYPASS        : 'true' to bypass verification (DEV only)
 *
 * Example usage:
 *   router.post('/birthchart/birthchartsubmit-form', recaptchaVerify(), controller.processForm);
 */

const MODE = (process.env.RECAPTCHA_MODE || 'classic').toLowerCase(); // 'classic' | 'enterprise'
const DEFAULT_MIN_SCORE = Number.isFinite(Number(process.env.RECAPTCHA_MIN_SCORE))
  ? Number(process.env.RECAPTCHA_MIN_SCORE)
  : 0.5;

const VERIFY_URLS = {
  classic: 'https://www.google.com/recaptcha/api/siteverify',
  enterprise: 'https://www.google.com/recaptcha/enterprise/siteverify',
};

const VERIFY_URL = VERIFY_URLS[MODE] || VERIFY_URLS.classic;

/**
 * Mirrors a request identifier back in the response headers if present.
 * Returns the resolved request id (or undefined).
 */
function echoRequestId(req, res) {
  const rid = req.requestId || req.get?.('x-request-id') || req.get?.('x-correlation-id');
  if (rid) res.set('X-Request-Id', String(rid));
  return rid;
}

/**
 * Extracts the reCAPTCHA token from common request body keys.
 * Prioritizes keys used by the current frontend.
 */
function pickCaptchaToken(body = {}) {
  const c =
    body.recaptcha_token ??
    body.recaptchaToken ??
    body['g-recaptcha-response'] ??
    body.captcha ??
    null;

  if (c == null) return null;
  const s = String(c).trim();
  return s.length ? s : null;
}

/**
 * Extracts the expected action, if provided by the client.
 */
function pickExpectedAction(reqBody = {}) {
  return reqBody.recaptcha_action || reqBody.action || undefined;
}

/**
 * Attempts to resolve the client IP address in a proxy-aware manner.
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
 * Returns a normalized transport result { ok, data, status }.
 */
async function verifyWithGoogle({ secret, response, remoteip, timeoutMs = 6000 }) {
  const params = new URLSearchParams();
  params.append('secret', String(secret));
  params.append('response', String(response));
  if (remoteip) params.append('remoteip', String(remoteip));

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Number(timeoutMs));

  let resp;
  try {
    resp = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }

  let data = {};
  try {
    data = await resp.json();
  } catch {
    /* swallow JSON errors and keep data empty */
  }
  return { ok: resp.ok, data, status: resp.status };
}

/**
 * Normalizes Google's response into a single shape:
 *  {
 *    success: boolean,
 *    score?: number,
 *    action?: string,
 *    hostname?: string,
 *    challenge_ts?: string,
 *    error_codes?: string[]
 *  }
 */
function normalizeGoogleResponse(raw) {
  if (!raw || typeof raw !== 'object') return { success: false };

  // Enterprise: values live under tokenProperties and riskAnalysis
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
 * - Validates presence of secret and token
 * - Verifies token with Google
 * - Enforces minimum score, action, and hostname (if configured)
 * - Attaches verification info to req.recaptcha on success
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

      // Treat network/server issues as 400 to preserve CORS behavior across proxies
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

      // Attach verification details for downstream handlers
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
