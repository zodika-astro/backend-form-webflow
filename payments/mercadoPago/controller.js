// payments/mercadoPago/controller.js

const mpService = require('./service');
const mpRepository = require('./repository');
const birthchartRepository = require('../../modules/birthchart/repository');
const logger = require('../../utils/logger');

/**
 * Starts checkout creation in Mercado Pago (dynamic productName).
 * Expected body (example):
 * {
 *   requestId, name, email,
 *   productType, productValue, productName, // productValue in cents
 *   paymentOptions: { allow_pix: true, allow_card: true, max_installments: 1 },
 *   returnUrl, currency
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

    const { url, preferenceId } = await mpService.createCheckout({
      requestId, name, email,
      productType, productValue,
      productName, paymentOptions,
      returnUrl, currency
    });

    return res.status(201).json({ url, preferenceId });
  } catch (err) {
    const status = err?.response?.status && Number(err.response.status) >= 400 && Number(err.response.status) < 500
      ? err.response.status
      : 500;

    const details = err?.response?.data || { message: 'Unexpected error' };
    logger.error('[MP][createCheckout] error', { status, details });

    return res.status(status).json({ error: 'mp_checkout_failed', details });
  }
}

/**
 * Mercado Pago webhook (server-to-server).
 */
async function handleWebhook(req, res) {
  logger.info('Receiving webhook from Mercado Pago.');
  try {
    const payload = req.body;

    // (Se quiser Zod aqui no futuro, seguimos o mesmo padrão do PagBank)
    const meta = {
      headers: req.headers,
      query: req.query,
      topic: req.query?.topic || req.body?.type || null,
      action: req.body?.action || null,
    };

    await mpService.processWebhook(payload, meta);
  } catch (err) {
    logger.error('Fatal and unexpected error processing Mercado Pago webhook:', err);
  } finally {
    // 200 rápido para evitar re-tentativas agressivas
    res.status(200).send('OK');
  }
}

/**
 * Customer return after checkout.
 * (via back_urls ou manual /return)
 */
async function handleReturn(req, res) {
  logger.info('Receiving feedback from customer after Mercado Pago checkout.');

  const preferenceId = req.query.preference_id || req.query.preferenceId || null;
  const status = (req.query.status || '').toUpperCase();
  let requestId = req.query.external_reference || req.query.request_id || req.query.requestId || null;

  const failedStatuses = new Set(['CANCELED', 'FAILED', 'EXPIRED', 'REFUSED', 'REJECTED']);

  try {
    if (!requestId && preferenceId && typeof mpRepository.findByPreferenceId === 'function') {
      const rec = await mpRepository.findByPreferenceId(preferenceId);
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
    logger.error('[MP] Error assembling redirect URL:', err);
    return res.redirect(`https://www.zodika.com.br/payment-fail`);
  }
}

module.exports = {
  createCheckout,
  handleWebhook,
  handleReturn,
};
