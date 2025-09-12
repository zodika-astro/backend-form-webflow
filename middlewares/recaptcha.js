// middlewares/recaptcha.js
'use strict';
const { fetch } = require('undici');

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const SECRET = process.env.RECAPTCHA_SECRET; // segredo da chave v3 "classic"
const MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);
const EXPECT_ACTION = process.env.RECAPTCHA_EXPECT_ACTION || ''; // opcional

// hard caps pra SLA: 2.5s, 0 retries
const HTTP_TIMEOUT_MS = Number(process.env.RECAPTCHA_HTTP_TIMEOUT_MS || 2500);

function anySignal(signals) {
  // AbortSignal.any em Node 18+; deixe assim se sua runtime já suporta
  return AbortSignal.any ? AbortSignal.any(signals) : signals.find(s => s);
}

async function recaptchaVerify(req, res, next) {
  const started = Date.now();
  try {
    const token  = req.body?.recaptcha_token;
    const action = req.body?.recaptcha_action;

    if (!SECRET) return res.status(500).json({ message: 'recaptcha_misconfigured' });
    if (!token)  return res.status(400).json({ message: 'recaptcha_missing_token' });

    // constrói o corpo form-urlencoded
    const body = new URLSearchParams();
    body.set('secret', SECRET);
    body.set('response', token);
    // (opcional) ajuda na avaliação:
    if (req.ip) body.set('remoteip', req.ip);

    // cancela em 2.5s ou se o cliente desconectar
    const signal = anySignal([
      AbortSignal.timeout(HTTP_TIMEOUT_MS),
      req.clientAbortSignal // vindo do seu diag.js
    ]);

    const r = await fetch(VERIFY_URL, { method: 'POST', body, signal });
    const json = await r.json();

    const took = Date.now() - started;
    req.log?.info?.({ took, score: json.score, success: json.success, action: json.action, codes: json['error-codes'] }, '[recaptcha] verify');

    if (!json.success) {
      // falha "dura" (token inválido etc.) → 429
      return res.status(429).json({ message: 'recaptcha_failed', codes: json['error-codes'] || [] });
    }

    if (EXPECT_ACTION && json.action && json.action !== EXPECT_ACTION) {
      return res.status(429).json({ message: 'recaptcha_action_mismatch' });
    }

    if (json.score != null && Number(json.score) < MIN_SCORE) {
      return res.status(429).json({ message: 'recaptcha_low_score', score: json.score });
    }

    // ok — segue
    return next();
  } catch (err) {
    const took = Date.now() - started;
    req.log?.warn?.({ took, err: err?.message }, '[recaptcha] error');
    // tempo excedido / indisponível → 503 (falha "mole": você decide se quer bloquear ou degradar)
    if (err.name === 'AbortError') {
      return res.status(503).json({ message: 'recaptcha_unavailable' });
    }
    return next(err);
  }
}

module.exports = recaptchaVerify;
