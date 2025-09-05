// payments/mercadoPago/controller.js
'use strict';

const mpService = require('./service');
const mpRepository = require('./repository');
const birthchartRepository = require('../../modules/birthchart/repository');
const AppError = require('../../utils/appError');
const baseLogger = require('../../utils/logger').child('payments.mp.controller');

/**
 * Utility: echo a single, stable request id back to clients/proxies.
 */
function echoRequestId(req, res) {
  const rid = req.requestId || req.get?.('x-request-id') || req.get?.('x-correlation-id');
  if (rid) res.set('X-Request-Id', String(rid));
  return rid;
}

/**
 * Normalize Mercado Pago "return status" from query string into a stable set.
 * Accepts multiple aliases used by MP (e.g., collection_status).
 */
function normalizeReturnStatus(qs = {}) {
  const raw =
    qs.status ||
    qs.collection_status ||
    qs.collectionStatus ||
    '';

  const up = String(raw).trim().toUpperCase();
  if (!up) return 'PENDING';

  const map = {
    APPROVED: 'APPROVED',
    SUCCESS: 'APPROVED',
    PAID: 'APPROVED',

    PENDING: 'PENDING',
    IN_PROCESS: 'PENDING',
    IN_MEDIATION: 'PENDING',

    REJECTED: 'REJECTED',
    REFUSED: 'REJECTED',

    CANCELLED: 'CANCELED',
    CANCELED: 'CANCELED',

    REFUNDED: 'REFUNDED',
    CHARGED_BACK: 'CHARGED_BACK',
    FAILED: 'FAILED',
    EXPIRED: 'EXPIRED',
  };

  return map[up] || 'PENDING';
}

/**
 * POST /mercadoPago/checkout  (optional internal API)
 * Creates a Mercado Pago checkout preference for a given request/product.
 * Notes:
 *  - Validates minimal inputs (requestId, productType, productValue).
 *  - Delegates to the service with a correlation-aware context.
 *  - Never logs PII (name/email) contents.
 */
async function createCheckout(req, res) {
  const rid = echoRequestId(req, res);
  const log = (req.log || baseLogger).child('createCheckout', { rid });

  try {
    const {
      requestId, name, email,
      productType, productValue, productName,
      paymentOptions, returnUrl, currency,
    } = req.body || {};

    if (!requestId || !productType || !productValue) {
      log.warn({ reason: 'missing_fields', hasRequestId: !!requestId, hasType: !!productType }, 'invalid request');
      return res.status(400).json({ error: 'invalid_request', details: 'requestId, productType and productValue are required.' });
    }

    const { url, preferenceId } = await mpService.createCheckout({
      requestId, name, email,
      productType, productValue,
      productName, paymentOptions,
      returnUrl, currency,
    }, { requestId: rid, log: req.log || baseLogger });

    return res.status(201).json({ url, preferenceId });
  } catch (err) {
    // Prefer AppError if thrown; otherwise map MP HTTP errors; otherwise wrap.
    const wrapped = (err instanceof AppError)
      ? err
      : (err?.response ? AppError.fromMPResponse(err, 'create_checkout') : AppError.wrap(err, 'mp_checkout_failed'));

    (req.log || baseLogger).logError(err, { where: 'mp.controller.createCheckout', code: wrapped.code, status: wrapped.status });

    return res.status(wrapped.status).json({
      error: wrapped.code || 'mp_checkout_failed',
      details: { context: 'mercadopago', status: wrapped.status },
    });
  }
}

/**
 * (Legacy) Mercado Pago webhook handler.
 * Prefer using `payments/mercadoPago/router.webhook.js`, which authenticates and
 * calls the service directly. This controller remains for compatibility.
 */
