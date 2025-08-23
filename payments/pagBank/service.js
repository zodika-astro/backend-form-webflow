// payments/pagBank/service.js (substitua só a createCheckout)
const httpClient = require('../../utils/httpClient');
const logger = require('../../utils/logger');
const crypto = require('crypto');
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

const { env } = require('../../config/env');

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
    throw new Error('productValue inválido (centavos, inteiro > 0)');
  }

  // Métodos de pagamento como STRINGS (não objetos)
  const methods = [];
  if (paymentOptions?.allow_pix !== false) methods.push('PIX');
  if (paymentOptions?.allow_card !== false) methods.push('CREDIT_CARD');

  // Payload MÍNIMO e no shape esperado
  const payload = JSON.parse(JSON.stringify({
    reference_id: String(requestId),
    items: [{ name: productType || 'Produto', quantity: 1, unit_amount: valueNum }],
    checkout: {
      redirect_url: 'https://backend-form-webflow-production.up.railway.app/pagBank/pagbank/return',
      payment_methods: methods.length ? methods : ['PIX','CREDIT_CARD'],
    },
    // Envie customer só se realmente tiver valores válidos
    ...(name && email ? { customer: { name, email } } : {}),
  }));

  try {
    const res = await httpClient.post('/checkout', payload, {
      headers: {
        Authorization: `Bearer ${env.PAGBANK_API_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': uuid(),
      },
      timeout: 20000,
    });

    const data = res?.data;
    logger.info('[PagBank][RES]', {
      status: res?.status,
      url: res?.config?.url,
      data,
    });

    // Tente achar o link em múltiplos formatos
    let payLink = null;
    if (Array.isArray(data?.links)) {
      payLink = data.links.find(l => (l.rel || '').toUpperCase() === 'PAY')?.href
             || data.links.find(l => (l.rel || '').toUpperCase() === 'CHECKOUT')?.href
             || data.links.find(l => (l.rel || '').toUpperCase() === 'SELF')?.href;
    }
    if (!payLink && data?.payment_url) payLink = data.payment_url;
    if (!payLink && data?.checkout?.payment_url) payLink = data.checkout.payment_url;

    if (!payLink) {
      throw new Error('PAY link não encontrado no retorno do PagBank');
    }

    // (Opcional) só depois que funcionar, reative o persist:
    // await pagbankRepository.createCheckout({ ... });

    return { url: payLink, checkoutId: data?.id || null };
  } catch (e) {
    if (e.response) {
      logger.error('[PagBank][ERR]', {
        status: e.response.status,
        url: e.config?.url,
        data: e.response.data,
        headers: e.response.headers,
      });
    } else {
      logger.error('[PagBank][ERR-NETWORK]', e.message);
    }
    throw e;
  }
}

async function processWebhook(p, meta = {}) {
  try {
    const { mapWebhookPayload } = require('./mapPayload');
    const pagbankRepository = require('./repository');
    const logger = require('../../utils/logger');

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
    const logger = require('../../utils/logger');
    logger.error('Erro ao processar webhook do PagBank:', err);
    return { ok: false, error: 'internal_error' };
  }
}


module.exports = { createCheckout, processWebhook };
