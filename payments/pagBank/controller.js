// payments/pagBank/controller.js
'use strict';

const pagbankService = require('./service');
const pagbankRepository = require('./repository');
const birthchartRepository = require('../../modules/birthchart/repository');
const AppError = require('../../utils/appError');
const baseLogger = require('../../utils/logger').child('payments.pagbank.controller');

/**
 * Utility: echo a stable request id back to clients/proxies.
 */
function echoRequestId(req, res) {
  const rid =
    req.requestId ||
    req.get?.('x-request-id') ||
    req.get?.('x-correlation-id');

  if (rid) res.set('X-Request-Id', String(rid));
  return rid;
}

/**
 * POST /pagBank/checkout
 * Creates a PagBank hosted checkout.
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
      log.warn({ reason: 'missing_fields' }, 'invalid request');
      return res.status(400).json({
        error: 'invalid_request',
        details: 'requestId, productType and productValue are required.',
      });
    }

    const { url, checkoutId } = await pagbankService.createCheckout({
      requestId, name, email,
      productType, productValue,
      productName, paymentOptions,
      returnUrl, currency,
    }, { requestId: rid, log });

    return res.status(201).json({ url, checkoutId });
  } catch (err) {
    const wrapped = (err instanceof AppError)
      ? err
      : (err?.response
        ? AppError.fromPagBankResponse(err, 'create_checkout')
        : AppError.wrap(err, 'pagbank_checkout_failed'));

    (req.log || baseLogger).logError(err, {
      where: 'pagbank.controller.createCheckout',
      code: wrapped.code,
      status: wrapped.status,
    });

    return res.status(wrapped.status).json({
      error: wrapped.code || 'pagbank_checkout_failed',
      details: { context: 'pagbank', status: wrapped.status },
    });
  }
}

/**
 * GET /pagBank/return
 * Customer browser return after checkout.
 */
async function handleReturn(req, res) {
  const rid = echoRequestId(req, res);
  const log = (req.log || baseLogger).child('handleReturn', { rid });

  log.info('customer returned from PagBank checkout');

  const checkoutId = req.query.checkout_id || req.query.checkoutId || null;
  const status = String(req.query.status || '').toUpperCase();
  let requestId = req.query.request_id || req.query.requestId || null;

  try {
    if (!requestId && checkoutId && typeof pagbankRepository.findByCheckoutId === 'function') {
      const rec = await pagbankRepository.findByCheckoutId(checkoutId);
      requestId = rec?.request_id || requestId;
    }

    let productType = null;
    if (requestId && typeof birthchartRepository.findByRequestId === 'function') {
      const r = await birthchartRepository.findByRequestId(requestId);
      productType = r?.product_type || null;
    }

    const successUrlByProduct = {
      birth_chart: (id) =>
        `https://www.zodika.com.br/birthchart-payment-success?ref=${encodeURIComponent(id)}`,
    };
    const failUrl = 'https://www.zodika.com.br/payment-fail';
    const pendingUrl = 'https://www.zodika.com.br/payment-pending';

    if (status === 'APPROVED' || status === 'PAID') {
      if (!requestId) return res.redirect('https://www.zodika.com.br/payment-success');

      const resolver = successUrlByProduct[productType] || successUrlByProduct.birth_chart;
      return res.redirect(resolver(requestId));
    }

    if (status === 'PENDING') {
      return res.redirect(pendingUrl);
    }

    return res.redirect(failUrl);
  } catch (err) {
    (req.log || baseLogger).logError(err, { where: 'pagbank.controller.handleReturn' });
    return res.redirect('https://www.zodika.com.br/payment-fail');
  }
}

module.exports = {
  createCheckout,
  handleReturn,
};
