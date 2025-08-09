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

async function createCheckout({ requestId, name, email, productType, productValue, redirectUrl, paymentOptions }) {
  const payload = {
    reference_id: String(requestId),
    items: [{ name: productType || 'Produto', quantity: 1, unit_amount: Number(productValue) }],
    notification_urls: [env.PAGBANK_WEBHOOK_URL],
    payment_notification_urls: [env.PAGBANK_PAYMENT_WEBHOOK_URL || env.PAGBANK_WEBHOOK_URL],
    customer_modifiable: true, 
    customer: { name, email },
    redirect_url: redirectUrl,
    
    // per product
    payment_methods_configs: {
      pix: { enabled: paymentOptions?.allow_pix !== false },
      boleto: { enabled: false }, // desativado globalmente
      credit_card: {
        enabled: paymentOptions?.allow_card !== false,
        installments: paymentOptions?.allow_card === false ? { enabled: false } : {
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
    { headers: { Authorization: `Bearer ${env.PAGBANK_API_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );

  await pagbankRepository.createCheckout({
    request_id: requestId,
    product_type: productType,
    checkout_id: data?.id || null,
    status: data?.status || 'CREATED',
    value: productValue,
    raw: data
  });

  const payLink = Array.isArray(data?.links) ? data.links.find(l => l.rel === 'PAY')?.href : null;
  if (!payLink) throw new Error('PAY link não encontrado.');

  return { url: payLink, checkoutId: data?.id || null };
}

async function processWebhook(p) {
  // 1) Log imutável com idempotência
  const event_uid = p?.id ? `pg_${p.id}` : hashPayload(p);
  await pagbankRepository.logEvent({ event_uid, payload: p });

  // 2) Identificação
  const isCheckoutObject = p?.object === 'checkout' || (!!p?.id && !!p?.status && p?.items);
  const checkoutId = isCheckoutObject ? p.id : p?.checkout?.id || null;
  const firstCharge = Array.isArray(p?.charges) ? p.charges[0] : undefined;
  const chargeId = firstCharge?.id || null;
  const status = firstCharge?.status || p?.status || 'UPDATED';

  // 3) Atualizações de status
  if (checkoutId) await pagbankRepository.updateCheckoutStatusById(checkoutId, status, p);

  // 4) Consolidação em pagbank_payments (status + customer mais recente)
  if (chargeId) {
    const customerData = normalizeCustomer(p.customer || p?.checkout?.customer || {});
    await pagbankRepository.upsertPaymentByChargeId({
      charge_id: chargeId,
      checkout_id: checkoutId,
      status,
      request_ref: p?.reference_id || p?.checkout?.reference_id || null,
      customer: customerData,
      raw: p
    });
  }

  // 5) Se pago, dispara handler do produto
  if (status === 'PAID') {
    const record = chargeId
      ? await pagbankRepository.findByChargeId(chargeId)
      : (checkoutId ? await pagbankRepository.findByCheckoutId(checkoutId) : null);

    if (!record) return;

    const { request_id: requestId, product_type: productType } = record;
    logger.info(`Pagamento confirmado — requestId=${requestId} productType=${productType}`);

    // despache por tipo de produto (registry opcional)
    // await productHandlers[productType]?.onPaid?.(requestId);
  }
}

module.exports = { createCheckout, processWebhook };
