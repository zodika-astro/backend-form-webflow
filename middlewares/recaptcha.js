// middlewares/recaptcha.js
'use strict';

/**
 * reCAPTCHA verification middleware (v3 / Enterprise)
 * ---------------------------------------------------
 * What it does
 * - Extracts the captcha token from common keys (recaptcha_token, g-recaptcha-response, etc.).
 * - Calls the appropriate verification endpoint based on RECAPTCHA_MODE:
 *     - standard  -> https://www.google.com/recaptcha/api/siteverify
 *     - enterprise-> https://www.google.com/recaptcha/enterprise/siteverify
 *   (Same protocol: x-www-form-urlencoded, using RECAPTCHA_SECRET.)
 * - Enforces a minimum score (configurable via RECAPTCHA_MIN_SCORE).
 * - Optionally enforces action match when the client sends `recaptcha_action`.
 *
 * Environment
 * - RECAPTCHA_SECRET        (required in production)
 * - RECAPTCHA_MODE          "standard" (default) | "enterprise"
 * - RECAPTCHA_MIN_SCORE     default 0.5 (v3-style score; ignore if absent)
 *
 * Notes
 * - Responds with compact 4xx JSON (no PII).
 * - Adds minimal, structured logs when `req.log` exists (no payload dump).
 */

const MODE = String(process.env.RECAPTCHA_MODE || 'standard').trim().toLowerCase();
const VERIFY_URL =
  MODE === 'enterprise'
    ? 'https://www.google.com/recaptcha/enterprise/siteverify'
    : 'https://www.google.com/recaptcha/api/siteverify';

const DEFAULT_MIN_SCORE = Number.isFinite(Number(process.env.RECAPTCHA_MIN_SCORE))
  ? Number(process.env.RECAPTCHA_MIN_SCORE)
  : 0.5;

/** Echo a single request id to the response headers for correlation. */
function echoRequestId(req, res) {
  const rid =
    req.requestId ||
    req.get?.('x-request-id') ||
    req.get?.('x-correlation-id') ||
    undefined;
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

/** Resolve client IP (honors proxies when Express trust proxy is configured). */
function getClientIp(req) {
  return (
    req.ip ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.connection?.remoteAddress ||
    undefined
  );
}

/** Perform remote verification against the chosen siteverify endpoint. */
async function verifyWithGoogle({ secret, response, remoteip }) {
  const params = new URLSearchParams();
  params.append('secret', String(secret));
  params.append('response', String(response));
  if (remoteip) params.append('remoteip', String(remoteip));

  const resp = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  let data = {};
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  return { ok: resp.ok, data, status: resp.status };
}

/**
 * Factory: returns the middleware.
 * Options:
 * - minScore: override minimum acceptable v3 score (default 0.5).
 */
function recaptchaVerify({ minScore = DEFAULT_MIN_SCORE } = {}) {
  return async function recaptchaVerifyMiddleware(req, res, next) {
    const rid = echoRequestId(req, res);
    const log = (req.log || console);

    try {
      const secret = process.env.RECAPTCHA_SECRET;
      if (!secret) {
        log.error?.({ rid, mode: MODE }, 'recaptcha secret missing');
        return res.status(500).json({
          error: 'recaptcha_misconfigured',
          message: 'Server reCAPTCHA secret not configured',
          request_id: rid,
        });
      }

      const token = pickCaptchaToken(req.body || {});
      if (!token) {
        log.warn?.({ rid, mode: MODE }, 'recaptcha missing token');
        return res.status(400).json({
          error: 'recaptcha_missing',
          message: 'reCAPTCHA token is missing',
          request_id: rid,
        });
      }

      const remoteip = getClientIp(req);
      const { ok, data, status } = await verifyWithGoogle({
        secret,
        response: token,
        remoteip,
      });

      // Protocol-level failure or API-encoded failure
      if (!ok || data?.success !== true) {
        // Keep logs compact and non-PII; include error-codes/action/score when available
        log.warn?.(
          {
            rid,
            mode: MODE,
            http: status,
            codes: Array.isArray(data?.['error-codes']) ? data['error-codes'] : undefined,
            action: data?.action,
            score: data?.score,
          },
          'recaptcha verify failed'
        );

        return res.status(400).json({
          error: 'recaptcha_failed',
          message: 'reCAPTCHA verification failed',
          // We intentionally do not echo error-codes to the client in production.
          request_id: rid,
        });
      }

      // Score gating (only when present)
      const score = Number(data.score);
      if (Number.isFinite(score) && score < Number(minScore)) {
        log.warn?.({ rid, mode: MODE, score }, 'recaptcha low score');
        return res.status(400).json({
          error: 'recaptcha_low_score',
          message: 'reCAPTCHA score too low',
          request_id: rid,
        });
      }

      // Optional action check: if client sent an expected action, enforce exact match
      const expectedAction =
        (req.body && (req.body.recaptcha_action || req.body.action)) || undefined;

      if (expectedAction && data.action && String(data.action) !== String(expectedAction)) {
        log.warn?.(
          { rid, mode: MODE, expected: String(expectedAction), got: String(data.action) },
          'recaptcha action mismatch'
        );
        return res.status(400).json({
          error: 'recaptcha_action_mismatch',
          message: 'reCAPTCHA action mismatch',
          request_id: rid,
        });
      }

      // Attach a minimal verification context for downstream handlers (no PII).
      req.recaptcha = {
        success: true,
        score: Number.isFinite(score) ? score : undefined,
        action: data.action || undefined,
        timestamp: data.challenge_ts || undefined,
        hostname: data.hostname || undefined,
        mode: MODE,
      };

      return next();
    } catch (err) {
      log.error?.({ rid, mode: MODE, err: String(err?.message || err) }, 'recaptcha error');
      return res.status(400).json({
        error: 'recaptcha_error',
        message: 'reCAPTCHA verification error',
        request_id: rid,
      });
    }
  };
}

module.exports = recaptchaVerify;
