// middlewares/recaptcha.js (trechos relevantes alterados)
function recaptchaVerify({ minScore = DEFAULT_MIN_SCORE, timeoutMs = 3000 } = {}) {
  return async function recaptchaVerifyMiddleware(req, res, next) {
    const mark = res.locals._mark || (()=>{});
    mark('rcv-start');

    // bypass dev
    if (String(process.env.RECAPTCHA_BYPASS).toLowerCase() === 'true') {
      req.recaptcha = { success: true, bypass: true };
      mark('rcv-bypass');
      return next();
    }

    const secret = process.env.RECAPTCHA_SECRET;
    if (!secret) {
      mark('rcv-misconfig');
      return res.status(500).json({ error: 'recaptcha_misconfigured', message: 'Server reCAPTCHA secret not configured' });
    }

    const token = pickCaptchaToken(req.body || {});
    if (!token) {
      mark('rcv-missing');
      return res.status(400).json({ error: 'recaptcha_missing', message: 'reCAPTCHA token is missing' });
    }

    try {
      const remoteip = getClientIp(req);
      mark('rcv-call');
      const { ok, data } = await verifyWithGoogle({ secret, response: token, remoteip, timeoutMs });
      mark('rcv-done');

      if (!ok) {
        return res.status(400).json({ error: 'recaptcha_unavailable', message: 'reCAPTCHA verification unavailable, please try again' });
      }

      const norm = normalizeGoogleResponse(data);
      if (!norm.success) {
        return res.status(400).json({ error: 'recaptcha_failed', message: 'reCAPTCHA verification failed' });
      }
      if (Number.isFinite(norm.score) && norm.score < Number(minScore)) {
        return res.status(400).json({ error: 'recaptcha_low_score', message: 'reCAPTCHA score too low', details: { score: norm.score } });
      }

      const expectedAction = (req.body?.recaptcha_action || process.env.RECAPTCHA_EXPECT_ACTION);
      if (expectedAction && norm.action && String(norm.action) !== String(expectedAction)) {
        return res.status(400).json({ error: 'recaptcha_action_mismatch', message: 'reCAPTCHA action mismatch', details: { expected: String(expectedAction), got: String(norm.action) } });
      }

      const expectHost = process.env.RECAPTCHA_EXPECT_HOST;
      if (expectHost && norm.hostname && String(norm.hostname) !== String(expectHost)) {
        return res.status(400).json({ error: 'recaptcha_hostname_mismatch', message: 'reCAPTCHA hostname mismatch' });
      }

      req.recaptcha = { success: true, mode: MODE, score: norm.score, action: norm.action, timestamp: norm.challenge_ts, hostname: norm.hostname, remoteip };
      mark('rcv-ok');
      return next();
    } catch (err) {
      const isAbort = err?.name === 'AbortError';
      return res.status(400).json({ error: isAbort ? 'recaptcha_timeout' : 'recaptcha_error', message: isAbort ? 'reCAPTCHA verification timed out' : 'reCAPTCHA verification error' });
    }
  };
}
