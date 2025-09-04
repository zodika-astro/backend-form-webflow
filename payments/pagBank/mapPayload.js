// payments/pagBank/mapPayload.js
'use strict';

/**
 * mapWebhookPayload(payload)
 * -------------------------
 * Canonicalizes PagBank webhook payloads (v1/v2 variants) to a stable shape:
 *   {
 *     eventId,        // stable uid if present (fallback to payload.id or generated)
 *     objectType,     // 'charge' | 'checkout' | 'unknown'
 *     checkoutId,     // when applicable
 *     chargeId,       // when applicable
 *     referenceId,    // external reference / request id
 *     status,         // uppercased; defaults to 'CREATED' for checkout-only events
 *     customer,       // { name, email, tax_id } when available
 *   }
 */

function upper(s) {
  return (s == null) ? undefined : String(s).trim().toUpperCase();
}

function first(...vals) {
  for (const v of vals) if (v != null && v !== '') return v;
  return undefined;
}

function detectType(p) {
  const raw = String(
    first(p?.object_type, p?.object?.type, p?.type, p?.topic, p?.event_type, p?.event)
  || ''
  ).toLowerCase();

  if (raw.includes('charge')) return 'charge';
  if (raw.includes('checkout')) return 'checkout';

  // Heuristics by field presence
  if (p?.charge || p?.data?.charge || p?.data?.charge_id) return 'charge';
  if (p?.checkout || p?.data?.checkout || p?.data?.checkout_id) return 'checkout';

  return 'unknown';
}

function mapCustomer(p) {
  const c = first(p?.customer, p?.data?.customer, p?.buyer);
  if (!c || typeof c !== 'object') return undefined;

  const name = first(c.name, c.full_name);
  const email = c.email;
  const tax = (c.tax_id && typeof c.tax_id === 'object')
    ? (c.tax_id.number || c.tax_id.value)
    : first(c.tax_id, c.document, c.cpf, c.cnpj);

  const out = {};
  if (name) out.name = String(name);
  if (email) out.email = String(email).toLowerCase();
  if (tax) out.tax_id = String(tax);
  return Object.keys(out).length ? out : undefined;
}

function mapStatus(p, objectType) {
  const raw =
    first(
      p?.status,
      p?.data?.status,
      p?.charge?.status,
      p?.checkout?.status
    );

  // Business rule required by tests: a "checkout" event without explicit status
  // should be treated as the beginning of the flow.
  if (!raw && objectType === 'checkout') return 'CREATED';

  return upper(raw) || 'UNKNOWN';
}

function mapIds(p, objectType) {
  const chargeId = first(
    p?.charge_id,
    p?.charge?.id,
    p?.data?.charge_id,
    (objectType === 'charge' ? p?.data?.id : undefined)
  );

  const checkoutId = first(
    p?.checkout_id,
    p?.checkout?.id,
    p?.data?.checkout_id,
    (objectType === 'checkout' ? p?.data?.id : undefined)
  );

  const referenceId = first(
    p?.reference_id,
    p?.data?.reference_id,
    p?.charge?.reference_id,
    p?.checkout?.reference_id
  );

  return { chargeId, checkoutId, referenceId };
}

function mapEventId(p) {
  return first(
    p?.event_id,
    p?.id,
    p?.data?.event_id,
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function mapWebhookPayload(payload) {
  const p = payload || {};
  const objectType = detectType(p);
  const { chargeId, checkoutId, referenceId } = mapIds(p, objectType);
  const status = mapStatus(p, objectType);
  const customer = mapCustomer(p);
  const eventId = mapEventId(p);

  return {
    eventId,
    objectType,
    checkoutId,
    chargeId,
    referenceId,
    status,
    customer,
  };
}

module.exports = { mapWebhookPayload };
