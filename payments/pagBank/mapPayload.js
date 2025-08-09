const crypto = require('crypto');

function stableStringify(obj) {
  // Canonical JSON: ordena chaves para hash estável
  return JSON.stringify(obj, Object.keys(obj || {}).sort());
}

function hashPayload(obj) {
  return crypto.createHash('sha256').update(stableStringify(obj)).digest('hex');
}

function normalizeCustomer(customer = {}) {
  const phones = Array.isArray(customer.phones) ? customer.phones : [];
  const phone = phones[0] || {};
  const address = customer.address ? customer.address : undefined;

  // fallbacks para diferentes nomes de campos
  const phoneCountry = phone.country ?? phone.country_code ?? null;
  const phoneArea = phone.area ?? phone.area_code ?? null;
  const phoneNumber = phone.number ?? phone.phone_number ?? null;

  return {
    name: customer.name || null,
    email: customer.email || null,
    tax_id: customer.tax_id || null,
    phone_country: phoneCountry || null,
    phone_area: phoneArea || null,
    phone_number: phoneNumber || null,
    address_json: address ? JSON.stringify(address) : null,
  };
}

function unwrapData(payload = {}) {
  // Alguns provedores enviam { event, data: {...} }
  if (payload && payload.data && typeof payload.data === 'object') return payload.data;
  return payload;
}

function detectObjectType(p) {
  if (p?.object === 'checkout') return 'checkout';
  if (Array.isArray(p?.charges)) return 'charge';
  if (p?.items && p?.status && p?.id) return 'checkout';
  return 'unknown';
}

function normalizeMoney(amount = {}) {
  const valueRaw = amount.value ?? amount.total ?? 0;
  const currency = amount.currency ?? null;
  // value pode vir string/float; normalize para inteiro (centavos)
  const valueNumber = Number(valueRaw);
  const cents = Number.isFinite(valueNumber) ? Math.round(valueNumber * 100) : 0;
  return { cents, currency };
}

function normalizeStatus(s) {
  if (!s) return 'UNKNOWN';
  const up = String(s).toUpperCase();
  const map = {
    PAID: 'PAID',
    AUTHORIZED: 'AUTHORIZED',
    AUTHORIZED_PENDING_CAPTURE: 'AUTHORIZED',
    IN_ANALYSIS: 'IN_ANALYSIS',
    PENDING: 'PENDING',
    DECLINED: 'DECLINED',
    CANCELED: 'CANCELED',
    CANCELLED: 'CANCELED',
    REFUNDED: 'REFUNDED',
    CHARGED_BACK: 'CHARGED_BACK',
    FAILED: 'FAILED',
    UPDATED: 'UPDATED',
  };
  return map[up] || 'UNKNOWN';
}

function mapWebhookPayload(rawPayload) {
  const pagbankPayload = unwrapData(rawPayload);
  const objectType = detectObjectType(pagbankPayload);

  // checkoutId
  const checkoutId =
    objectType === 'checkout'
      ? pagbankPayload.id
      : pagbankPayload?.checkout?.id || null;

  // charge
  const firstCharge = Array.isArray(pagbankPayload?.charges)
    ? pagbankPayload.charges[0]
    : undefined;
  const chargeId = firstCharge?.id || pagbankPayload?.charge?.id || null;

  // status
  const status = normalizeStatus(firstCharge?.status || pagbankPayload?.status);

  // reference_id com fallbacks
  const referenceId =
    pagbankPayload?.reference_id ||
    pagbankPayload?.checkout?.reference_id ||
    firstCharge?.reference_id ||
    null;

  // customer
  const customerData = normalizeCustomer(
    pagbankPayload.customer ||
      pagbankPayload?.checkout?.customer ||
      firstCharge?.customer ||
      {}
  );

  // valor
  const { cents: value_cents, currency } = normalizeMoney(
    firstCharge?.amount || pagbankPayload?.amount || {}
  );

  // eventId estável
  // Preferir um UID do provedor, se existir; senão, hash canônico
  const providerId =
    pagbankPayload?.event_id ||
    pagbankPayload?.notification_id ||
    pagbankPayload?.id || // (pode colidir entre objetos diferentes, por isso prefixamos)
    null;

  const eventId = providerId
    ? `pg_${objectType}_${providerId}`
    : hashPayload({ h: pagbankPayload, t: objectType });

  return {
    eventId,
    objectType,
    checkoutId,
    chargeId,
    referenceId,
    status,
    value_cents,
    currency,
    customer: customerData,
    rawPayload: pagbankPayload,
  };
}

module.exports = {
  mapWebhookPayload,
  normalizeCustomer,
};
