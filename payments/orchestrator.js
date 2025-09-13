// payments/orchestrator.js
'use strict';

/**
 * Payments Orchestrator
 * ---------------------
 * Single responsibility: keep `public.zodika_requests` in sync with the
 * latest payment snapshot (provider-agnostic view).
 *
 * It does NOT trigger product workflows. Handlers per produto fazem isso.
 */

const db = require('../db/db');
const baseLogger = require('../utils/logger').child('payments.orchestrator');

/* -------------------------- Status mapping (MP) --------------------------- */

function mapMpToNormalizedStatus(mpStatus) {
  switch (String(mpStatus || '').toLowerCase()) {
    case 'approved':       return 'PAID';
    case 'pending':
    case 'in_process':     return 'PENDING';
    case 'rejected':       return 'REJECTED';
    case 'cancelled':
    case 'canceled':       return 'CANCELED';
    case 'refunded':       return 'REFUNDED';
    case 'charged_back':   return 'CHARGED_BACK';
    case 'expired':        return 'EXPIRED';
    default:               return 'UPDATED'; // fallback técnico; não é mostrado no UI
  }
}

/* ------------------------------ Helpers ---------------------------------- */

function toCents(amount) {
  if (amount == null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  // MP manda BRL como decimal (ex.: 35.00) → guardar em centavos
  return Math.round(n * 100);
}

function toDateOrNull(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/* ------------------------------ Snapshots -------------------------------- */

/**
 * snapshotCheckoutCreated
 * -----------------------
 * Called when a checkout preference is created (no payment yet).
 * Writes provider=MP, status=CREATED, checkout_id, link, amount, currency.
 */
async function snapshotCheckoutCreated({ requestId, checkoutId, link, amountCents, currency = 'BRL' }) {
  const log = baseLogger.child('snapshot.created', { requestId, checkoutId });
  const sql = `
    UPDATE public.zodika_requests
       SET payment_provider      = 'MP',
           payment_status        = 'CREATED',
           payment_status_detail = NULL,
           payment_amount_cents  = $2,
           payment_currency      = $3,
           payment_checkout_id   = $4,
           payment_payment_id    = NULL,
           payment_link          = $5,
           payment_authorized_at = NULL,
           payment_updated_at    = NOW(),
           updated_at            = NOW()
     WHERE request_id            = $1
  `;
  const params = [requestId, amountCents ?? null, currency ?? null, checkoutId ?? null, link ?? null];

  try {
    const t0 = Date.now();
    const res = await db.query(sql, params);
    log.info({ durationMs: Date.now() - t0, rowCount: res.rowCount }, 'checkout created snapshot upserted');
  } catch (err) {
    log.error({ err: err.message }, 'checkout created snapshot failed');
  }
}

/**
 * updateFromMP
 * ------------
 * Called from MP payment webhook with the full `payment` object.
 * Updates the request row to reflect the latest provider state.
 *
 * opts:
 *  - requestId: number (preferido; vem de external_reference)
 *  - preferenceId: string (fallback quando não há requestId)
 *  - link: string (opcional; init_point salvo no mp_request)
 */
async function updateFromMP(payment, opts = {}) {
  const requestId   = Number(opts.requestId);
  const preferenceId = opts.preferenceId || null;
  const link         = opts.link ?? null;

  // Guard: precisamos pelo menos do requestId numérico OU fallback por preferenceId
  if (!Number.isFinite(requestId) && !preferenceId) return;

  const log = baseLogger.child('update.mp', { requestId, preferenceId });

  const normalizedStatus = mapMpToNormalizedStatus(payment?.status);
  const statusDetail     = payment?.status_detail || null;
  const amountCents      = toCents(payment?.transaction_amount);
  const currency         = payment?.currency_id || 'BRL';
  const paymentId        = payment?.id ? String(payment.id) : null;
  const authAt           = toDateOrNull(payment?.date_approved);

  // Prefer update by request_id; if request_id ausente (caso raro), atualiza por checkout_id.
  const sqlByRequestId = `
    UPDATE public.zodika_requests
       SET payment_provider      = 'MP',
           payment_status        = $2,
           payment_status_detail = $3,
           payment_amount_cents  = $4,
           payment_currency      = $5,
           payment_checkout_id   = COALESCE($6, payment_checkout_id),
           payment_payment_id    = $7,
           payment_link          = COALESCE($8, payment_link),
           payment_authorized_at = $9,
           payment_updated_at    = NOW(),
           updated_at            = NOW()
     WHERE request_id            = $1
  `;

  const sqlByCheckoutId = `
    UPDATE public.zodika_requests
       SET payment_provider      = 'MP',
           payment_status        = $2,
           payment_status_detail = $3,
           payment_amount_cents  = $4,
           payment_currency      = $5,
           payment_checkout_id   = COALESCE($6, payment_checkout_id),
           payment_payment_id    = $7,
           payment_link          = COALESCE($8, payment_link),
           payment_authorized_at = $9,
           payment_updated_at    = NOW(),
           updated_at            = NOW()
     WHERE payment_checkout_id   = $10
  `;

  const paramsCommon = [
    normalizedStatus,                 // $2
    statusDetail,                     // $3
    amountCents,                      // $4
    currency,                         // $5
    preferenceId || payment?.preference_id || null, // $6
    paymentId,                        // $7
    link,                             // $8
    authAt,                           // $9
  ];

  try {
    const t0 = Date.now();
    if (Number.isFinite(requestId)) {
      await db.query(sqlByRequestId, [requestId, ...paramsCommon]);
      log.info({ durationMs: Date.now() - t0 }, 'payment snapshot updated (by request_id)');
    } else {
      await db.query(sqlByCheckoutId, [...paramsCommon, preferenceId]);
      log.info({ durationMs: Date.now() - t0 }, 'payment snapshot updated (by checkout_id)');
    }
  } catch (err) {
    log.error({ err: err.message }, 'payment snapshot update failed');
  }
}

module.exports = {
  snapshotCheckoutCreated,
  updateFromMP,
};