async function handleWebhook(req, res) {
  const rid = echoRequestId(req, res);
  const log = (req.log || baseLogger).child('handleWebhook', { rid });

  log.info('received webhook');

  try {
    const payload = req.body || {};
    const meta = {
      headers: { 'x-request-id': rid },
      query: req.query || {},
      topic: req.query?.topic || req.body?.type || undefined,
      action: req.body?.action || undefined,
    };

    await mpService.processWebhook(payload, meta, { requestId: rid, log: req.log || baseLogger });
    // Always 200 to avoid provider retry storms; service layer is idempotent.
    return res.status(200).json({ ok: true });
  } catch (err) {
    (req.log || baseLogger).logError(err, { where: 'mp.controller.handleWebhook' });
    // Still 200 to provider; internal issues are logged and reconciled later.
    return res.status(200).json({ ok: false });
  }
}

/**
 * GET /mercadoPago/return[/*]
 * Customer browser return after checkout (via MP back_urls).
 *
 * Rules:
 *  - Redirect to success only if:
 *      a) query status resolves to APPROVED, or
 *      b) database record for this preference shows APPROVED.
 *  - Otherwise, redirect to a fail page with the known status (or PENDING).
 *
 * Security:
 *  - Never trust or reflect arbitrary URLs from the query string.
 *  - Final redirects use fixed, allow-listed domains.
 */
async function handleReturn(req, res) {
  const rid = echoRequestId(req, res);
  const log = (req.log || baseLogger).child('handleReturn', { rid });

  log.info('customer returned from Mercado Pago checkout');

  const preferenceId = req.query.preference_id || req.query.preferenceId || null;
  let requestId = req.query.external_reference || req.query.request_id || req.query.requestId || null;

  // 1) Derive status from MP query parameters
  let retStatus = normalizeReturnStatus(req.query); // APPROVED | PENDING | REJECTED | CANCELED | ...

  try {
    // 2) If requestId is missing, try to fetch it by preferenceId
    if (!requestId && preferenceId && typeof mpRepository.findByPreferenceId === 'function') {
      const rec = await mpRepository.findByPreferenceId(preferenceId);
      requestId = rec?.request_id || requestId;

      // 3) If DB already shows APPROVED, we trust DB regardless of a vague query string
      if (rec?.status && typeof rec.status === 'string' && rec.status.toUpperCase() === 'APPROVED') {
        retStatus = 'APPROVED';
      }
    }

    // 4) Resolve product type to compose final public URL
    let productType = null;
    if (requestId && typeof birthchartRepository.findByRequestId === 'function') {
      const r = await birthchartRepository.findByRequestId(requestId);
      productType = r?.product_type || null;
    }

    const successUrlByProduct = {
      birth_chart: (id) => `https://www.zodika.com.br/birthchart-payment-success?ref=${encodeURIComponent(id)}`,
    };
    const failUrlByProduct = {
      birth_chart: (id, st) =>
        `https://www.zodika.com.br/birthchart-payment-fail?ref=${encodeURIComponent(id || '')}&status=${encodeURIComponent(st || '')}`,
    };

    // 5) Final decision
    const isApproved = retStatus === 'APPROVED';

    if (!isApproved) {
      // Failure/rejection/pending → redirect to fail (a future dedicated pending page could be added)
      const failResolver = failUrlByProduct[productType] || failUrlByProduct.birth_chart;

      if (!requestId) {
        const genericFail = 'https://www.zodika.com.br/payment-fail';
        log.warn({ retStatus }, 'non-approved status and no requestId; redirecting to generic fail');
        return res.redirect(genericFail);
      }

      const failUrl = failResolver(requestId, retStatus);
      log.warn({ retStatus, requestId }, 'non-approved status; redirecting to fail');
      return res.redirect(failUrl);
    }

    // Success
    if (!requestId) {
      const genericSuccess = 'https://www.zodika.com.br/payment-success';
      log.info('approved but requestId missing; redirecting to generic success');
      return res.redirect(genericSuccess);
    }

    const successResolver = successUrlByProduct[productType] || successUrlByProduct.birth_chart;
    const finalUrl = successResolver(requestId);
    log.info({ requestId }, 'redirecting to success URL');
    return res.redirect(finalUrl);
  } catch (err) {
    (req.log || baseLogger).logError(err, { where: 'mp.controller.handleReturn' });
    return res.redirect('https://www.zodika.com.br/payment-fail');
  }
}

module.exports = {
  createCheckout,
  handleWebhook,
  handleReturn,
};
