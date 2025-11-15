// payments/payPal/mapPayload.js
'use strict';

const crypto = require('crypto');

/* -------------------------------------------------------------------------- */
/*                               Hash Utilities                               */
/* -------------------------------------------------------------------------- */

/**
 * stableStringify
 * ----------------
 * Deterministic JSON stringify (sorted keys).
 * Ensures stable hashing of payloads for idempotency.
 */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  const allKeys = Object.keys(obj).sort();
  const out = {};
  for (const k of allKeys) out[k] = obj[k];
  return JSON.stringify(out);
}

/**
 * hashPayload
 * -----------
 * Hashes an arbitrary payload object using SHA-256.
 * Used as fallback to generate a stable event UID.
 */
function hashPayload(obj) {
  return crypto.createHash('sha256')
    .update(stableStringify(obj))
    .digest('hex');
}

/* -------------------------------------------------------------------------- */
/*                         PayPal-Specific Normalizers                        */
/* -------------------------------------------------------------------------- */

/**
 * unwrapResource
 * --------------
 * PayPal webhooks always send { resource: {...} }.
 * We unwrap it for easier processing.
 */
function unwrapResource(payload = {}) {
  if (payload && payload.resource && typeof payload.resource === 'object') {
    return payload.resource;
  }
  return payload;
}

/**
 * normalizeCustomer
 * -----------------
 * PayPal customers can come from:
 *   - payload.resource.payer
 *   - payload.resource.purchase_units[x].shipping
 *
 * PayPal does NOT give tax_id by default.
 */
function normalizeCustomer(resource = {}) {
  const payer = resource.payer || {};
  const shipping = resource?.purchase_units?.[0]?.shipping || {};

  const name =
    payer?.name?.given_name && payer?.name?.surname
      ? `${payer.name.given_name} ${payer.name.surname}`.trim()
      : payer?.name?.given_name || null;

  return {
    name: name || null,
    email: payer?.email_address || null,      // PayPal field
    tax_id: null,                             // Only available via special integrations
    phone_country: null,                      // PayPal rarely provides this cleanly
    phone_area: null,
    phone_number: payer?.phone?.phone_number?.national_number || null,
    address_json: shipping?.address || null,
  };
}

/**
 * detectObjectType
 * ----------------
 * Distinguishes between Order and Capture objects.
 * PayPal SENDS BOTH depending on event_type:
 *   - CHECKOUT.ORDER.APPROVED  → ORDER
 *   - PAYMENT.CAPTURE.COMPLETED → CAPTURE
 */
function detectObjectType(payload = {}) {
  const event = (payload.event_type || '').toUpperCase();

  if (event.includes('CHECKOUT.ORDER')) return 'order';
  if (event.includes('PAYMENT.CAPTURE')) return 'capture';

  // Fallback using resource structure
  const r = payload.resource || {};
  if (r?.purchase_units) return 'order';
  if (r?.amount && r?.status) return 'capture';

  return 'unknown';
}

/**
 * normalizeMoneyFromOrder
 * -----------------------
 * Extracts BRL/amount from ORDER object.
 * ORDER → purchase_units[0].amount.value
 */
function normalizeMoneyFromOrder(order = {}) {
  try {
    const amt = order?.purchase_units?.[0]?.amount || {};
    const raw = amt.value;
    const currency = amt.currency_code || null;

    if (!raw) return { cents: 0, currency };

    // Always string in PayPal
    const valueFloat = parseFloat(raw);
    const cents = Number.isFinite(valueFloat) ? Math.round(valueFloat * 100) : 0;

    return { cents, currency };
  } catch {
    return { cents: 0, currency: null };
  }
}

/**
 * normalizeMoneyFromCapture
 * -------------------------
 * CAPTURE → resource.amount.value
 */
function normalizeMoneyFromCapture(capture = {}) {
  const raw = capture?.amount?.value || null;
  const currency = capture?.amount?.currency_code || null;

  if (!raw) return { cents: 0, currency };

  const valueFloat = parseFloat(raw);
  const cents = Number.isFinite(valueFloat) ? Math.round(valueFloat * 100) : 0;

  return { cents, currency };
}

/**
 * normalizeStatus
 * ---------------
 * Maps PayPal payment/order statuses into your internal enum.
 */
function normalizeStatus(s) {
  if (!s) return 'UNKNOWN';
  const up = String(s).toUpperCase();

  const map = {
    COMPLETED: 'APPROVED',
    APPROVED: 'APPROVED',
    PAYER_ACTION_REQUIRED: 'REQUIRES_ACTION',
    DENIED: 'REJECTED',
    VOIDED: 'CANCELED',
    FAILED: 'REJECTED',
    PENDING: 'PENDING',
    REFUNDED: 'REFUNDED',
  };

  return map[up] || up || 'UNKNOWN';
}

/* -------------------------------------------------------------------------- */
/*                             Main Mapper (export)                           */
/* -------------------------------------------------------------------------- */

/**
 * mapWebhookPayload
 * -----------------
 * Converts an arbitrary PayPal webhook payload into a normalized structure:
 *
 * {
 *   eventId,
 *   objectType: "order" | "capture" | "unknown",
 *   preferenceId,
 *   paymentId,
 *   externalReference,
 *   status,
 *   value_cents,
 *   currency,
 *   customer,
 *   rawPayload
 * }
 *
 * - Similar shape to Mercado Pago/PagBank mappers.
 * - Idempotent provider UID through hashing fallback.
 */
function mapWebhookPayload(rawPayload = {}) {
  const resource = unwrapResource(rawPayload);
  const objectType = detectObjectType(rawPayload);

  const paymentId =
    resource?.id ||
    rawPayload?.id ||
    rawPayload?.resource?.id ||
    null;

  // PayPal equivalent of "external_reference" is "custom_id"
  const externalReference =
    resource?.custom_id ||
    rawPayload?.custom_id ||
    null;

  // "preference_id" does not exist in PayPal
  // → we store order/capture IDs as "preference_id" equivalent in DB layer
  const preferenceId = paymentId;

  // Value
  let cents = 0;
  let currency = null;
  if (objectType === 'order') {
    ({ cents, currency } = normalizeMoneyFromOrder(resource));
  } else if (objectType === 'capture') {
    ({ cents, currency } = normalizeMoneyFromCapture(resource));
  }

  // Status normalization
  const status = normalizeStatus(resource?.status || rawPayload?.status || null);

  // Customer
  const customer = normalizeCustomer(resource);

  // Provider event UID
  const providerId =
    rawPayload?.id ||
    rawPayload?.event_id ||
    rawPayload?.webhook_id ||
    null;

  const eventId = providerId
    ? `pp_${objectType}_${providerId}`
    : hashPayload({ p: rawPayload, o: objectType });

  return {
    eventId,
    objectType,
    preferenceId,
    paymentId,
    externalReference,
    status,
    value_cents: cents,
    currency,
    customer,
    rawPayload: resource,
  };
}

module.exports = {
  stableStringify,
  hashPayload,
  unwrapResource,
  detectObjectType,
  normalizeCustomer,
  normalizeMoneyFromOrder,
  normalizeMoneyFromCapture,
  normalizeStatus,
  mapWebhookPayload,
};
