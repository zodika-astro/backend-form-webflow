'use strict';

/**
 * reCAPTCHA Enterprise (compat) verification middleware
 * -----------------------------------------------------
 * What it does
 * - Extracts the captcha token from common client keys.
 * - Calls Google's Enterprise siteverify endpoint with RECAPTCHA_SECRET.
 * - Enforces a minimum score (configurable via RECAPTCHA_MIN_SCORE).
 * - Optionally enforces the expected "action" when the client provides one.
 *
 * Why this exists
 * - Without an explicit timeout, the backend may hang on the external call,
 *   causing the browser to abort at ~20s and Railway to log HTTP 499.
 *
 * Environment
 * - RECAPTCHA_SECRET      → MUST be the Secret Key of the SAME Enterprise key used on the frontend.
 * - RECAPTCHA_MIN_SCORE   → optional (default: 0.5)
 *
 * Usage (router)
 *   router.post('/birthchartsubmit-form', recaptchaVerify(), controller.processForm)
 */

const DEFAULT_MIN_SCORE = Number.isFinite(Number(process.env.RECAPTCHA_MIN_SCORE))
  ? Number(process.env.RECAPTCHA_MIN_SCORE)
  : 0.5;

// Enterprise "compat" verification endpoint
const VERIFY_URL = 'https://www.google.com/recaptcha/enterprise/siteverify';

/** Small helper to echo a single, stable request id back to the client. */
function echoRequestId(req, res) {
  const rid =
    req.requestId ||
    req.get?.('x-request-id') ||
    req.get?.('x-correlation-id');
  if (rid) res.set('X-Request-Id', String(rid));
  return rid;
}

/** Consolidate captcha token from multiple common client-side keys. */
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

/** Resolve client IP (honors Express trust proxy). */
function getClientIp(req) {
  return (
    req.ip ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.connection?.remoteAddress ||
    undefined
  );
}

/**
 * Perform the verification against Google's siteverify with an explicit timeout.
 * Uses the global fetch (Node 18+). We do NOT use the internal httpClient to
 * avoid host allowlisting friction.
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
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
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
    // keep empty object on parse failure
  }
  return { ok: resp.ok, data, status: resp.status };
}

/**
 * Factory: returns the middleware.
 * Options:
 * - minScore: minimum acceptable v3/Enterprise compat score (default 0.5).
 * - timeoutMs: hard timeout for the verification call (default 6000ms).
 */
function recaptchaVerify({ minScore = DEFAULT_MIN_SCORE, timeoutMs = 6000 } = {}) {
  return async function recaptchaVerifyMiddleware(req, res, next) {
    const rid = echoRequestId(req, res);

    // Fail-closed when not configured in production.
    const secret = process.env.RECAPTCHA_SECRET;
    if (!secret) {
      return res.status(500).json({
        error: 'recaptcha_misconfigured',
        message: 'Server reCAPTCHA secret not configured',
        request_id: rid,
      });
    }

    // Token presence check (most common 400).
    const token = pickCaptchaToken(req.body || {});
    if (!token) {
      return res.status(400).json({
        error: 'recaptcha_missing',
        message: 'reCAPTCHA token is missing',
        request_id: rid,
      });
    }

    // Remote verification with tight timeout to avoid 499 on the client.
    try {
      const remoteip = getClientIp(req);
      const { ok, data, status } = await verifyWithGoogle({
        secret,
        response: token,
        remoteip,
        timeoutMs,
      });

      // Network/HTTP-level failure to reach Google
      if (!ok) {
        // 504: verification timed out or gateway-ish failure; 502 for other non-2xx statuses
        const code = status === 408 || status === 504 ? 504 : 502;
        return res.status(code).json({
          error: 'recaptcha_unreachable',
          message: 'reCAPTCHA verification unavailable',
          request_id: rid,
        });
      }

      // Protocol-level failure (success: false)
      if (!data || data.success !== true) {
        return res.status(400).json({
          error: 'recaptcha_failed',
          message: 'reCAPTCHA verification failed',
          details: Array.isArray(data?.['error-codes']) ? { codes: data['error-codes'] } : undefined,
          request_id: rid,
        });
      }

      // Score gating (Enterprise compat returns score similarly to v3)
      const score = Number(data.score);
      if (Number.isFinite(score) && score < Number(minScore)) {
        return res.status(400).json({
          error: 'recaptcha_low_score',
          message: 'reCAPTCHA score too low',
          details: { score },
          request_id: rid,
        });
      }

      // Optional action validation: if client sent an expected action, enforce exact match.
      const expectedAction =
        (req.body && (req.body.recaptcha_action || req.body.action)) || undefined;
      if (expectedAction && data.action && String(data.action) !== String(expectedAction)) {
        return res.status(400).json({
          error: 'recaptcha_action_mismatch',
          message: 'reCAPTCHA action mismatch',
          details: { expected: String(expectedAction), got: String(data.action) },
          request_id: rid,
        });
      }

      // Attach a compact verification context (PII-free) for downstream handlers.
      req.recaptcha = {
        success: true,
        score: Number.isFinite(score) ? score : undefined,
        action: data.action || undefined,
        timestamp: data.challenge_ts || undefined,
        hostname: data.hostname || undefined,
      };

      return next();
    } catch (err) {
      // Aborted == timed out locally; treat as 504 to make it visible in logs.
      const isAbort = err?.name === 'AbortError';
      return res.status(isAbort ? 504 : 400).json({
        error: isAbort ? 'recaptcha_timeout' : 'recaptcha_error',
        message: isAbort ? 'reCAPTCHA verification timed out' : 'reCAPTCHA verification error',
        request_id: rid,
      });
    }
  };
}

module.exports = recaptchaVerify;
