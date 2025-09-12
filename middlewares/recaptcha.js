// middlewares/recaptcha.js
'use strict';

/**
 * reCAPTCHA Enterprise verification middleware
 * --------------------------------------------
 * Validates client tokens using the reCAPTCHA Enterprise Assessments API.
 * - Keeps request field names unchanged: `recaptcha_token` and `recaptcha_action`
 * - Enforces minimum score and optional expected action
 * - Uses a slightly larger timeout and a single safe retry for resiliency
 *
 * Environment variables:
 *  - RECAPTCHA_PROJECT_ID      : GCP project ID/number that owns the Enterprise site key
 *  - RECAPTCHA_API_KEY         : API key for reCAPTCHA Enterprise (API-restricted)
 *  - RECAPTCHA_SITE_KEY        : Enterprise site key used on the frontend
 *  - RECAPTCHA_MIN_SCORE       : optional; minimum score threshold (default: 0.5)
 *  - RECAPTCHA_EXPECT_ACTION   : optional; expected action to match (e.g., "birthchart_submit")
 *  - RECAPTCHA_HTTP_TIMEOUT_MS : optional; per-attempt HTTP timeout in ms (default: 8000)
 *
 * Notes:
 *  - This middleware uses the REST API via API key to avoid credential discovery delays.
 *  - Do NOT log secrets or full responses; only minimal diagnostic fields are logged.
 *  - Consider setting NODE_OPTIONS=--dns-result-order=ipv4first in environments with flaky IPv6.
 */

const { fetch } = require('undici');

const PROJECT_ID    = process.env.RECAPTCHA_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
const API_KEY       = process.env.RECAPTCHA_API_KEY || '';
const SITE_KEY      = process.env.RECAPTCHA_SITE_KEY || '';
const MIN_SCORE     = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);
const EXPECT_ACTION = process.env.RECAPTCHA_EXPECT_ACTION || '';
const HTTP_TIMEOUT_MS = Number(process.env.RECAPTCHA_HTTP_TIMEOUT_MS || 8000); // more resilient default

// Single safe retry with bounded total budget
const MAX_ATTEMPTS = 2;                               // 1 initial attempt + 1 retry
const RETRY_DELAY_MS = 250;                           // small backoff between attempts
const TOTAL_BUDGET_MS = Math.min(HTTP_TIMEOUT_MS * 2, 15000); // cap overall time to protect UX

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

/** Sleep helper for small backoffs (non-blocking). */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    });
  });
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
        expectedAction: action || EXPECT_ACTION || undefined,
        userIpAddress: req.ip,
        userAgent: req.get?.('user-agent'),
      }
    };

    // Overall deadline to avoid unbounded waits
    const overall = new AbortController();
    const overallTimer = setTimeout(() => overall.abort(Object.assign(new Error('Total timeout'), { name: 'TimeoutError' })), TOTAL_BUDGET_MS);

    let attempt = 0;
    let lastStatus = null;
    let lastErrorName = null;

    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      try {
        // Per-attempt timeout + cancel when client disconnects + overall deadline
        const signal = anySignal([
          AbortSignal.timeout(HTTP_TIMEOUT_MS),
          req.clientAbortSignal,
          overall.signal,
        ]);

        const resp = await fetch(ENTERPRISE_URL(PROJECT_ID, API_KEY), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        });

        lastStatus = resp.status;

        if (!resp.ok) {
          // Non-2xx (e.g., 400/403/5xx). Retry once for transient classes only.
          // We do not expose API details to the client.
          if (attempt < MAX_ATTEMPTS && resp.status >= 500) {
            await delay(RETRY_DELAY_MS, overall.signal);
            continue;
          }
          clearTimeout(overallTimer);
          const took = Date.now() - started;
          req.log?.warn?.({ took, status: resp.status, attempt }, '[recaptcha] enterprise non-2xx');
          return res.status(503).json({ message: 'recaptcha_unavailable' });
        }

        const data = await resp.json();
        const tp   = data?.tokenProperties || {};
        const risk = data?.riskAnalysis || {};

        // Token validity check
        if (!tp.valid) {
          const took = Date.now() - started;
          clearTimeout(overallTimer);
          req.log?.info?.({ took, attempt, reason: tp.invalidReason }, '[recaptcha] invalid_token');
          return res.status(429).json({ message: 'recaptcha_failed' });
        }

        // Action enforcement
        const expected = EXPECT_ACTION || action || '';
        if (expected && tp.action && tp.action !== expected) {
          const took = Date.now() - started;
          clearTimeout(overallTimer);
          req.log?.info?.({ took, attempt, expected, got: tp.action }, '[recaptcha] action_mismatch');
          return res.status(429).json({ message: 'recaptcha_action_mismatch' });
        }

        // Score threshold enforcement
        const score = typeof risk.score === 'number' ? risk.score : null;
        if (score !== null && score < MIN_SCORE) {
          const took = Date.now() - started;
          clearTimeout(overallTimer);
          req.log?.info?.({ took, attempt, score }, '[recaptcha] low_score');
          return res.status(429).json({ message: 'recaptcha_low_score', score });
        }

        // Success path
        const took = Date.now() - started;
        clearTimeout(overallTimer);
        req.log?.info?.({ took, attempt, score, action: tp.action }, '[recaptcha] ok');
        return next();

      } catch (err) {
        lastErrorName = err?.name || 'Error';

        // Abort/timeout or transient errors: retry once if we still have time
        const isTimeout = lastErrorName === 'AbortError' || lastErrorName === 'TimeoutError';
        if (attempt < MAX_ATTEMPTS && isTimeout && !overall.signal.aborted) {
          await delay(RETRY_DELAY_MS, overall.signal);
          continue;
        }

        clearTimeout(overallTimer);
        const took = Date.now() - started;
        req.log?.warn?.({ took, attempt, err: lastErrorName, status: lastStatus }, '[recaptcha] error');
        return res.status(503).json({ message: 'recaptcha_unavailable' });
      }
    }

    // Defensive: if the loop exits without returning
    clearTimeout(overallTimer);
    const took = Date.now() - started;
    req.log?.warn?.({ took, status: lastStatus, err: lastErrorName }, '[recaptcha] exhausted');
    return res.status(503).json({ message: 'recaptcha_unavailable' });

  } catch (err) {
    const took = Date.now() - started;
    req.log?.warn?.({ took, err: err?.name || 'Error', msg: err?.message }, '[recaptcha] outer_error');
    return res.status(503).json({ message: 'recaptcha_unavailable' });
  }
}

module.exports = recaptchaVerify;
