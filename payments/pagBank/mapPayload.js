const crypto = require('crypto');

function stableStringify(obj) {
  return JSON.stringify(obj, Object.keys(obj || {}).sort());
}

function hashPayload(obj) {
  return crypto.createHash('sha256').update(stableStringify(obj)).digest('hex');
}

function normalizeCustomer(customer = {}) {
  const phones = Array.isArray(customer.phones) ? customer.phones : [];
  const phone = phones[0] || {};
  const address = customer.address ? customer.address : undefined;

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
   
    address_json: address || null,
  };
}

function unwrapData(payload = {}) {

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
  const raw = amount.value ?? amount.total ?? 0;
  const currency = amount.currency ?? null;

 
  let cents = 0;
  if (typeof raw === 'number') {
    cents = Number.isInteger(raw) ? raw : Math.round(raw * 100);
  } else if (typeof raw === 'string') {
    cents = raw.includes('.') ? Math.round(parseFloat(raw) * 100) : parseInt(raw, 10);
    if (!Number.isFinite(cents)) cents = 0;
  }

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
    REFUSED: 'REFUSED',
    CANCELED: 'CANCELED',
    CANCELLED: 'CANCELED',
    REFUNDED: 'REFUNDED',
    CHARGED_BACK: 'CHARGED_BACK',
    FAILED: 'FAILED',
    UPDATED: 'UPDATED',
    EXPIRED: 'EXPIRED',
  };
  return map[up] || 'UNKNOWN';
}

function mapWebhookPayload(rawPayload) {
  const pagbankPayload = unwrapData(rawPayload);
  const objectType = detectObjectType(pagbankPayload);

  const checkoutId =
    objectType === 'checkout'
      ? pagbankPayload.id
      : pagbankPayload?.checkout?.id || null;

  const firstCharge = Array.isArray(pagbankPayload?.charges)
    ? pagbankPayload.charges[0]
    : undefined;

  const chargeId = firstCharge?.id || pagbankPayload?.charge?.id || null;

  const status = normalizeStatus(firstCharge?.status || pagbankPayload?.status);

  const referenceId =
    pagbankPayload?.reference_id ||
    pagbankPayload?.checkout?.reference_id ||
    firstCharge?.reference_id ||
    null;

  const customerData = normalizeCustomer(
    pagbankPayload.customer ||
    pagbankPayload?.checkout?.customer ||
    firstCharge?.customer ||
    {}
  );

  const { cents: value_cents, currency } = normalizeMoney(
    firstCharge?.amount || pagbankPayload?.amount || {}
  );

  const providerId =
    pagbankPayload?.event_id ||
    pagbankPayload?.notification_id ||
    pagbankPayload?.id ||
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

module.exports = { mapWebhookPayload, normalizeCustomer };
