// middlewares/recaptcha.js
'use strict';

/**
 * reCAPTCHA Enterprise verification middleware (REST + API key)
 * -------------------------------------------------------------
 * Validates client tokens using the Enterprise Assessments REST API.
 * - Preserves request fields: `recaptcha_token`, `recaptcha_action`
 * - Enforces minimum score and optional expected action
 * - Resilient: larger per-attempt timeout + single retry with bounded total budget
 *
 * Required env:
 *  - RECAPTCHA_PROJECT_ID        : GCP Project ID or number (same project where the Enterprise key lives)
 *  - RECAPTCHA_API_KEY           : API key restricted to "reCAPTCHA Enterprise API"
 *  - RECAPTCHA_SITE_KEY          : Enterprise site key used on the frontend
 *
 * Recommended env:
 *  - RECAPTCHA_EXPECT_ACTION     : e.g., "birthchart_submit"
 *  - RECAPTCHA_MIN_SCORE         : e.g., 0.5
 *  - RECAPTCHA_HTTP_TIMEOUT_MS   : per-attempt timeout (default 8000)
 *  - NODE_OPTIONS=--dns-result-order=ipv4first (deployment-level; improves DNS latency)
 *
 * Optional degrade mode (do not block on Google outages):
 *  - RECAPTCHA_DEGRADE_ON_ERROR=1 → pass request with req.recaptcha.degraded=true
 */

const { fetch } = require('undici');

const PROJECT_ID       = process.env.RECAPTCHA_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
const API_KEY          = process.env.RECAPTCHA_API_KEY || '';
const SITE_KEY         = process.env.RECAPTCHA_SITE_KEY || '';
const EXPECT_ACTION    = process.env.RECAPTCHA_EXPECT_ACTION || '';
const MIN_SCORE        = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);
const HTTP_TIMEOUT_MS  = Number(process.env.RECAPTCHA_HTTP_TIMEOUT_MS || 8000);

// One safe retry for transient failures with a small backoff; cap total time to protect UX.
const MAX_ATTEMPTS     = 2;
const RETRY_DELAY_MS   = 250;
const TOTAL_BUDGET_MS  = Math.min(HTTP_TIMEOUT_MS * 2, 15000);

const ENTERPRISE_URL = (projectId, apiKey) =>
  `https://recaptchaenterprise.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/assessments?key=${encodeURIComponent(apiKey)}`;

/** Compose AbortSignals; uses AbortSignal.any when available. */
function anySignal(signals) {
  const valid = (signals || []).filter(Boolean);
  if (typeof AbortSignal.any === 'function' && valid.length > 0) return AbortSignal.any(valid);
  return valid[0] || undefined;
}

/** Small non-blocking delay with abort support. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); });
  });
}

async function recaptchaVerify(req, res, next) {
  const started = Date.now();

  try {
    const token  = req.body?.recaptcha_token;
    const action = req.body?.recaptcha_action;

    // Basic config validation (do not log secrets)
    if (!PROJECT_ID || !API_KEY || !SITE_KEY) {
      return res.status(500).json({ message: 'recaptcha_misconfigured' });
    }
    if (!token) {
      return res.status(400).json({ message: 'recaptcha_missing_token' });
    }

    // Enterprise Assessments payload
    const payload = {
      event: {
        token,
        siteKey: SITE_KEY,
        expectedAction: action || EXPECT_ACTION || undefined,
        userIpAddress: req.ip,
        userAgent: req.get?.('user-agent'),
      }
    };

    // Overall deadline
    const overall = new AbortController();
    const overallTimer = setTimeout(() => overall.abort(Object.assign(new Error('Total timeout'), { name: 'TimeoutError' })), TOTAL_BUDGET_MS);

    let attempt = 0;
    let lastStatus = null;
    let lastErrorName = null;

    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      try {
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
          // Retry only on 5xx once; for 4xx (auth/misconfig) do not retry.
          if (attempt < MAX_ATTEMPTS && resp.status >= 500) {
            await delay(RETRY_DELAY_MS, overall.signal);
            continue;
          }
          clearTimeout(overallTimer);
          const took = Date.now() - started;
          req.log?.warn?.({ took, status: resp.status, attempt }, '[recaptcha] enterprise non-2xx');

          if (process.env.RECAPTCHA_DEGRADE_ON_ERROR === '1') {
            req.recaptcha = { degraded: true, reason: `http_${resp.status}` };
            return next();
          }
          return res.status(503).json({ message: 'recaptcha_unavailable' });
        }

        const data = await resp.json();
        const tp   = data?.tokenProperties || {};
        const risk = data?.riskAnalysis || {};

        // Token validity
        if (!tp.valid) {
          clearTimeout(overallTimer);
          const took = Date.now() - started;
          req.log?.info?.({ took, attempt, reason: tp.invalidReason }, '[recaptcha] invalid_token');
          return res.status(429).json({ message: 'recaptcha_failed' });
        }

        // Action enforcement
        const expected = EXPECT_ACTION || action || '';
        if (expected && tp.action && tp.action !== expected) {
          clearTimeout(overallTimer);
          const took = Date.now() - started;
          req.log?.info?.({ took, attempt, expected, got: tp.action }, '[recaptcha] action_mismatch');
          return res.status(429).json({ message: 'recaptcha_action_mismatch' });
        }

        // Score threshold
        const score = typeof risk.score === 'number' ? risk.score : null;
        if (score !== null && score < MIN_SCORE) {
          clearTimeout(overallTimer);
          const took = Date.now() - started;
          req.log?.info?.({ took, attempt, score }, '[recaptcha] low_score');
          return res.status(429).json({ message: 'recaptcha_low_score', score });
        }

        // Success
        clearTimeout(overallTimer);
        const took = Date.now() - started;
        req.log?.info?.({ took, attempt, score, action: tp.action }, '[recaptcha] ok');
        return next();

      } catch (err) {
        lastErrorName = err?.name || 'Error';
        const isTimeout = lastErrorName === 'AbortError' || lastErrorName === 'TimeoutError';

        if (attempt < MAX_ATTEMPTS && isTimeout && !overall.signal.aborted) {
          await delay(RETRY_DELAY_MS, overall.signal);
          continue;
        }

        clearTimeout(overallTimer);
        const took = Date.now() - started;
        req.log?.warn?.({ took, attempt, err: lastErrorName, status: lastStatus }, '[recaptcha] error');

        if (process.env.RECAPTCHA_DEGRADE_ON_ERROR === '1') {
          req.recaptcha = { degraded: true, reason: isTimeout ? 'timeout' : 'error' };
          return next();
        }
        return res.status(503).json({ message: 'recaptcha_unavailable' });
      }
    }

    // Defensive fallback
    clearTimeout(overallTimer);
    const took = Date.now() - started;
    req.log?.warn?.({ took, status: lastStatus, err: lastErrorName }, '[recaptcha] exhausted');

    if (process.env.RECAPTCHA_DEGRADE_ON_ERROR === '1') {
      req.recaptcha = { degraded: true, reason: 'exhausted' };
      return next();
    }
    return res.status(503).json({ message: 'recaptcha_unavailable' });

  } catch (err) {
    const took = Date.now() - started;
    req.log?.warn?.({ took, err: err?.name || 'Error', msg: err?.message }, '[recaptcha] outer_error');

    if (process.env.RECAPTCHA_DEGRADE_ON_ERROR === '1') {
      req.recaptcha = { degraded: true, reason: 'outer_error' };
      return next();
    }
    return res.status(503).json({ message: 'recaptcha_unavailable' });
  }
}

module.exports = recaptchaVerify;
