// payments/pagbank/service.js

const httpClient = require('../../utils/httpClient');
const pagbankRepository = require('./repository');
const logger = require('../../utils/logger');
const { mapWebhookPayload } = require('./mapPayload');
const env = require('../../config/env'); // export default do envalid

// BASE fixo (sandbox)
const PAGBANK_BASE = 'https://sandbox.api.pagseguro.com';

async function createCheckout({
  requestId,
  name,
  email,
  productType,
  productValue,
  redirectUrl,     // deixamos disponível, mas usamos a rota padronizada abaixo
  paymentOptions,
}) {
  // Validações mínimas
  if (!requestId) throw new Error('requestId é obrigatório');
  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0) {
    throw new Error('productValue inválido (deve ser número em centavos > 0)');
  }
  if (!name || !email) {
    logger.warn('Criando checkout sem nome/email completos — considere exigir esses campos');
  }

  const payload = {
    reference_id: String(requestId),
    items: [{ name: productType || 'Produto', quantity: 1, unit_amount: valueNum }],

    // Webhooks unificados (mesmo endpoint)
    notification_urls: 'https://backend-form-webflow-production.up.railway.app/webhook/pagbank',
    payment_notification_urls: 'https://backend-form-webflow-production.up.railway.app/webhook/pagbank',

    customer_modifiable: true,
    customer: { name, email },

    // Padrão /pagBank para a rota de retorno
    redirect_url: 'https://backend-form-webflow-production.up.railway.app/pagBank/return',

    // Políticas por produto
    payment_methods_configs: {
      pix: { enabled: paymentOptions?.allow_pix !== false },
      boleto: { enabled: false },
      credit_card: {
        enabled: paymentOptions?.allow_card !== false,
        installments:
          paymentOptions?.allow_card === false
            ? { enabled: false }
            : {
                enabled: true,
                max: paymentOptions?.max_installments ?? 1,
                min_installment_amount: paymentOptions?.min_installment_amount ?? 0,
              },
      },
    },
  };

  const { data } = await httpClient.post(`${PAGBANK_BASE}/checkouts`, payload, {
    headers: {
      Authorization: `Bearer ${env.PAGBANK_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });

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

/**
 * Processa webhook do PagBank.
 * - Loga headers/query
 * - Idempotência por event_uid
 * - Atualiza status e consolida customer
 * - Try/catch interno (controller sempre retorna 200)
 */
async function processWebhook(p, meta = {}) {
  try {
    const mapped = mapWebhookPayload(p);
    const { eventId, checkoutId, chargeId, referenceId, status, customer } = mapped;

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
      logger.info('Webhook duplicado — já registrado. Encerrando sem reprocessar.');
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
        const { request_id: reqId, product_type: prodType } = record;
        logger.info(`Pagamento confirmado — requestId=${reqId} productType=${prodType}`);
        // hook de produto opcional
      }
    }

    return { ok: true };
  } catch (err) {
    logger.error('Erro ao processar webhook do PagBank:', err);
    return { ok: false, error: 'internal_error' };
  }
}

module.exports = { createCheckout, processWebhook };

