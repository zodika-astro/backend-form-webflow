// payments/pagBank/controller.js

const pagbankService = require('./service');
const pagbankRepository = require('./repository');
const birthchartRepository = require('../../modules/birthchart/repository');
const logger = require('../../utils/logger');
const { validateWebhookPayload } = require('./validators');

/**
* Starts checkout creation in PagBank (dynamic productName).
* Expected body (example):
* {
* requestId, name, email,
* productType, productValue, productName, // productValue in cents
* paymentOptions: { allow_pix: true, allow_card: true, max_installments: 1 },
* returnUrl, currency
* }
*/

async function createCheckout(req, res) {
  try {
    const {
      requestId, name, email,
      productType, productValue, productName,
      paymentOptions, returnUrl, currency
    } = req.body || {};

    if (!requestId || !productType || !productValue) {
      return res.status(400).json({ error: 'requestId, productType and productValue are required.' });
    }

    const { url, checkoutId } = await pagbankService.createCheckout({
      requestId, name, email,
      productType, productValue,
      productName, paymentOptions,
      returnUrl, currency
    });

    return res.status(201).json({ url, checkoutId });
  } catch (err) {
    const status = err?.response?.status && Number(err.response.status) >= 400 && Number(err.response.status) < 500
      ? err.response.status
      : 500;

    const details = err?.response?.data || { message: 'Unexpected error' };
    logger.error('[createCheckout] error', { status, details });

    return res.status(status).json({ error: 'pagbank_checkout_failed', details });
  }
}


/**
 * PagBank webhook (server-to-server).
 */
async function handleWebhook(req, res) {
  logger.info('Receiving webhook from PagBank.');
  try {
    const payload = req.body;

    try {
      validateWebhookPayload(payload);
    } catch (ve) {
      logger.warn('Invalid payload webhook (Zod):', ve.message);
    }

    const meta = {
      headers: req.headers,
      query: req.query,
      topic: req.query?.topic || null,
      action: req.query?.action || null,
    };

    await pagbankService.processWebhook(payload, meta);
  } catch (err) {
    logger.error('Fatal and unexpected error processing PagBank webhook:', err);
  } finally {
    res.status(200).send('OK');
  }
}

/**
* Customer return after checkout.
*/
async function handleReturn(req, res) {
  logger.info('Receiving feedback from customer after PagBank checkout.');

  const checkoutId = req.query.checkout_id || req.query.checkoutId || null;
  const status = (req.query.status || '').toUpperCase();
  let requestId = req.query.request_id || req.query.requestId || null;

  const failedStatuses = new Set(['CANCELED', 'FAILED', 'EXPIRED', 'REFUSED']);

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
      birth_chart: (id) => `https://www.zodika.com.br/birthchart-payment-success?ref=${encodeURIComponent(id)}`,
    };
    const failUrlByProduct = {
      birth_chart: (id, st) =>
        `https://www.zodika.com.br/birthchart-payment-fail?ref=${encodeURIComponent(id || '')}&status=${encodeURIComponent(st || '')}`,
    };

    if (failedStatuses.has(status)) {
      const failResolver = failUrlByProduct[productType] || failUrlByProduct.birth_chart;
      const failUrl = failResolver(requestId, status);
      logger.warn(`Payment failed (status=${status || 'UNKNOWN'}). Redirecting to: ${failUrl}`);
      return res.redirect(failUrl);
    }

    if (!requestId) {
      const genericFail = `https://www.zodika.com.br/payment-fail`;
      logger.warn('Returns no requestId — redirecting to generic failure.');
      return res.redirect(genericFail);
    }

    const successResolver = successUrlByProduct[productType] || successUrlByProduct.birth_chart;
    const finalUrl = successResolver(requestId);

    logger.info(`Redirecting client to success URL: ${finalUrl}`);
    return res.redirect(finalUrl);
  } catch (err) {
    logger.error('Error assembling redirect URL:', err);
    return res.redirect(`https://www.zodika.com.br/payment-fail`);
  }
}

module.exports = {
  createCheckout,
  handleWebhook,
  handleReturn,
};
