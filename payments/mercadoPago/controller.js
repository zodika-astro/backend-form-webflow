// payments/mercadoPago/controller.js

const mpService = require('./service');
const mpRepository = require('./repository');
const birthchartRepository = require('../../modules/birthchart/repository');
const logger = require('../../utils/logger');

/**
 * Starts checkout creation in Mercado Pago (dynamic productName).
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

/** Normaliza status vindo no return do MP */
function normalizeReturnStatus(qs = {}) {
  const raw =
    qs.status ||
    qs.collection_status ||      // MP usa muito este
    qs.collectionStatus ||
    '';

  const up = String(raw).trim().toUpperCase();

  if (!up) return 'PENDING'; // ausência de status não é sucesso

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
 * Customer return after checkout.
 * (via back_urls do MP)
 *
 * Regras:
 *  - Só redireciona para sucesso se:
 *     a) status do query == APPROVED, ou
 *     b) o registro em mp_request (preference_id) já estiver APPROVED.
 *  - Em qualquer outro caso, redireciona para FAIL com o status conhecido (ou PENDING).
 */
async function handleReturn(req, res) {
  logger.info('Receiving feedback from customer after Mercado Pago checkout.');

  const preferenceId = req.query.preference_id || req.query.preferenceId || null;
  let requestId = req.query.external_reference || req.query.request_id || req.query.requestId || null;

  // 1) Tentar inferir status pelo querystring do MP
  let retStatus = normalizeReturnStatus(req.query); // APPROVED | PENDING | REJECTED | CANCELED | ...

  try {
    // 2) Completar requestId via banco, se não veio no query
    if (!requestId && preferenceId && typeof mpRepository.findByPreferenceId === 'function') {
      const rec = await mpRepository.findByPreferenceId(preferenceId);
      requestId = rec?.request_id || requestId;

      // 3) Se o banco já marcou APPROVED, consideramos sucesso mesmo que o query esteja vazio/ambíguo
      if (rec?.status && typeof rec.status === 'string') {
        const dbStatus = rec.status.toUpperCase();
        if (dbStatus === 'APPROVED') retStatus = 'APPROVED';
      }
    }

    // 4) Descobrir productType para montar URL final
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

    // 5) Decisão final
    const isApproved = retStatus === 'APPROVED';

    if (!isApproved) {
      // Falha, rejeição ou pendência → ir para FAIL (você pode criar uma página "pending" futuramente)
      const failResolver = failUrlByProduct[productType] || failUrlByProduct.birth_chart;

      // Se não temos requestId, mandar para fail genérico
      if (!requestId) {
        const genericFail = `https://www.zodika.com.br/payment-fail`;
        logger.warn(`[MP][return] Non-approved status (${retStatus}) and no requestId. Redirecting to generic fail: ${genericFail}`);
        return res.redirect(genericFail);
      }

      const failUrl = failResolver(requestId, retStatus);
      logger.warn(`[MP][return] Non-approved status (${retStatus}). Redirecting to: ${failUrl}`);
      return res.redirect(failUrl);
    }

    // Sucesso
    if (!requestId) {
      const genericSuccess = `https://www.zodika.com.br/payment-success`; // fallback raro
      logger.info(`[MP][return] Approved but no requestId. Redirecting to generic success: ${genericSuccess}`);
      return res.redirect(genericSuccess);
    }

    const successResolver = successUrlByProduct[productType] || successUrlByProduct.birth_chart;
    const finalUrl = successResolver(requestId);
    logger.info(`[MP][return] Redirecting client to success URL: ${finalUrl}`);
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
