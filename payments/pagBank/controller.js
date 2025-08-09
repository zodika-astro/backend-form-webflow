// payments/pagBank/controller.js
const pagbankService = require('./service');
const logger = require('../../utils/logger');

/**
 * Controller responsável por iniciar um checkout.
 * O nome da função foi melhorado de 'createCheckout' para 'createCheckoutSession'
 * para ser mais descritivo e evitar confusão com a função do service.
 * @param {import('express').Request} req - Objeto de requisição do Express
 * @param {import('express').Response} res - Objeto de resposta do Express
 */
async function createCheckoutSession(req, res) {
  logger.info('Iniciando requisição para criar um checkout do PagBank.');
  try {
    const { requestId, name, email, productType, productValue, redirectUrl, paymentOptions } = req.body;

    // Validação de entrada para 'fail fast'.
    if (!requestId || !productValue || !email) {
      logger.error('Erro de validação: Campos obrigatórios ausentes na requisição de checkout.');
      return res.status(400).json({ error: 'Campos requestId, productValue e email são obrigatórios.' });
    }

    // Chama a camada de serviço para criar o checkout e obter o link de pagamento.
    const checkoutResult = await pagbankService.createCheckout({
      requestId,
      name,
      email,
      productType,
      productValue,
      redirectUrl,
      paymentOptions,
    });

    // Responde com status 201 Created e os dados do checkout.
    logger.info(`Checkout PagBank criado com sucesso. ID: ${checkoutResult.checkoutId}`);
    return res.status(201).json(checkoutResult);
  } catch (err) {
    logger.error('Erro inesperado ao criar checkout do PagBank:', err);
    // Em caso de erro, responde com um erro interno do servidor.
    return res.status(500).json({ error: 'Erro interno do servidor ao criar o checkout.' });
  }
}

/**
 * Controller responsável por processar webhooks do PagBank.
 * O design do service.js já prevê que esta função sempre responda 200 OK
 * para evitar re-tentativas do PagBank, mesmo em caso de erro interno no processamento.
 * @param {import('express').Request} req - Objeto de requisição do Express
 * @param {import('express').Response} res - Objeto de resposta do Express
 */
async function handleWebhook(req, res) {
  logger.info('Recebendo webhook do PagBank.');
  try {
    const payload = req.body;
    const meta = {
      headers: req.headers,
      query: req.query,
      topic: req.query.topic, // Assumindo que o tópico vem na query, conforme PagBank V4
    };

    // O service encapsula toda a lógica de processamento, idempotência e log.
    const result = await pagbankService.processWebhook(payload, meta);

    if (!result.ok) {
      // Se houver um erro de processamento, apenas o logamos.
      logger.error('Processamento do webhook falhou, mas respondendo 200 OK para evitar re-tentativas.');
    } else if (result.duplicate) {
      logger.info('Webhook duplicado recebido e processado, respondendo 200 OK.');
    } else {
      logger.info('Webhook processado com sucesso. Respondendo 200 OK.');
    }
  } catch (err) {
    // Este catch é uma camada de segurança extra.
    logger.error('Erro fatal e inesperado ao processar o webhook do PagBank:', err);
  } finally {
    // A resposta 200 OK é crítica para o fluxo de webhooks do PagBank.
    res.status(200).send('OK');
  }
}

/**
 * Controller responsável por lidar com o retorno do cliente após o pagamento.
 * Esta rota é chamada pelo navegador do usuário e geralmente é usada para
 * direcionar o usuário para uma página de sucesso ou de status.
 *
 * @param {import('express').Request} req - Objeto de requisição do Express
 * @param {import('express').Response} res - Objeto de resposta do Express
 */
async function handleReturn(req, res) {
  logger.info('Recebendo retorno do cliente após checkout do PagBank.');

  const checkoutId = req.query.checkout_id;
  const status = req.query.status;
  const requestId = req.query.request_id; // Supondo que o request_id também virá na query params.

  // URL de falha, que é a mesma para todos os produtos.
  const PAYMENT_FAIL_URL = 'https://www.zodika.com.br/payment-fail';

  // Se o status indica falha, redireciona imediatamente para a página de erro.
  if (status === 'CANCELED' || status === 'FAILED' || status === 'EXPIRED' || status === 'REFUSED') {
    logger.warn(`Pagamento do checkout ${checkoutId} falhou com status ${status}. Redirecionando para a página de falha.`);
    return res.redirect(PAYMENT_FAIL_URL);
  }

  // --- Lógica de redirecionamento para sucesso ---
  // A URL de sucesso será recuperada com base no requestId
  try {
    // TODO: Substitua esta linha pela sua lógica real para obter a redirectUrl do produto
    // com base no requestId. Exemplo:
    // const productData = await birthchartController.getProductDataByRequestId(requestId);
    // const redirectUrl = productData.redirectUrl;
    
    // Simulação temporária:
    const redirectUrl = `https://www.zodika.com.br/success?order=${requestId}`;

    if (!redirectUrl) {
      logger.error(`Não foi possível encontrar a URL de sucesso para o requestId: ${requestId}.`);
      return res.redirect(PAYMENT_FAIL_URL);
    }
    
    logger.info(`Redirecionando cliente para a URL de sucesso: ${redirectUrl}`);
    return res.redirect(redirectUrl);
  } catch (err) {
    logger.error('Erro ao buscar a URL de redirecionamento de sucesso:', err);
    return res.redirect(PAYMENT_FAIL_URL);
  }
}

module.exports = {
  createCheckoutSession,
  handleWebhook,
  handleReturn,
};
