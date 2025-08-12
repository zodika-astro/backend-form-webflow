// payments/pagBank/controller.js
const pagbankService = require('./service');
const pagbankRepository = require('./repository'); // usado p/ fallback por checkoutId se precisar
const birthchartRepository = require('../../modules/birthchart/repository'); // p/ obter product_type por requestId
const logger = require('../../utils/logger');
const { validateWebhookPayload } = require('./validators');

/**
 * Controller responsável por iniciar um checkout.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function createCheckoutSession(req, res) {
  logger.info('Iniciando requisição para criar um checkout do PagBank.');
  try {
    const {
      requestId,
      name,
      email,
      productType,
      productValue,
      paymentOptions
    } = req.body;

    if (!requestId || !productValue || !email) {
      logger.error('Erro de validação: Campos obrigatórios ausentes na requisição de checkout.');
      return res.status(400).json({ error: 'Campos requestId, productValue e email são obrigatórios.' });
    }

    const productValueInt = Number(productValue);
    if (!Number.isInteger(productValueInt) || productValueInt <= 0) {
      logger.error('Erro de validação: productValue deve ser inteiro em centavos (> 0).');
      return res.status(400).json({ error: 'productValue deve ser inteiro em centavos (> 0).' });
    }

    const checkoutResult = await pagbankService.createCheckout({
      requestId,
      name,
      email,
      productType,
      productValue: productValueInt,
      paymentOptions,
    });

    logger.info(`Checkout PagBank criado com sucesso. ID: ${checkoutResult.checkoutId}`);
    return res.status(201).json(checkoutResult);
  } catch (err) {
    logger.error('Erro inesperado ao criar checkout do PagBank:', err);
    return res.status(500).json({ error: 'Erro interno do servidor ao criar o checkout.' });
  }
}

/**
 * Processa webhooks do PagBank (sempre 200 OK para evitar retries)
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleWebhook(req, res) {
  logger.info('Recebendo webhook do PagBank.');
  try {
    const payload = req.body;

    try {
      validateWebhookPayload(payload);
    } catch (ve) {
      logger.warn('Webhook payload inválido (Zod):', ve.message);
    }

    const meta = {
      headers: req.headers,
      query: req.query,
      topic: req.query?.topic,
      action: req.query?.action,
    };

    await pagbankService.processWebhook(payload, meta);
  } catch (err) {
    logger.error('Erro fatal e inesperado ao processar o webhook do PagBank:', err);
  } finally {
    res.status(200).send('OK');
  }
}

/**
 * Lida com o retorno do cliente após o checkout.
 * PagBank -> /pagBank/pagbank/return -> redireciona para sucesso/erro.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleReturn(req, res) {
  logger.info('Recebendo retorno do cliente após checkout do PagBank.');

  const checkoutId = req.query.checkout_id || req.query.checkoutId || null;
  const status = (req.query.status || '').toUpperCase();
  let requestId = req.query.request_id || req.query.requestId || null;

  const PAYMENT_FAIL_URL = 'https://www.zodika.com.br/payment-fail';
  const failedStatuses = new Set(['CANCELED', 'FAILED', 'EXPIRED', 'REFUSED']);

  if (failedStatuses.has(status)) {
    logger.warn(`Pagamento do checkout ${checkoutId || '-'} falhou com status ${status}. Redirecionando para a página de falha.`);
    return res.redirect(PAYMENT_FAIL_URL);
  }

  try {
    // 1) Se não veio requestId na URL, tenta inferir pelo checkoutId salvo
    if (!requestId && checkoutId && typeof pagbankRepository.findByCheckoutId === 'function') {
      const rec = await pagbankRepository.findByCheckoutId(checkoutId);
      requestId = rec?.request_id || requestId;
    }

    if (!requestId) {
      logger.warn('Retorno do PagBank sem requestId e sem possibilidade de inferir — fallback falha.');
      return res.redirect(PAYMENT_FAIL_URL);
    }

    // 2) Buscar o product_type com base no requestId (neste momento via módulo birthchart)
    let productType = null;
    if (typeof birthchartRepository.findByRequestId === 'function') {
      const r = await birthchartRepository.findByRequestId(requestId);
      productType = r?.product_type || null;
    }

    // 3) Mapeamento centralizado product_type -> função geradora da URL
    const successUrlByProduct = {
      birthchart: (id) => `https://www.zodika.com.br/birthchart-payment-success?request=${encodeURIComponent(id)}`,

      // Exemplos futuros:
      // synastry:   (id) => `https://www.zodika.com.br/synastry-payment-success?request=${encodeURIComponent(id)}`,
      // transit:    (id) => `https://www.zodika.com.br/transit-payment-success?request=${encodeURIComponent(id)}`,
      // composite:  (id) => `https://www.zodika.com.br/composite-payment-success?request=${encodeURIComponent(id)}`,
    };

    // 4) Resolve finalUrl: se não reconhecer product_type, usa birthchart como padrão
    const resolver = successUrlByProduct[productType] || successUrlByProduct.birthchart;
    const finalUrl = resolver(requestId);

    logger.info(`Redirecionando cliente para a URL de sucesso: ${finalUrl}`);
    return res.redirect(finalUrl);
  } catch (err) {
    logger.error('Erro ao montar a URL de redirecionamento de sucesso:', err);
    return res.redirect(PAYMENT_FAIL_URL);
  }
}

module.exports = {
  createCheckoutSession,
  handleWebhook,
  handleReturn,
};

