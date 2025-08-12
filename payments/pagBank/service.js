// payments/pagbank/service.js

const httpClient = require('../../utils/httpClient');
const pagbankRepository = require('./repository');
const logger = require('../../utils/logger');
const { mapWebhookPayload } = require('./mapPayload');
const { env } = require('../../config/env');

// Base fixa do PagBank (sandbox)
const PAGBANK_BASE = 'https://sandbox.api.pagseguro.com';

// URLs públicas da sua API (com prefixo /pagBank conforme opção 1)
const PUBLIC_BASE = 'https://backend-form-webflow-production.up.railway.app';
const WEBHOOK_PATH = '/pagBank/webhook/pagbank';
const RETURN_PATH  = '/pagBank/pagbank/return';

async function createCheckout({
  requestId,
  name,
  email,
  productType,
  productValue,
  paymentOptions,
}) {
  if (!requestId) throw new Error('requestId é obrigatório');

  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0) {
    throw new Error('productValue inválido (deve ser número em centavos > 0)');
  }
  if (!name || !email) {
    logger.warn('Criando checkout sem nome/email completos — considere exigir esses campos');
  }

    // Métodos de pagamento (array conforme schema do PagBank)
  const payment_methods = [];
  if (paymentOptions?.allow_pix !== false) payment_methods.push({ type: 'PIX' });
  if (paymentOptions?.allow_card !== false) payment_methods.push({ type: 'CREDIT_CARD' });

  // Configurações de pagamento para cartão de crédito (se habilitado)
  const payment_methods_configs = [];
  if (paymentOptions?.allow_card !== false) {
    const config_options = [];

    // Adiciona a opção INSTALLMENTS_LIMIT
    const maxInst = paymentOptions?.max_installments ?? 1;
    config_options.push({ option: 'INSTALLMENTS_LIMIT', value: String(maxInst) });
    
    // A opção MIN_INSTALLMENT_AMOUNT não é suportada diretamente na API de Checkout.
    // Se você quer assumir os juros, a opção correta é INTEREST_FREE_INSTALLMENTS.
    // Neste exemplo, vamos remover a opção inválida para resolver o erro.
    // Se você precisa de lógica de juros, deve usar 'INTEREST_FREE_INSTALLMENTS'.
    
    if (config_options.length > 0) {
      payment_methods_configs.push({
        type: 'CREDIT_CARD',
        config_options,
      });
    }
  }

  const payload = {
    reference_id: String(requestId),
    items: [{ name: productType || 'Produto', quantity: 1, unit_amount: valueNum }],

    // >>> precisam ser ARRAYS
    notification_urls: [`${PUBLIC_BASE}${WEBHOOK_PATH}`],
    payment_notification_urls: [`${PUBLIC_BASE}${WEBHOOK_PATH}`],

    customer_modifiable: true,
    customer: { name, email },

    // mantém o retorno fixo já definido por você
    redirect_url: `${PUBLIC_BASE}${RETURN_PATH}`,

    // >>> arrays exigidos pela API
    payment_methods,
    payment_methods_configs,
  };

  const { data } = await httpClient.post(`${PAGBANK_BASE}/checkouts`, payload, {
    headers: {
      Authorization: `Bearer ${env.PAGBANK_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });

    // --- ADD THIS LOGGING LINE ---
  logger.info('PagBank API Response:', JSON.stringify(data, null, 2));
  // --- END OF ADDITION ---

  const payLink = Array.isArray(data?.links) ? data.links.find((l) => l.rel === 'PAY')?.href : null;
  if (!payLink) throw new Error('PAY link não encontrado no retorno do PagBank');

  await pagbankRepository.createCheckout({
    request_id: requestId,
    product_type: productType,
    checkout_id: data?.id || null,
    status: data?.status || 'CREATED',
    value: valueNum,
    link: payLink || null,
    customer: { name, email },
    raw: data,
  });

  return { url: payLink, checkoutId: data?.id || null };
}

async function processWebhook(p, meta = {}) {
  try {
    const { eventId, checkoutId, chargeId, referenceId, status, customer } = mapWebhookPayload(p);

    const logged = await pagbankRepository.logEvent({
      event_uid: eventId,
      payload: p,
      headers: meta.headers || null,
      query: meta.query || null,
      topic: meta.topic || null,
      action: meta.action || null,
      checkout_id: checkoutId,
      charge_id: chargeId,
    });

    if (!logged) {
      logger.info('Webhook duplicado — ignorando processamento');
      return { ok: true, duplicate: true };
    }

    if (checkoutId) {
      await pagbankRepository.updateCheckoutStatusById(checkoutId, status, p);
    }

    if (chargeId) {
      await pagbankRepository.upsertPaymentByChargeId({
        charge_id: chargeId,
        checkout_id: checkoutId,
        status,
        request_ref: referenceId,
        customer,
        raw: p,
      });
    }

    if (status === 'PAID') {
      const record = chargeId
        ? await pagbankRepository.findByChargeId(chargeId)
        : checkoutId
        ? await pagbankRepository.findByCheckoutId(checkoutId)
        : null;

      if (record) {
        const { request_id: requestId, product_type: productType } = record;
        logger.info(`Pagamento confirmado — requestId=${requestId} productType=${productType}`);
      }
    }

    return { ok: true };
  } catch (err) {
    logger.error('Erro ao processar webhook do PagBank:', err);
    return { ok: false, error: 'internal_error' };
  }
}

module.exports = { createCheckout, processWebhook };
