// payments/mercadoPago/controller.js
'use strict';

const mpService = require('./service');
const mpRepository = require('./repository');
const birthchartRepository = require('../../modules/birthchart/repository');
const AppError = require('../../utils/appError');
const baseLogger = require('../../utils/logger').child('payments.mp.controller');

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
 * Normalize Mercado Pago "return status" from query string into a stable set.
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
 * Server-side email masking (never expose raw PII on redirects).
 * Keeps first 1–2 characters of the user, masks the rest;
 * masks domain parts except TLD boundary (e.g., g****@g****.com).
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '';
  const [user, domain] = email.split('@');
  const head = user.length <= 2 ? (user[0] || '') : user.slice(0, 2);
  const maskedUser = head + '*'.repeat(Math.max(0, user.length - head.length));
  const maskedDomain = domain.replace(/.(?=.*\.)/g, '*');
  return `${maskedUser}@${maskedDomain}`;
}

/**
 * POST /mercadoPago/checkout
 * Creates a Mercado Pago checkout preference.
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

    const { url, preferenceId } = await mpService.createCheckout({
      requestId, name, email,
      productType, productValue,
      productName, paymentOptions,
      returnUrl, currency,
    }, { requestId: rid, log });

    return res.status(201).json({ url, preferenceId });
  } catch (err) {
    const wrapped = (err instanceof AppError)
      ? err
      : (err?.response
        ? AppError.fromMPResponse(err, 'create_checkout')
        : AppError.wrap(err, 'mp_checkout_failed'));

    (req.log || baseLogger).logError(err, {
      where: 'mp.controller.createCheckout',
      code: wrapped.code,
      status: wrapped.status,
    });

    return res.status(wrapped.status).json({
      error: wrapped.code || 'mp_checkout_failed',
      details: { context: 'mercadopago', status: wrapped.status },
    });
  }
}

/**
 * GET /mercadoPago/return[/*]
 * Customer browser return after checkout.
 *
 * Behavior:
 * - Resolve requestId (from QS or repository).
 * - Map return status to a stable set.
 * - Redirect to product-specific success on APPROVED/PAID, appending:
 *   * Query:   ?ref=<requestId>
 *   * Fragment: #em=<maskedEmail>  (optional, best-effort; not logged by servers)
 * - Redirect to generic pending/fail otherwise.
 */
async function handleReturn(req, res) {
  const rid = echoRequestId(req, res);
  const log = (req.log || baseLogger).child('handleReturn', { rid });

  log.info('customer returned from Mercado Pago checkout');

  const preferenceId =
    req.query.preference_id || req.query.preferenceId || null;

  // novo: pegue o id do pagamento (varia por conta/legado)
  const paymentId =
    req.query.payment_id ||
    req.query.collection_id ||
    req.query.collectionId ||
    null;

  // try several ids Mercado Pago may send back
  let requestId =
    req.query.external_reference ||
    req.query.request_id ||
    req.query.requestId ||
    req.query.merchant_order_id ||
    req.query.collection_id ||
    req.query.payment_id ||
    null;

  let retStatus = normalizeReturnStatus(req.query);

  try {
    if (!requestId && preferenceId && typeof mpRepository.findByPreferenceId === 'function') {
      const rec = await mpRepository.findByPreferenceId(preferenceId);
      requestId = rec?.request_id || requestId;
      if (rec?.status && String(rec.status).toUpperCase() === 'APPROVED') {
        retStatus = 'APPROVED';
      }
    }

    let productType = null;
    let emailMasked = '';
    if (requestId && typeof birthchartRepository.findByRequestId === 'function') {
      const r = await birthchartRepository.findByRequestId(requestId);
      productType = r?.product_type || null;
      if (r?.email) emailMasked = maskEmail(String(r.email));
    }

    const successUrlByProduct = {
      birth_chart: (id) =>
        `https://www.zodika.com.br/birthchart-payment-success?ref=${encodeURIComponent(id)}`,
    };
    const failUrl = 'https://www.zodika.com.br/payment-fail';
    const pendingUrl = 'https://www.zodika.com.br/payment-pending';

    if (retStatus === 'APPROVED' || retStatus === 'PAID') {
      if (!requestId) return res.redirect('https://www.zodika.com.br/payment-success');

      const resolver = successUrlByProduct[productType] || successUrlByProduct.birth_chart;

      // use URL para anexar payment_id antes do fragment
      const u = new URL(resolver(requestId));
      if (paymentId) u.searchParams.set('payment_id', String(paymentId));

      const finalUrl = emailMasked
        ? `${u.toString()}#em=${encodeURIComponent(emailMasked)}`
        : u.toString();

      return res.redirect(finalUrl);
    }

    if (retStatus === 'PENDING') {
      let target = new URL(pendingUrl);
      if (requestId) target.searchParams.set('ref', String(requestId));
      if (paymentId) target.searchParams.set('payment_id', String(paymentId));
      if (emailMasked) target.hash = `em=${encodeURIComponent(emailMasked)}`;
      return res.redirect(target.toString());
    }

    return res.redirect(failUrl);
  } catch (err) {
    (req.log || baseLogger).logError(err, { where: 'mp.controller.handleReturn' });
    return res.redirect('https://www.zodika.com.br/payment-fail');
  }
}


module.exports = {
  createCheckout,
  handleReturn,
};
