// payments/orchestrator.js
'use strict';

/**
 * Payments Orchestrator
 * ---------------------
 * Single responsibility: keep `public.zodika_requests` in sync with the
 * latest payment snapshot (provider-agnostic view), and emit a single,
 * normalized domain event: 'payments:status-changed'.
 *
 * It does NOT trigger product workflows. Product handlers subscribe to
 * the event bus (see modules/*/handler.js).
 */

const { EventEmitter } = require('events');
const db = require('../db/db');
const baseLogger = require('../utils/logger').child('payments.orchestrator');

// Public event bus (singleton)
const events = new EventEmitter();

/* -------------------------- Status mapping (MP) --------------------------- */

function mapMpToNormalizedStatus(mpStatus) {
  switch (String(mpStatus || '').toLowerCase()) {
    case 'approved':       return 'PAID';       // MP "approved" → normalized "PAID"
    case 'pending':
    case 'in_process':     return 'PENDING';
    case 'rejected':       return 'REJECTED';
    case 'cancelled':
    case 'canceled':       return 'CANCELED';
    case 'refunded':       return 'REFUNDED';
    case 'charged_back':   return 'CHARGED_BACK';
    case 'expired':        return 'EXPIRED';
    default:               return 'UPDATED';    // technical fallback (rare)
  }
}

/* ------------------------------ Helpers ---------------------------------- */

function toCents(amount) {
  if (amount == null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function toDateOrNull(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Fetch basic request context to enrich emitted events (product_type, request_id).
 * Prefers request_id; falls back to payment_checkout_id.
 */
async function getRequestContext({ requestId, checkoutId }) {
  if (Number.isFinite(requestId)) {
    const { rows } = await db.query(
      `SELECT request_id, product_type FROM public.zodika_requests WHERE request_id = $1 LIMIT 1`,
      [requestId]
    );
    return rows[0] || null;
  }
  if (checkoutId) {
    const { rows } = await db.query(
      `SELECT request_id, product_type FROM public.zodika_requests WHERE payment_checkout_id = $1 LIMIT 1`,
      [checkoutId]
    );
    return rows[0] || null;
  }
  return null;
}

/* ------------------------------ Snapshots -------------------------------- */

/**
 * snapshotCheckoutCreated
 * -----------------------
 * Called when a checkout preference is created (no payment yet).
 * Writes provider=MP, status=CREATED, checkout_id, link, amount, currency,
 * and emits 'payments:status-changed' with normalizedStatus='CREATED'.
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

  // Best-effort enrichment for event payload (product_type)
  let ctx = null;
  try {
    ctx = await getRequestContext({ requestId, checkoutId });
  } catch (_) { /* ignore */ }

  // Emit normalized event for downstream product handlers
  try {
    events.emit('payments:status-changed', {
      requestId,
      productType: ctx?.product_type || null,
      provider: 'MP',
      normalizedStatus: 'CREATED',
      statusDetail: null,
      amountCents: amountCents ?? null,
      currency: currency ?? null,
      checkoutId: checkoutId ?? null,
      paymentId: null,
      authorizedAt: null,
      link: link ?? null,
    });
  } catch (e) {
    baseLogger.warn({ msg: e.message }, 'emit CREATED failed');
  }
}

/**
 * updateFromMP
 * ------------
 * Called from MP payment webhook with the full `payment` object.
 * Updates the request row to reflect the latest provider state and emits
 * 'payments:status-changed' with normalized status.
 *
 * opts:
 *  - requestId: number (preferred; comes from external_reference)
 *  - preferenceId: string (fallback when requestId is unavailable)
 *  - link: string (optional; init_point saved on mp_request)
 */
async function updateFromMP(payment, opts = {}) {
  const requestId    = Number(opts.requestId);
  const preferenceId = opts.preferenceId || payment?.preference_id || null;
  const link         = opts.link ?? null;

  // Guard: need at least numeric requestId OR a preferenceId fallback
  if (!Number.isFinite(requestId) && !preferenceId) return;

  const log = baseLogger.child('update.mp', { requestId, preferenceId });

  const normalizedStatus = mapMpToNormalizedStatus(payment?.status);
  const statusDetail     = payment?.status_detail || null;
  const amountCents      = toCents(payment?.transaction_amount);
  const currency         = payment?.currency_id || 'BRL';
  const paymentId        = payment?.id ? String(payment.id) : null;
  const authAt           = toDateOrNull(payment?.date_approved);

  // Prefer update by request_id; if missing, update by checkout_id.
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
    normalizedStatus,                       // $2
    statusDetail,                           // $3
    amountCents,                            // $4
    currency,                               // $5
    preferenceId,                           // $6
    paymentId,                              // $7
    link,                                   // $8
    authAt,                                 // $9
  ];

  // Enrich event with product_type / possibly resolve request_id by checkout
  let ctx = null;
  try {
    ctx = await getRequestContext({ requestId, checkoutId: preferenceId });
  } catch (_) { /* ignore */ }

  const effectiveRequestId = Number.isFinite(requestId)
    ? requestId
    : (ctx?.request_id ?? null);

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

  // Emit normalized event for downstream product handlers
  try {
    events.emit('payments:status-changed', {
      requestId: effectiveRequestId,
      productType: ctx?.product_type || null,
      provider: 'MP',
      normalizedStatus,               // e.g., 'PAID', 'PENDING', ...
      statusDetail,
      amountCents,
      currency,
      checkoutId: preferenceId || null,
      paymentId,
      authorizedAt: authAt,
      link: link ?? null,
    });
  } catch (e) {
    baseLogger.warn({ msg: e.message }, 'emit status-changed failed');
  }
}

module.exports = {
  events,                    // <<-- IMPORTANT: exported EventEmitter (fixes the crash)
  snapshotCheckoutCreated,
  updateFromMP,
};
