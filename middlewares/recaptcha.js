// middlewares/recaptchaVerify.js
'use strict';

/**
 * reCAPTCHA v3 verification middleware
 * ------------------------------------
 * What it does
 * - Extracts the captcha token (supports several common client keys).
 * - Calls Google's "siteverify" endpoint with RECAPTCHA_SECRET.
 * - Enforces a minimum score (configurable via RECAPTCHA_MIN_SCORE).
 * - Optionally enforces the expected "action" when provided by the client.
 *
 * Non-goals
 * - Does not log PII or full payloads.
 * - Does not block request parsing: it sends 400 with a compact error payload.
 *
 * Environment
 * - RECAPTCHA_SECRET      (required in production)
 * - RECAPTCHA_MIN_SCORE   (optional; default: 0.5)
 *
 * Usage
 * - Place BEFORE your controller on the birthchart submit route.
 *   e.g., router.post('/birthchartsubmit-form', recaptchaVerify(), controller.submit)
 */

const DEFAULT_MIN_SCORE = Number.isFinite(Number(process.env.RECAPTCHA_MIN_SCORE))
  ? Number(process.env.RECAPTCHA_MIN_SCORE)
  : 0.5;

/** Small helper to read a single, stable request id for echoing to clients/proxies. */
function echoRequestId(req, res) {
  const rid = req.requestId || req.get?.('x-request-id') || req.get?.('x-correlation-id');
  if (rid) res.set('X-Request-Id', String(rid));
  return rid;
}

/** Consolidate captcha token from multiple common client-side keys. */
function pickCaptchaToken(body = {}) {
  const c =
    body.captcha_token ??
    body.captchaToken ??
    body.recaptcha_token ??
    body.recaptchaToken ??
    body['g-recaptcha-response'] ??
    body.g_recaptcha_response ??
    body.captcha ??
    null;

  if (c == null) return null;
  const s = String(c).trim();
  return s.length ? s : null;
}

/** Resolve client IP (honors proxies when Express trust proxy is configured). */
function getClientIp(req) {
  // Express populates req.ip when trust proxy is configured; fall back gracefully.
  return req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.connection?.remoteAddress || undefined;
}

/**
 * Perform the remote verification against Google's siteverify.
 * NOTE: Using global fetch (Node 18+) instead of the internal httpClient to avoid host allowlist.
 */
async function verifyWithGoogle({ secret, response, remoteip }) {
  const params = new URLSearchParams();
  params.append('secret', String(secret));
  params.append('response', String(response));
  if (remoteip) params.append('remoteip', String(remoteip));

  const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });

  // Parse JSON safely; if it fails, treat as failure.
  let data = {};
  try {
    data = await resp.json();
  } catch {
    data = {};
  }

  return { ok: resp.ok, data };
}

/**
 * Factory: returns the middleware.
 * Options:
 * - minScore: override minimum acceptable v3 score (default 0.5).
 */
function recaptchaVerify({ minScore = DEFAULT_MIN_SCORE } = {}) {
  return async function recaptchaVerifyMiddleware(req, res, next) {
    const rid = echoRequestId(req, res);

    try {
      const secret = process.env.RECAPTCHA_SECRET;
      if (!secret) {
        // In production, this MUST be set. We fail closed for safety.
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

      const remoteip = getClientIp(req);
      const { ok, data } = await verifyWithGoogle({ secret, response: token, remoteip });

      // Basic protocol/response checks
      if (!ok || !data || data.success !== true) {
        return res.status(400).json({
          error: 'recaptcha_failed',
          message: 'reCAPTCHA verification failed',
          details: { codes: Array.isArray(data?.['error-codes']) ? data['error-codes'] : undefined },
          request_id: rid,
        });
      }

      // v3 score gating
      const score = Number(data.score);
      if (Number.isFinite(score) && score < Number(minScore)) {
        return res.status(400).json({
          error: 'recaptcha_low_score',
          message: 'reCAPTCHA score too low',
          details: { score },
          request_id: rid,
        });
      }

      // Optional action check: if client sent an expected action, enforce exact match.
      // (Enterprise/standard both can carry an "action" string.)
      const expectedAction =
        (req.body && (req.body.recaptcha_action || req.body.action)) ||
        undefined;

      if (expectedAction && data.action && String(data.action) !== String(expectedAction)) {
        return res.status(400).json({
          error: 'recaptcha_action_mismatch',
          message: 'reCAPTCHA action mismatch',
          details: { expected: String(expectedAction), got: String(data.action) },
          request_id: rid,
        });
      }

      // Stash a compact verification context for downstream handlers (no PII).
      req.recaptcha = {
        success: true,
        score: Number.isFinite(score) ? score : undefined,
        action: data.action || undefined,
        timestamp: data.challenge_ts || undefined,
        hostname: data.hostname || undefined,
      };

      return next();
    } catch (err) {
      // Fail closed but keep payload compact and non-sensitive.
      return res.status(400).json({
        error: 'recaptcha_error',
        message: 'reCAPTCHA verification error',
        request_id: rid,
      });
    }
  };
}

module.exports = recaptchaVerify;
