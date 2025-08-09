// modules/pagbank/service.js

const crypto = require('crypto');
const httpClient = require('../../utils/httpClient');
const pagbankRepository = require('./repository');
const logger = require('../../utils/logger');
const { env } = require('../../../config/env');

const PAGBANK_BASE = env.PAGBANK_BASE_URL || 'https://sandbox.api.pagseguro.com';

function hashPayload(obj) {
  const str = JSON.stringify(obj || {});
  return crypto.createHash('sha256').update(str).digest('hex');
}

function normalizeCustomer(c = {}) {
  const phone = Array.isArray(c.phones) ? c.phones[0] : undefined;
  const address = c.address ? c.address : undefined;
  return {
    name: c.name || null,
    email: c.email || null,
    tax_id: c.tax_id || null,
    phone_country: phone?.country || null,
    phone_area: phone?.area || null,
    phone_number: phone?.number || null,
    address_json: address ? JSON.stringify(address) : null,
  };
}

/**
 * Cria um checkout hospedado e retorna o link PAY.
 * Proteções: validações de campos obrigatórios.
 */
async function createCheckout({
  requestId,
  name,
  email,
  productType,
  productValue,
  redirectUrl,
  paymentOptions
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
  if (!redirectUrl) {
    logger.warn('Sem redirectUrl — considere definir por produto');
  }

  const payload = {
    reference_id: String(requestId),
    items: [{ name: productType || 'Produto', quantity: 1, unit_amount: valueNum }],
    notification_urls: [env.PAGBANK_WEBHOOK_URL],
    payment_notification_urls: [env.PAGBANK_PAYMENT_WEBHOOK_URL || env.PAGBANK_WEBHOOK_URL],
    customer_modifiable: true,
    customer: { name, email },
    redirect_url: redirectUrl || undefined,
    // Políticas por produto
    payment_methods_configs: {
      pix: { enabled: paymentOptions?.allow_pix !== false },
      boleto: { enabled: false }, // desativado globalmente
      credit_card: {
        enabled: paymentOptions?.allow_card !== false,
        installments: (paymentOptions?.allow_card === false)
          ? { enabled: false }
          : {
              enabled: true,
              max: paymentOptions?.max_installments ?? 1,
              min_installment_amount: paymentOptions?.min_installment_amount ?? 0
            }
      }
    }
  };

  const { data } = await httpClient.post(
    `${PAGBANK_BASE}/checkouts`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${env.PAGBANK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  const payLink = Array.isArray(data?.links) ? data.links.find(l => l.rel === 'PAY')?.href : null;
  if (!payLink) throw new Error('PAY link não encontrado no retorno do PagBank');

  await pagbankRepository.createCheckout({
    request_id: requestId,
    product_type: productType,
    checkout_id: data?.id || null,
    status: data?.status || 'CREATED',
    value: valueNum,
    link: payLink || null,
    customer: { name, email }, // guarda o que você enviou (para comparar depois)
    raw: data
  });

  return { url: payLink, checkoutId: data?.id || null };
}

/**
 * Processa webhook do PagBank.
 * - Registra evento com headers/query (se enviados pelo controller)
 * - IDEMPOTÊNCIA: se já logado, encerra cedo
 * - Atualiza status em request/payments e consolida customer
 * - Try/catch interno para não quebrar o fluxo HTTP do controller
 *
 * @param {object} p - payload (req.body)
 * @param {object} meta - metadados opcionais do request HTTP { headers, query, topic, action }
 * @returns {object} { ok: boolean, duplicate?: boolean }
 */
async function processWebhook(p, meta = {}) {
  try {
    // 1) Log imutável com idempotência
    const event_uid = p?.id ? `pg_${p.id}` : hashPayload(p);
    const logged = await pagbankRepository.logEvent({
      event_uid,
      payload: p,
      headers: meta.headers || null,
      query: meta.query || null,
      topic: meta.topic || null,
      action: meta.action || null,
      checkout_id: p?.checkout?.id || p?.id || null,
      charge_id: p?.charges?.[0]?.id || null
    });

    // Se já havia um evento com esse UID, não prossiga (idempotência total)
    if (!logged) {
      logger.info('Webhook duplicado — apenas logado anteriormente, ignorando processamento.');
      return { ok: true, duplicate: true };
    }

    // 2) Identificação
    const isCheckoutObject = p?.object === 'checkout' || (!!p?.id && !!p?.status && p?.items);
    const checkoutId = isCheckoutObject ? p.id : p?.checkout?.id || null;
    const firstCharge = Array.isArray(p?.charges) ? p.charges[0] : undefined;
    const chargeId = firstCharge?.id || null;
    const status = firstCharge?.status || p?.status || 'UPDATED';

    // Consolidar reference_id com fallback
    const referenceId = p?.reference_id || p?.checkout?.reference_id || null;

    // 3) Atualizações de status (checkout)
    if (checkoutId) {
      await pagbankRepository.updateCheckoutStatusById(checkoutId, status, p);
    }

    // 4) Consolidação em pagbank_payments (status + customer mais recente)
    if (chargeId) {
      const customerData = normalizeCustomer(p.customer || p?.checkout?.customer || {});
      await pagbankRepository.upsertPaymentByChargeId({
        charge_id: chargeId,
        checkout_id: checkoutId,
        status,
        request_ref: referenceId,
        customer: customerData,
        raw: p
      });
    }

    // 5) Se pago, despacha handler do produto (opcional, via registry)
    if (status === 'PAID') {
      const record = chargeId
        ? await pagbankRepository.findByChargeId(chargeId)
        : (checkoutId ? await pagbankRepository.findByCheckoutId(checkoutId) : null);

      if (record) {
        const { request_id: requestId, product_type: productType } = record;
        logger.info(`Pagamento confirmado — requestId=${requestId} productType=${productType}`);
        // await productHandlers[productType]?.onPaid?.(requestId);
      }
    }

    return { ok: true };
  } catch (err) {
    // Nunca lança: deixa o controller responder 200 OK e só loga aqui
    logger.error('Erro ao processar webhook do PagBank:', err);
    return { ok: false, error: 'internal_error' };
  }
}

module.exports = { createCheckout, processWebhook };
