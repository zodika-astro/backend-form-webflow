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
 *     status,         // canonical uppercased status; defaults to 'CREATED' for checkout-only events
 *     customer,       // { name, email, tax_id } when available
 *   }
 */

function upper(s) {
  return s == null ? undefined : String(s).trim().toUpperCase();
}

function first(...vals) {
  for (const v of vals) if (v != null && v !== '') return v;
  return undefined;
}

/**
 * Detects the primary object type conveyed by the webhook.
 * Uses explicit "type"-like fields first, then falls back to field presence heuristics.
 */
function detectType(p) {
  const raw = String(
    first(p?.object_type, p?.object?.type, p?.type, p?.topic, p?.event_type, p?.event) || ''
  ).toLowerCase();

  if (raw.includes('charge')) return 'charge';
  if (raw.includes('checkout')) return 'checkout';

  // Heuristics by field presence
  if (p?.charge || p?.data?.charge || p?.data?.charge_id) return 'charge';
  if (p?.checkout || p?.data?.checkout || p?.data?.checkout_id) return 'checkout';

  return 'unknown';
}

/**
 * Extracts minimal customer info when available.
 */
function mapCustomer(p) {
  const c = first(p?.customer, p?.data?.customer, p?.buyer);
  if (!c || typeof c !== 'object') return undefined;

  const name = first(c.name, c.full_name);
  const email = c.email;
  const tax =
    c?.tax_id && typeof c.tax_id === 'object'
      ? first(c.tax_id.number, c.tax_id.value)
      : first(c.tax_id, c.document, c.cpf, c.cnpj);

  const out = {};
  if (name) out.name = String(name);
  if (email) out.email = String(email).toLowerCase();
  if (tax) out.tax_id = String(tax);
  return Object.keys(out).length ? out : undefined;
}

/**
 * Optional canonicalization of provider statuses to our internal vocabulary.
 * Unknown values are returned uppercased as-is.
 */
function canonicalizeStatus(rawUpper) {
  if (!rawUpper) return undefined;

  // Group common variants into a smaller, stable set
  const PAID = new Set(['PAID', 'PAID_OUT', 'APPROVED', 'AUTHORIZED', 'CAPTURED']);
  const PENDING = new Set(['PENDING', 'IN_REVIEW', 'IN_ANALYSIS', 'AWAITING_PAYMENT', 'PROCESSING']);
  const CANCELED = new Set(['CANCELED', 'CANCELLED', 'DECLINED', 'REFUSED', 'FAILED']);
  const REFUNDED = new Set(['REFUNDED', 'PARTIALLY_REFUNDED', 'CHARGEBACK']);

  if (PAID.has(rawUpper)) return 'PAID';
  if (PENDING.has(rawUpper)) return 'PENDING';
  if (CANCELED.has(rawUpper)) return 'CANCELED';
  if (REFUNDED.has(rawUpper)) return 'REFUNDED';

  return rawUpper; // pass-through for unrecognized but present statuses
}

/**
 * Determines the canonical status.
 * Business rule: a "checkout-only" event (no explicit status AND has checkout ID but no charge ID)
 * must be treated as the start of the flow → 'CREATED'.
 */
function mapStatus(p, objectType, { chargeId, checkoutId }) {
  const raw = first(
    p?.status,
    p?.data?.status,
    p?.charge?.status,
    p?.checkout?.status,
    p?.current_status
  );

  // Checkout start-of-flow defaults
  if (!raw) {
    if (objectType === 'checkout') return 'CREATED';
    if (!chargeId && checkoutId) return 'CREATED'; // fallback if type detection didn't flag "checkout"
  }

  const up = upper(raw);
  return canonicalizeStatus(up) || 'UNKNOWN';
}

/**
 * Extracts identifiers for charge/checkout/reference.
 */
function mapIds(p, objectType) {
  const chargeId = first(
    p?.charge_id,
    p?.charge?.id,
    p?.data?.charge_id,
    objectType === 'charge' ? p?.data?.id : undefined
  );

  const checkoutId = first(
    p?.checkout_id,
    p?.checkout?.id,
    p?.data?.checkout_id,
    objectType === 'checkout' ? p?.data?.id : undefined
  );

  const referenceId = first(
    p?.reference_id,
    p?.data?.reference_id,
    p?.charge?.reference_id,
    p?.checkout?.reference_id
  );

  return { chargeId, checkoutId, referenceId };
}

/**
 * Builds a stable event id if provided; otherwise falls back to a generated token.
 */
function mapEventId(p) {
  return first(
    p?.event_id,
    p?.id,
    p?.data?.event_id,
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * Main entry: canonicalize the PagBank webhook payload.
 */
function mapWebhookPayload(payload) {
  const p = payload || {};
  const objectType = detectType(p);
  const ids = mapIds(p, objectType);
  const status = mapStatus(p, objectType, ids);
  const customer = mapCustomer(p);
  const eventId = mapEventId(p);

  return {
    eventId,
    objectType,
    checkoutId: ids.checkoutId,
    chargeId: ids.chargeId,
    referenceId: ids.referenceId,
    status,
    customer,
  };
}

module.exports = { mapWebhookPayload };
