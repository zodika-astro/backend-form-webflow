// utils/normalizeSubmission.js

'use strict';

/**
 * Normalizers for form submissions.
 * - normalizeConsent(body) → boolean (true if user agreed to Privacy Policy)
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


module.exports = { normalizeConsent };
