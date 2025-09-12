// middlewares/recaptcha.js
'use strict';

/**
 * reCAPTCHA Enterprise verification middleware
 * --------------------------------------------
 * Validates client tokens using the reCAPTCHA Enterprise Assessments API.
 * - Keeps request field names unchanged: `recaptcha_token` and `recaptcha_action`
 * - Enforces minimum score and optional expected action
 * - Short, hard timeout to protect end-to-end UX SLA
 *
 * Environment variables:
 *  - RECAPTCHA_PROJECT_ID     : GCP project ID that owns the Enterprise key
 *  - RECAPTCHA_API_KEY        : API key for reCAPTCHA Enterprise (restrict appropriately)
 *  - RECAPTCHA_SITE_KEY       : Enterprise site key used on the frontend
 *  - RECAPTCHA_MIN_SCORE      : optional; minimum score threshold (default: 0.5)
 *  - RECAPTCHA_EXPECT_ACTION  : optional; expected action to match (e.g., "birthchart_submit")
 *  - RECAPTCHA_HTTP_TIMEOUT_MS: optional; end-to-end HTTP timeout in ms (default: 4000)
 *
 * Notes:
 *  - This middleware uses the REST API via API key to avoid credential discovery delays.
 *  - Do NOT log secrets or full responses; only minimal diagnostic fields are logged.
 *  - Consider setting NODE_OPTIONS=--dns-result-order=ipv4first in environments with flaky IPv6.
 */

const { fetch } = require('undici');

const PROJECT_ID   = process.env.RECAPTCHA_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
const API_KEY      = process.env.RECAPTCHA_API_KEY || '';
const SITE_KEY     = process.env.RECAPTCHA_SITE_KEY || '';
const MIN_SCORE    = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);
const EXPECT_ACTION= process.env.RECAPTCHA_EXPECT_ACTION || '';
const HTTP_TIMEOUT_MS = Number(process.env.RECAPTCHA_HTTP_TIMEOUT_MS || 4000);

const ENTERPRISE_URL = (projectId, apiKey) =>
  `https://recaptchaenterprise.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/assessments?key=${encodeURIComponent(apiKey)}`;

/**
 * Returns a composite AbortSignal that cancels when any of the given signals abort.
 * Uses AbortSignal.any when available; falls back to the first provided signal.
 */
function anySignal(signals) {
  const valid = (signals || []).filter(Boolean);
  if (typeof AbortSignal.any === 'function' && valid.length > 0) return AbortSignal.any(valid);
  return valid[0] || undefined;
}

async function recaptchaVerify(req, res, next) {
  const started = Date.now();

  try {
    const token  = req.body?.recaptcha_token;
    const action = req.body?.recaptcha_action;

    // Basic configuration and input validation (no secrets logged)
    if (!PROJECT_ID || !API_KEY || !SITE_KEY) {
      return res.status(500).json({ message: 'recaptcha_misconfigured' });
    }
    if (!token) {
      return res.status(400).json({ message: 'recaptcha_missing_token' });
    }

    // Build Enterprise Assessments payload
    const payload = {
      event: {
        token,
        siteKey: SITE_KEY,
        expectedAction: action || EXPECT_ACTION || undefined, // server-side hint; not enforced by itself
        userIpAddress: req.ip,
        userAgent: req.get?.('user-agent'),
      }
    };

    // Enforce a strict timeout and cancel if client disconnects
    const signal = anySignal([
      AbortSignal.timeout(HTTP_TIMEOUT_MS),
      req.clientAbortSignal
    ]);

    // Call reCAPTCHA Enterprise REST API
    const resp = await fetch(ENTERPRISE_URL(PROJECT_ID, API_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });

    // Handle non-2xx quickly (network OK but API rejected/errored)
    // The API generally returns JSON with error details; we avoid echoing them to clients.
    if (!resp.ok) {
      const took = Date.now() - started;
      req.log?.warn?.({ took, status: resp.status }, '[recaptcha] enterprise non-2xx');
      // Treat as service unavailable to avoid leaking details and to keep UX predictable
      return res.status(503).json({ message: 'recaptcha_unavailable' });
    }

    const data = await resp.json();
    const tp   = data?.tokenProperties || {};
    const risk = data?.riskAnalysis || {};

    // Token validity check
    if (!tp.valid) {
      // Hard failure: invalid token, malformed, expired, or wrong site key/domain
      const took = Date.now() - started;
      req.log?.info?.({ took, reason: tp.invalidReason }, '[recaptcha] invalid_token');
      return res.status(429).json({ message: 'recaptcha_failed' });
    }

    // Action enforcement: prefer explicit EXPECT_ACTION, otherwise honor provided action field
    const expected = EXPECT_ACTION || action || '';
    if (expected && tp.action && tp.action !== expected) {
      const took = Date.now() - started;
      req.log?.info?.({ took, expected, got: tp.action }, '[recaptcha] action_mismatch');
      return res.status(429).json({ message: 'recaptcha_action_mismatch' });
    }

    // Score threshold enforcement
    const score = typeof risk.score === 'number' ? risk.score : null;
    if (score !== null && score < MIN_SCORE) {
      const took = Date.now() - started;
      req.log?.info?.({ took, score }, '[recaptcha] low_score');
      return res.status(429).json({ message: 'recaptcha_low_score', score });
    }

    // Success path
    const took = Date.now() - started;
    req.log?.info?.({ took, score, action: tp.action }, '[recaptcha] ok');
    return next();

  } catch (err) {
    const took = Date.now() - started;
    req.log?.warn?.({ took, err: err?.name || 'Error', msg: err?.message }, '[recaptcha] error');

    // Timeouts and client disconnects are treated as temporary unavailability
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return res.status(503).json({ message: 'recaptcha_unavailable' });
    }
    return res.status(503).json({ message: 'recaptcha_unavailable' });
  }
}

module.exports = recaptchaVerify;
