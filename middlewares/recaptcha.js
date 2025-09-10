'use strict';

// Add a temporary logger to help debug the environment.
const debugLogger = require('console');

/**
 * reCAPTCHA Enterprise (compat) verification middleware
 * -----------------------------------------------------
 * What it does
 * - Extracts the captcha token from common client keys.
 * - Calls Google's Enterprise siteverify endpoint with RECAPTCHA_SECRET.
 * - Enforces a minimum score (configurable via RECAPTCHA_MIN_SCORE).
 * - Optionally enforces the expected "action" when the client provides one.
 *
 * Environment
 * - RECAPTCHA_SECRET      → MUST be the Secret Key of the SAME Enterprise key used on the frontend.
 * - RECAPTCHA_MIN_SCORE   → optional (default: 0.5)
 *
 * Usage
 * router.post('/birthchartsubmit-form', recaptchaVerify(), controller.processForm)
 */

const DEFAULT_MIN_SCORE = Number.isFinite(Number(process.env.RECAPTCHA_MIN_SCORE))
  ? Number(process.env.RECAPTCHA_MIN_SCORE)
  : 0.5;

// Enterprise "compat" verification endpoint
const VERIFY_URL = 'https://www.google.com/recaptcha/enterprise/siteverify';

function echoRequestId(req, res) {
  const rid = req.requestId || req.get?.('x-request-id') || req.get?.('x-correlation-id');
  if (rid) res.set('X-Request-Id', String(rid));
  return rid;
}

function pickCaptchaToken(body = {}) {
  const c =
    body.recaptcha_token ??
    body.recaptchaToken ??
    body.captcha_token ??
    body.captchaToken ??
    body['g-recaptcha-response'] ??
    body.g_recaptcha_response ??
    body.captcha ??
    null;

  if (c == null) return null;
  const s = String(c).trim();
  return s.length ? s : null;
}

function getClientIp(req) {
  return req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.connection?.remoteAddress || undefined;
}

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
  try { data = await resp.json(); } catch { /* keep empty */ }
  return { ok: resp.ok, data, status: resp.status };
}

function recaptchaVerify({ minScore = DEFAULT_MIN_SCORE, timeoutMs = 6000 } = {}) {
  return async function recaptchaVerifyMiddleware(req, res, next) {
    const rid = echoRequestId(req, res);
    
    // START DEBUGGING LOGS
    debugLogger.log('--- RECAPTCHA DEBUG: Starting verification process ---');
    debugLogger.log(`RECAPTCHA_SECRET (read from env): ${process.env.RECAPTCHA_SECRET ? 'SET' : 'NOT SET'}`);
    debugLogger.log(`RECAPTCHA_MIN_SCORE (read from env): ${process.env.RECAPTCHA_MIN_SCORE}`);
    
    const secret = process.env.RECAPTCHA_SECRET;
    if (!secret) {
      debugLogger.log('RECAPTCHA DEBUG: Secret is NOT set. Returning 500.');
      return res.status(500).json({
        error: 'recaptcha_misconfigured',
        message: 'Server reCAPTCHA secret not configured',
        request_id: rid,
      });
    }

    const token = pickCaptchaToken(req.body || {});
    debugLogger.log(`RECAPTCHA DEBUG: Token received? ${!!token}`);
    
    if (!token) {
      debugLogger.log('RECAPTCHA DEBUG: Token is missing. Returning 400.');
      return res.status(400).json({
        error: 'recaptcha_missing',
        message: 'reCAPTCHA token is missing',
        request_id: rid,
      });
    }

    try {
      debugLogger.log(`RECAPTCHA DEBUG: Attempting to verify token with Google...`);
      const remoteip = getClientIp(req);
      const { ok, data, status } = await verifyWithGoogle({
        secret, response: token, remoteip, timeoutMs,
      });
      debugLogger.log(`RECAPTCHA DEBUG: Google API call complete. Status: ${status}, OK: ${ok}`);
      debugLogger.log('RECAPTCHA DEBUG: Google API response data:', data);

      if (!ok) {
        debugLogger.log('RECAPTCHA DEBUG: Response from Google was not OK. Returning 400.');
        return res.status(400).json({
          error: 'recaptcha_unavailable',
          message: 'reCAPTCHA verification unavailable, please try again',
          request_id: rid,
        });
      }

      if (!data || data.success !== true) {
        debugLogger.log('RECAPTCHA DEBUG: Verification failed. Data success is not true.');
        debugLogger.log('RECAPTCHA DEBUG: Error codes:', data?.['error-codes']);
        return res.status(400).json({
          error: 'recaptcha_failed',
          message: 'reCAPTCHA verification failed',
          details: Array.isArray(data?.['error-codes']) ? { codes: data['error-codes'] } : undefined,
          request_id: rid,
        });
      }

      const score = Number(data.score);
      if (Number.isFinite(score) && score < Number(minScore)) {
        debugLogger.log(`RECAPTCHA DEBUG: Low score. Score: ${score}, Min Score: ${minScore}.`);
        return res.status(400).json({
          error: 'recaptcha_low_score',
          message: 'reCAPTCHA score too low',
          details: { score },
          request_id: rid,
        });
      }

      const expectedAction =
        (req.body && (req.body.recaptcha_action || req.body.action)) || undefined;
      if (expectedAction && data.action && String(data.action) !== String(expectedAction)) {
        debugLogger.log(`RECAPTCHA DEBUG: Action mismatch. Expected: ${expectedAction}, Got: ${data.action}.`);
        return res.status(400).json({
          error: 'recaptcha_action_mismatch',
          message: 'reCAPTCHA action mismatch',
          details: { expected: String(expectedAction), got: String(data.action) },
          request_id: rid,
        });
      }

      debugLogger.log(`RECAPTCHA DEBUG: Verification SUCCESSFUL! Score: ${score}`);
      req.recaptcha = {
        success: true,
        score: Number.isFinite(score) ? score : undefined,
        action: data.action || undefined,
        timestamp: data.challenge_ts || undefined,
        hostname: data.hostname || undefined,
      };

      return next();
    } catch (err) {
      const isAbort = err?.name === 'AbortError';
      debugLogger.error(`RECAPTCHA DEBUG: Caught error: ${err.message}, isAbort: ${isAbort}`);
      
      // Return 400 to avoid proxies stripping CORS headers on 5xx.
      return res.status(400).json({
        error: isAbort ? 'recaptcha_timeout' : 'recaptcha_error',
        message: isAbort ? 'reCAPTCHA verification timed out' : 'reCAPTCHA verification error',
        request_id: rid,
      });
    }
    // END DEBUGGING LOGS
  };
}

module.exports = recaptchaVerify;
