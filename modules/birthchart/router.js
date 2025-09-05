// modules/birthchart/router.js
'use strict';

const express = require('express');
const router = express.Router();

const refererAuth = require('../../middlewares/refererAuth');
const birthchartController = require('./controller'); // kept the original name semantic

/**
 * Server-side CAPTCHA & Privacy enforcement
 * ----------------------------------------
 * - Enforces Privacy Policy checkbox (`privacy_agreed`) before processing the form.
 * - Verifies Google reCAPTCHA v3 token with Google's verify endpoint.
 * - Fails closed in production if CAPTCHA is misconfigured.
 *
 * Environment (no change to config/env.js required right now):
 * - CAPTCHA_PROVIDER   : 'recaptcha' | 'recaptcha_v3' (default: 'recaptcha')
 * - RECAPTCHA_SECRET   : Google reCAPTCHA secret (server-side secret)
 * - RECAPTCHA_MIN_SCORE: Optional min score threshold for v3 (default: 0.5)
 *
 * Security notes:
 * - Do not log tokens or secrets.
 * - Use `req.ip` (honors Express trust proxy setting) as `remoteip`.
 * - Keep responses generic to avoid giving hints to attackers.
 */

// ---------- Middleware: require Privacy Policy consent ----------
function requirePrivacyConsent(req, res, next) {
  try {
    const raw = req?.body?.privacy_agreed;
    // Accept boolean true, "true", "1", 1
    const agreed =
      raw === true ||
      raw === 1 ||
      raw === '1' ||
      (typeof raw === 'string' && raw.toLowerCase() === 'true');

    if (!agreed) {
      return res.status(400).json({
        message: 'You must agree to the Privacy Policy to continue.',
      });
    }
    return next();
  } catch (err) {
    // Defensive: do not expose implementation details
    return res.status(400).json({ message: 'Invalid privacy consent payload.' });
  }
}

// ---------- Middleware: verify reCAPTCHA v3 token ----------
async function verifyRecaptchaV3(req, res, next) {
  const provider = String(process.env.CAPTCHA_PROVIDER || 'recaptcha').toLowerCase();
  const isRecaptcha =
    provider === 'recaptcha' || provider === 'recaptcha_v3';

  // If provider is not reCAPTCHA, skip verification (feature not enabled).
  if (!isRecaptcha) return next();

  const secret = process.env.RECAPTCHA_SECRET;
  const minScore = Number.isFinite(Number(process.env.RECAPTCHA_MIN_SCORE))
    ? Number(process.env.RECAPTCHA_MIN_SCORE)
    : 0.5;

  // Fail-closed in production when misconfigured
  const isProd = (process.env.NODE_ENV || 'production').toLowerCase() === 'production';
  if (isProd && !secret) {
    // Do not reveal configuration details to the client
    return res.status(503).json({ message: 'CAPTCHA verification unavailable.' });
  }
  if (!secret) {
    // In non-prod, allow pass-through (useful during local dev)
    return next();
  }

  const token = req?.body?.recaptcha_token;
  const actionClaim = req?.body?.recaptcha_action || 'birthchart_submit';

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ message: 'CAPTCHA token is required.' });
  }

  // Verify token with Google
  try {
    const params = new URLSearchParams();
    params.append('secret', secret);
    params.append('response', token);
    // Use client IP; Express trust proxy is configured at app level
    if (req.ip) params.append('remoteip', req.ip);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) {
      // Avoid leaking upstream details; treat as a verification failure
      return res.status(403).json({ message: 'CAPTCHA verification failed.' });
    }

    const data = await resp.json();
    // Expected fields: success, score, action, hostname, challenge_ts, error-codes
    const ok = !!data?.success;
    const score = typeof data?.score === 'number' ? data.score : null;
    const action = data?.action;

    // Enforce success, matching action (when present), and score threshold
    const actionMatches = !action || action === actionClaim;
    const scoreOk = score == null ? true : score >= minScore;

    if (!ok || !actionMatches || !scoreOk) {
      // Minimal rejection, no details (attackers should not learn the reason)
      return res.status(403).json({ message: 'CAPTCHA verification failed.' });
    }

    // Attach a minimal verification result for downstream logging/debug (no token/secret)
    req.captcha = {
      provider: 'recaptcha_v3',
      score,
      action: action || null,
      hostname: data?.hostname || null,
      challenge_ts: data?.challenge_ts || null,
    };

    return next();
  } catch (err) {
    // Network error / timeout / parse error → fail-closed in prod, soft in dev
    if (isProd) {
      return res.status(503).json({ message: 'CAPTCHA verification unavailable.' });
    }
    return next();
  }
}

/**
 * Route: POST /birthchart/birthchartsubmit-form
 * ---------------------------------------------
 * Middleware order matters:
 * 1) refererAuth          → origin/referer checks (your existing middleware)
 * 2) requirePrivacyConsent→ must be checked before continuing
 * 3) verifyRecaptchaV3    → server-side reCAPTCHA validation
 * 4) processForm          → actual business logic
 */
router.post(
  '/birthchartsubmit-form',
  refererAuth,
  requirePrivacyConsent,
  verifyRecaptchaV3,
  birthchartController.processForm
);

module.exports = router;
