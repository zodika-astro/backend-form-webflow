// payments/pagBank/controller.js

const pagbankService = require('./service');
const pagbankRepository = require('./repository'); 
const birthchartRepository = require('../../modules/birthchart/repository');
const logger = require('../../utils/logger');
const { validateWebhookPayload } = require('./validators');

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
      topic: req.query?.topic,
      action: req.query?.action,
    };

    await pagbankService.processWebhook(payload, meta);
  } catch (err) {
    logger.error('Fatal and unexpected error processing PagBank webhook:', err);
  } finally {
    
    res.status(200).send('OK');
  }
}

/**
 * Retorno do cliente após o checkout (apenas se o redirect_url apontar para o backend).
 * Se você redireciona direto para o FRONT, esta rota não é utilizada.
 */
async function handleReturn(req, res) {
  logger.info('Recebendo retorno do cliente após checkout do PagBank.');

  const checkoutId = req.query.checkout_id || req.query.checkoutId || null;
  const status = (req.query.status || '').toUpperCase();
  let requestId = req.query.request_id || req.query.requestId || null;

  // Status de falha conhecidos
  const failedStatuses = new Set(['CANCELED', 'FAILED', 'EXPIRED', 'REFUSED']);

  try {
    // 1) Se não veio requestId na URL, tenta inferir pelo checkoutId salvo
    if (!requestId && checkoutId && typeof pagbankRepository.findByCheckoutId === 'function') {
      const rec = await pagbankRepository.findByCheckoutId(checkoutId);
      requestId = rec?.request_id || requestId;
    }

    // 2) Buscar product_type pelo requestId (se possível)
    let productType = null;
    if (requestId && typeof birthchartRepository.findByRequestId === 'function') {
      const r = await birthchartRepository.findByRequestId(requestId);
      productType = r?.product_type || null;
    }

    // 3) URLs por produto (sucesso e falha)
    const successUrlByProduct = {
      birth_chart: (id) => `https://www.zodika.com.br/birthchart-payment-success?ref=${encodeURIComponent(id)}`,
    };
    const failUrlByProduct = {
      birth_chart: (id, st) =>
        `https://www.zodika.com.br/birthchart-payment-fail?ref=${encodeURIComponent(id || '')}&status=${encodeURIComponent(st || '')}`,
    };

    // 4) Se falhou, redireciona para a página de falha do produto
    if (failedStatuses.has(status)) {
      const failResolver = failUrlByProduct[productType] || failUrlByProduct.birth_chart;
      const failUrl = failResolver(requestId, status);
      logger.warn(`Pagamento falhou (status=${status || 'UNKNOWN'}). Redirecionando para: ${failUrl}`);
      return res.redirect(failUrl);
    }

    // 5) Sucesso: precisamos do requestId. Se não houver, falha genérica.
    if (!requestId) {
      const genericFail = `https://www.zodika.com.br/payment-fail`;
      logger.warn('Retorno sem requestId — redirecionando para falha genérica.');
      return res.redirect(genericFail);
    }

    const successResolver = successUrlByProduct[productType] || successUrlByProduct.birth_chart;
    const finalUrl = successResolver(requestId);

    logger.info(`Redirecionando cliente para a URL de sucesso: ${finalUrl}`);
    return res.redirect(finalUrl);
  } catch (err) {
    logger.error('Erro ao montar a URL de redirecionamento:', err);
    return res.redirect(`https://www.zodika.com.br/payment-fail`);
  }
}

module.exports = {
  createCheckoutSession,
  handleWebhook,
  handleReturn,
};
