// middlewares/recaptcha.js
'use strict';

/**
 * reCAPTCHA v3 verification middleware (production-ready)
 * -------------------------------------------------------
 * What it does
 * - Extracts the token from common client keys.
 * - Calls Google's "siteverify" with a hard timeout.
 * - Enforces a minimum score (env-configurable).
 * - Optionally enforces the expected "action" provided by the client.
 *
 * Design constraints
 * - Export a direct Express middleware (not a factory) to match current router usage.
 * - No PII logging; compact error payloads.
 * - Do NOT remove consent/token from req.body here (the controller still checks them).
 *
 * Environment
 * - RECAPTCHA_SECRET        (required in production)
 * - RECAPTCHA_MIN_SCORE     (optional; default: 0.5)
 * - RECAPTCHA_TIMEOUT_MS    (optional; default: 8000)
 */

const DEFAULT_MIN_SCORE = Number.isFinite(Number(process.env.RECAPTCHA_MIN_SCORE))
  ? Number(process.env.RECAPTCHA_MIN_SCORE)
  : 0.5;

const TIMEOUT_MS = Number.isFinite(Number(process.env.RECAPTCHA_TIMEOUT_MS))
  ? Number(process.env.RECAPTCHA_TIMEOUT_MS)
  : 8000;

/** Small helper to echo a request id back to clients/proxies. */
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

/** Resolve client IP (honors Express trust proxy). */
function getClientIp(req) {
  return (
    req.ip ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.connection?.remoteAddress ||
    undefined
  );
}

/** POST to Google's siteverify with an AbortController-based timeout. */
async function verifyWithGoogle({ secret, response, remoteip, timeoutMs }) {
  const params = new URLSearchParams();
  params.append('secret', String(secret));
  params.append('response', String(response));
  if (remoteip) params.append('remoteip', String(remoteip));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
      signal: controller.signal,
    });

    let data = {};
    try {
      data = await resp.json();
    } catch {
      data = {};
    }
    return { status: resp.status, ok: resp.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Direct Express middleware (matches current router usage).
 * Fails closed with HTTP 400 on verification problems.
 */
module.exports = async function recaptchaMiddleware(req, res, next) {
  const rid = echoRequestId(req, res);

  try {
    const secret = process.env.RECAPTCHA_SECRET;
    if (!secret) {
      // Fail closed in production – missing secret is a misconfiguration.
      return res.status(500).json({
        error: 'recaptcha_misconfigured',
        message: 'Server reCAPTCHA secret not configured',
        request_id: rid,
      });
    }

    // Token presence check (aligns with your controller’s requirement).
    const token = pickCaptchaToken(req.body || {});
    if (!token) {
      return res.status(400).json({
        error: 'recaptcha_missing',
        message: 'reCAPTCHA token is missing',
        request_id: rid,
      });
    }

    const remoteip = getClientIp(req);
    const { ok, data } = await verifyWithGoogle({
      secret,
      response: token,
      remoteip,
      timeoutMs: TIMEOUT_MS,
    });

    if (!ok || !data || data.success !== true) {
      return res.status(400).json({
        error: 'recaptcha_failed',
        message: 'reCAPTCHA verification failed',
        details: Array.isArray(data?.['error-codes'])
          ? { codes: data['error-codes'] }
          : undefined,
        request_id: rid,
      });
    }

    // v3 score gating
    const score = Number(data.score);
    if (Number.isFinite(score) && score < DEFAULT_MIN_SCORE) {
      return res.status(400).json({
        error: 'recaptcha_low_score',
        message: 'reCAPTCHA score too low',
        details: { score },
        request_id: rid,
      });
    }

    // Optional action enforcement when client sends one
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

    // Attach a compact verification context for downstream handlers.
    req.recaptcha = {
      success: true,
      score: Number.isFinite(score) ? score : undefined,
      action: data.action || undefined,
      timestamp: data.challenge_ts || undefined,
      hostname: data.hostname || undefined,
    };

    return next();
  } catch (err) {
    // Abort/timeouts or unexpected errors → fail closed.
    return res.status(400).json({
      error: 'recaptcha_error',
      message: 'reCAPTCHA verification error',
      request_id: rid,
    });
  }
};
