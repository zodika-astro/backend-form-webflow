// utils/normalizeSubmission.js

'use strict';

/**
 * Normalizers for form submissions.
 * - normalizeConsent(body) → boolean (true if user agreed to Privacy Policy)
 * - pickCaptchaToken(body) → string|null (best-effort extraction)
 *
 * Keep this tiny and dependency-free. It runs on hot paths.
 */

function normalizeConsent(body = {}) {
  // Accept several common shapes: true/false, "on", "yes", "1", "true"
  const raw =
    body.privacyConsent ??
    body.privacy_agreed ??
    body.privacy ??
    body.privacy_policy ?? // typical checkbox name
    body.policy ??
    body.terms;

  if (raw == null) return false;

  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;

  const s = String(raw).trim().toLowerCase();
  return s === 'true' || s === 'on' || s === 'yes' || s === '1' || s === 'checked';
}

function pickCaptchaToken(body = {}) {
  // Accept common client keys for reCAPTCHA v3/v2
  return (
    body.recaptcha_token ??
    body.recaptchaToken ??
    body.captcha_token ??
    body.captchaToken ??
    body['g-recaptcha-response'] ??
    body.g_recaptcha_response ??
    body.captcha ??
    null
  );
}

module.exports = { normalizeConsent, pickCaptchaToken };
