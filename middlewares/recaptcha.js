// middlewares/recaptcha.js
'use strict';

/**
 * reCAPTCHA v3 + Privacy Consent Guard
 * ------------------------------------
 * What it does:
 *  - Requires the privacy checkbox to be accepted (boolean true / "true" / "on" / "1").
 *  - Verifies Google reCAPTCHA v3 token against the official siteverify endpoint.
 *  - Enforces a minimal score threshold (default 0.5) and optional action check.
 *  - Attaches verification details to req.security.recaptcha and strips sensitive fields from req.body.
 *
 * Security notes:
 *  - Uses secretProvider first (managed secret), then falls back to env var RECAPTCHA_SECRET_KEY.
 *  - In production, missing secret => fail closed (400).
 *  - Never logs token or PII; only structured flags/metrics should be logged upstream.
 */

const httpClient = require('../utils/httpClient');
const { AppError } = require('../utils/appError');
const { get: getSecret } = require('../config/secretProvider');

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

// Default score threshold (0.0–1.0). You can tune via RECAPTCHA_MIN_SCORE.
const DEFAULT_MIN_SCORE = 0.5;
// Expected action (optional). Keep empty to skip strict action checking.
const EXPECTED_ACTION = 'birthchart_form_submit';

function parseBooleanish(v) {
  if (v === true) return true;
  const s = String(v || '').toLowerCase().trim();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes';
}

function pickToken(body) {
  return body?.recaptchaToken || body?.['g-recaptcha-response'] || null;
}

async function resolveSecret() {
  // Prefer secret manager; fallback to process.env.
  const fromProvider = await getSecret('RECAPTCHA_SECRET_KEY').catch(() => null);
  return fromProvider || process.env.RECAPTCHA_SECRET_KEY || null;
}

module.exports = async function verifyRecaptcha(req, res, next) {
  try {
    // 1) Privacy consent (required)
    const consentOk = parseBooleanish(req.body?.privacyConsent);
    if (!consentOk) {
      throw AppError.validation('privacy_consent_required', 'Privacy Policy consent is required to submit this form.');
    }

    // 2) Token presence (required)
    const token = pickToken(req.body);
    if (!token) {
      throw AppError.validation('recaptcha_token_missing', 'reCAPTCHA token is missing.');
    }

    // 3) Resolve secret (fail closed in production)
    const secret = await resolveSecret();
    const isProd = (process.env.NODE_ENV || 'production') === 'production';
    if (!secret && isProd) {
      throw AppError.fromUpstream('recaptcha_secret_unavailable', 'reCAPTCHA secret is not configured.', null, { provider: 'recaptcha' });
    }
    if (!secret) {
      // Non-prod: warn and continue best-effort (useful for local dev)
      req.security = { ...(req.security || {}), recaptcha: { skipped: true, reason: 'no_secret_non_prod' } };
      // Strip sensitive fields anyway
      delete req.body.recaptchaToken;
      delete req.body['g-recaptcha-response'];
      delete req.body.privacyConsent;
      return next();
    }

    // 4) Verify with Google (form-encoded)
    const minScore = Number(process.env.RECAPTCHA_MIN_SCORE || DEFAULT_MIN_SCORE);
    const params = new URLSearchParams();
    params.set('secret', secret);
    params.set('response', token);
    if (req.ip) params.set('remoteip', req.ip);

    const response = await httpClient.post(VERIFY_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 5000,
      retries: 1,
      retryBackoffMs: [0, 250],
    });

    const data = response?.data || {};
    const ok = !!data.success;
    const score = typeof data.score === 'number' ? data.score : null;
    const action = data.action || null;
    const hostname = data.hostname || null;

    // 5) Evaluate policy (score + optional action)
    if (!ok) {
      throw AppError.validation('recaptcha_failed', 'reCAPTCHA verification failed.', { errors: data['error-codes'] || undefined });
    }
    if (score !== null && score < minScore) {
      throw AppError.validation('recaptcha_low_score', 'reCAPTCHA score below acceptable threshold.', { score, minScore });
    }
    if (EXPECTED_ACTION && action && action !== EXPECTED_ACTION) {
      throw AppError.validation('recaptcha_bad_action', 'reCAPTCHA action did not match.', { expected: EXPECTED_ACTION, action });
    }

    // 6) Attach security context and strip sensitive fields from the body
    req.security = {
      ...(req.security || {}),
      recaptcha: {
        success: true,
        score,
        action,
        hostname,
        challengeTs: data['challenge_ts'] || null,
      },
    };

    delete req.body.recaptchaToken;
    delete req.body['g-recaptcha-response'];
    delete req.body.privacyConsent;

    return next();
  } catch (err) {
    // Normalize to AppError if needed and pass to centralized handler.
    if (err instanceof AppError) return next(err);
    return next(AppError.fromUnexpected('recaptcha_unexpected_error', 'Unexpected error during reCAPTCHA verification', { cause: err }));
  }
};
