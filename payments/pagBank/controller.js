// payments/pagBank/controller.js
'use strict';

const pagbankService = require('./service');
const pagbankRepository = require('./repository');
const birthchartRepository = require('../../modules/birthchart/repository');
const AppError = require('../../utils/appError');
const baseLogger = require('../../utils/logger').child('payments.pagbank.controller');
const { validateWebhookPayload } = require('./validators');

/**
 * Utility: echo a single, stable request id back to clients/proxies.
 */
function echoRequestId(req, res) {
  const rid = req.requestId || req.get?.('x-request-id') || req.get?.('x-correlation-id');
  if (rid) res.set('X-Request-Id', String(rid));
  return rid;
}

/**
 * POST /pagBank/checkout  (optional internal API)
 * Creates a PagBank hosted checkout for a given request/product.
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

    const { url, checkoutId } = await pagbankService.createCheckout({
      requestId, name, email,
      productType, productValue,
      productName, paymentOptions,
      returnUrl, currency,
    }, { requestId: rid, log: req.log || baseLogger });

    return res.status(201).json({ url, checkoutId });
  } catch (err) {
    // Prefer AppError if thrown; otherwise map PagBank HTTP errors; otherwise wrap.
    const wrapped = (err instanceof AppError)
      ? err
      : (err?.response ? AppError.fromPagBankResponse(err, 'create_checkout') : AppError.wrap(err, 'pagbank_checkout_failed'));

    (req.log || baseLogger).logError(err, { where: 'pagbank.controller.createCheckout', code: wrapped.code, status: wrapped.status });

    return res.status(wrapped.status).json({
      error: wrapped.code || 'pagbank_checkout_failed',
      details: { context: 'pagbank', status: wrapped.status },
    });
  }
}

/**
 * (Legacy) PagBank webhook controller.
 * Prefer using `payments/pagBank/router.webhook.js`, which authenticates and
 * calls the service directly. This remains for compatibility.
 */
async function handleWebhook(req, res) {
  const rid = echoRequestId(req, res);
  const log = (req.log || baseLogger).child('handleWebhook', { rid });

  log.info('received webhook');

  try {
    const payload = req.body || {};

    // Best-effort payload validation (never blocks delivery).
    try {
      validateWebhookPayload?.(payload);
    } catch (ve) {
      log.warn({ msg: ve?.message || 'validation error' }, 'webhook payload failed validation (non-fatal)');
    }

    const meta = {
      headers: { 'x-request-id': rid },
      query: req.query || {},
      topic: req.query?.topic || payload?.type || undefined,
      action: req.query?.action || payload?.action || undefined,
    };

    await pagbankService.processWebhook(payload, meta, { requestId: rid, log: req.log || baseLogger });
    // Always 200 to avoid provider retry storms; service layer is idempotent.
    return res.status(200).json({ ok: true });
  } catch (err) {
    (req.log || baseLogger).logError(err, { where: 'pagbank.controller.handleWebhook' });
    // Still 200 to provider; internal issues are logged and reconciled later.
    return res.status(200).json({ ok: false });
  }
}

/**
 * GET /pagBank/return
 * Customer browser return after checkout.
 *
 * Rules:
 *  - If the provider indicates a terminal failure (CANCELED/FAILED/EXPIRED/REFUSED),
 *    redirect to the product-specific fail page with the status.
 *  - Otherwise, try to resolve the requestId and redirect to success.
 *
 * Security:
 *  - Never trust or reflect arbitrary URLs from the query string.
 *  - Final redirects use fixed, allow-listed domains.
 */
async function handleReturn(req, res) {
  const rid = echoRequestId(req, res);
  const log = (req.log || baseLogger).child('handleReturn', { rid });

  log.info('customer returned from PagBank checkout');

  const checkoutId = req.query.checkout_id || req.query.checkoutId || null;
  const status = String(req.query.status || '').toUpperCase();
  let requestId = req.query.request_id || req.query.requestId || null;

  const failedStatuses = new Set(['CANCELED', 'FAILED', 'EXPIRED', 'REFUSED']);

  try {
    // Resolve requestId via DB if missing.
    if (!requestId && checkoutId && typeof pagbankRepository.findByCheckoutId === 'function') {
      const rec = await pagbankRepository.findByCheckoutId(checkoutId);
      requestId = rec?.request_id || requestId;
    }

    // Resolve product type to compose final public URL.
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

    if (failedStatuses.has(status)) {
      const failResolver = failUrlByProduct[productType] || failUrlByProduct.birth_chart;
      const failUrl = failResolver(requestId, status);
      log.warn({ status, requestId }, 'payment returned as failed; redirecting to fail');
      return res.redirect(failUrl);
    }

    if (!requestId) {
      const genericFail = 'https://www.zodika.com.br/payment-fail';
      log.warn('missing requestId; redirecting to generic failure');
      return res.redirect(genericFail);
    }

    const successResolver = successUrlByProduct[productType] || successUrlByProduct.birth_chart;
    const finalUrl = successResolver(requestId);

    log.info({ requestId }, 'redirecting client to success URL');
    return res.redirect(finalUrl);
  } catch (err) {
    (req.log || baseLogger).logError(err, { where: 'pagbank.controller.handleReturn' });
    return res.redirect('https://www.zodika.com.br/payment-fail');
  }
}

module.exports = {
  createCheckout,
  handleWebhook,
  handleReturn,
};
