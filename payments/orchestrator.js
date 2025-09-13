// payments/orchestrator.js
'use strict';

/**
 * Payments Orchestrator (snapshot writer)
 * ---------------------------------------
 * Single responsibility:
 *   Keep `public.zodika_requests` in sync with the latest payment snapshot,
 *   independent of the payment provider.
 *
 * Scope (v1):
 *   - Provider: Mercado Pago (MP)
 *   - Writes only the compact, non-duplicated columns you created.
 *   - No product-specific side effects here (timezone, ephemeris, webhooks, etc).
 *
 * Usage:
 *   await orchestrator.updateFromMP(paymentJson, {
 *     requestId,              // preferred: integer id from our system
 *     externalReference,      // optional fallback (must be numeric string)
 *     preferenceId,           // MP preference_id (checkout id)
 *     link                    // optional checkout public URL (if you have it)
 *   })
 */

const db = require('../db/db');
const logger = require('../utils/logger').child('payments.orchestrator');

/* --------------------------------- Helpers --------------------------------- */

/** Coerce to positive integer or null. */
function toIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Amount in integer cents (rounded) or null. */
function toCentsOrNull(amount) {
  if (amount == null || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Parse ISO-ish date to Date or null. */
function toDateOrNull(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Trim to max length or null. */
function toTrimOrNull(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return typeof max === 'number' ? s.slice(0, max) : s;
}

/* ----------------------- Canonical status mapping (MP) ---------------------- */
/**
 * MP → canonical:
 * - approved        → PAID
 * - in_process      → PENDING
 * - pending         → PENDING
 * - rejected        → REJECTED
 * - cancelled       → CANCELED
 * - canceled        → CANCELED (typo variant)
 * - refunded        → REFUNDED
 * - charged_back    → CHARGED_BACK
 * - authorized      → REQUIRES_ACTION (rare in Checkout Pro; defensively mapped)
 * - expired         → EXPIRED
 * - default         → PENDING (safe fallback for unknown intermediates)
 */
function mapMpToCanonicalStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'approved':      return 'PAID';
    case 'in_process':
    case 'pending':       return 'PENDING';
    case 'rejected':      return 'REJECTED';
    case 'cancelled':
    case 'canceled':      return 'CANCELED';
    case 'refunded':      return 'REFUNDED';
    case 'charged_back':  return 'CHARGED_BACK';
    case 'authorized':    return 'REQUIRES_ACTION';
    case 'expired':       return 'EXPIRED';
    default:              return 'PENDING';
  }
}

/* ----------------------------- Core persistence ----------------------------- */
/**
 * Persist snapshot to public.zodika_requests.
 * - Uses COALESCE to avoid overwriting existing non-null values with nulls.
 * - Updates `updated_at` and `payment_updated_at`.
 */
async function persistSnapshot({
  requestId,
  provider,               // 'MP' | 'PAGBANK' (future)
  status,                 // canonical (PAID, PENDING, ...)
  statusDetail,           // provider-native
  amountCents,            // integer cents
  currency,               // 'BRL', ...
  checkoutId,             // MP: preference_id
  paymentId,              // MP: payment.id
  link,                   // public redirect/checkout link (optional)
  authorizedAt,           // when provider approved/paid (MP: date_approved)
}) {
  const sql = `
    UPDATE public.zodika_requests
       SET payment_provider      = $2,
           payment_status        = $3,
           payment_status_detail = $4,
           payment_amount_cents  = $5,
           payment_currency      = $6,
           payment_checkout_id   = COALESCE($7, payment_checkout_id),
           payment_payment_id    = COALESCE($8, payment_payment_id),
           payment_link          = COALESCE($9, payment_link),
           payment_authorized_at = COALESCE($10, payment_authorized_at),
           payment_updated_at    = NOW(),
           updated_at            = NOW()
     WHERE request_id = $1
    RETURNING request_id;
  `;

  const params = [
    requestId,
    provider || null,
    status || null,
    statusDetail || null,
    amountCents != null ? amountCents : null,
    toTrimOrNull(currency, 3),
    toTrimOrNull(checkoutId, 128),
    toTrimOrNull(paymentId, 128),
    toTrimOrNull(link, 2048),
    authorizedAt ? toDateOrNull(authorizedAt) : null,
  ];

  const t0 = Date.now();
  try {
    const { rows } = await db.query(sql, params);
    if (!rows[0]) {
      logger.warn({ requestId }, 'payment snapshot: request not found');
      return false;
    }
    return true;
  } catch (err) {
    logger.error(
      { err: err.message, durationMs: Date.now() - t0 },
      'payment snapshot update failed'
    );
    throw err;
  }
}

/* ----------------------------- Provider: Mercado Pago ----------------------------- */
/**
 * Update snapshot from a Mercado Pago `payment` JSON.
 * Hints:
 *  - requestId (preferred) or externalReference (numeric string) are used to locate the row.
 *  - preferenceId and link are optional (we COALESCE to preserve previous values).
 */
async function updateFromMP(payment, hints = {}) {
  if (!payment || typeof payment !== 'object') {
    throw new Error('updateFromMP: invalid payment payload');
  }

  // Resolve requestId
  let requestId = toIntOrNull(hints.requestId);
  if (!requestId) {
    const ext = payment.external_reference || hints.externalReference;
    requestId = toIntOrNull(ext);
  }
  if (!requestId) {
    // We will not upsert without a resolvable request row
    throw new Error('updateFromMP: requestId (or numeric external_reference) is required');
  }

  const provider = 'MP';
  const statusNative  = payment.status || null;
  const statusDetail  = payment.status_detail || null;
  const status        = mapMpToCanonicalStatus(statusNative);

  const amountCents   = toCentsOrNull(payment.transaction_amount);
  const currency      = toTrimOrNull(payment.currency_id, 3);
  const checkoutId    = toTrimOrNull(payment.preference_id || hints.preferenceId, 128);
  const paymentId     = toTrimOrNull(payment.id, 128);
  const link          = toTrimOrNull(hints.link, 2048); // optional
  const authorizedAt  = toDateOrNull(payment.date_approved);

  return persistSnapshot({
    requestId,
    provider,
    status,
    statusDetail,
    amountCents,
    currency,
    checkoutId,
    paymentId,
    link,
    authorizedAt,
  });
}

module.exports = {
  updateFromMP,
  // export mapping in case controllers need it
  mapMpToCanonicalStatus,
};
