// payments/orchestrator.js
'use strict';

/**
 * Payments Orchestrator (v1)
 * --------------------------
 * Single responsibility:
 *   Keep `public.zodika_requests` in sync with payment status snapshots.
 *
 * Scope (v1):
 *   - Listens to Mercado Pago service events and updates the request row:
 *       payment_provider, payment_status, payment_id, payment_order_id,
 *       payment_method_id, payment_amount, payment_currency, payment_updated_at.
 *   - Product-specific workflows (timezone, ephemeris, Make, emails, etc.)
 *     are explicitly out of scope here and should live under each product module.
 *
 * Notes:
 *   - Today, Mercado Pago service emits `payment:paid` on APPROVED.
 *     This orchestrator also listens to an optional `payment:updated`
 *     (non-breaking). If/when you emit it, all statuses will be reflected.
 *   - Safe-by-default: failures are logged and do not throw upstream.
 */

const db = require('../db/db');
const logger = require('../utils/logger').child('payments.orchestrator');

// Providers
const mpService = require('./mercadoPago/service');
const mpRepository = require('./mercadoPago/repository');

// ----------------------------- Status normalization -----------------------------

/**
 * Normalize provider status into a compact, product-agnostic set.
 * Keep it conservative and stable — UI can key off these values.
 */
function normalizeStatus(provider, status, statusDetail) {
  const s = String(status || '').toLowerCase();
  switch (provider) {
    case 'MERCADO_PAGO': {
      if (s === 'approved') return 'APPROVED';
      if (s === 'in_process' || s === 'pending') return 'PENDING';
      if (s === 'rejected') return 'REJECTED';
      if (s === 'cancelled' || s === 'canceled') return 'CANCELED';
      if (s === 'refunded') return 'REFUNDED';
      if (s === 'charged_back') return 'CHARGED_BACK';
      if (s === 'authorized') return 'AUTHORIZED';
      if (s === 'expired') return 'EXPIRED';
      // Fallback preserves detail for diagnostics while remaining compact
      return statusDetail ? String(statusDetail).toUpperCase() : 'UPDATED';
    }
    default:
      return status ? String(status).toUpperCase() : 'UPDATED';
  }
}

// ----------------------------- Snapshot builders --------------------------------

/**
 * Build snapshot fields from an MP payment DB record (mp_payments joined via repository).
 * `record` is the result from mpRepository.findByPaymentId(paymentId).
 */
function buildMpSnapshot(record) {
  if (!record) return null;

  // `raw` holds the sanitized provider JSON we stored earlier.
  const raw = record.raw || {};

  // Prefer explicit fields, fall back to nested objects as MP may vary by flow.
  const orderId =
    raw?.order?.id ??
    raw?.merchant_order_id ??
    null;

  const methodId =
    raw?.payment_method?.id ??
    raw?.payment_method_id ??
    null;

  const amount =
    typeof record.transaction_amount === 'number'
      ? record.transaction_amount
      : (typeof raw?.transaction_amount === 'number' ? raw.transaction_amount : null);

  const currency =
    raw?.currency_id ??
    'BRL';

  // Normalize status
  const normalized = normalizeStatus('MERCADO_PAGO', record.status, record.status_detail);

  return {
    provider: 'MERCADO_PAGO',
    status: normalized,
    paymentId: String(record.payment_id),
    orderId: orderId ? String(orderId) : null,
    methodId: methodId ? String(methodId) : null,
    amount: amount != null ? Number(amount) : null, // store in unit currency (e.g., BRL = 35.00)
    currency: currency ? String(currency) : null,
  };
}

// ----------------------------- Persistence -------------------------------------

/**
 * Update the payment snapshot on the request row.
 * Only the payment_* columns are touched; other columns remain intact.
 */
async function updateRequestPaymentSnapshot(requestId, snap) {
  if (!requestId || !snap) return null;

  const sql = `
    UPDATE public.zodika_requests
       SET payment_provider   = $2,
           payment_status     = $3,
           payment_id         = $4,
           payment_order_id   = $5,
           payment_method_id  = $6,
           payment_amount     = $7,   -- numeric(12,2) recommended
           payment_currency   = $8,
           payment_updated_at = NOW()
     WHERE request_id = $1
    RETURNING request_id;
  `;

  const params = [
    Number(requestId),
    snap.provider,
    snap.status,
    snap.paymentId,
    snap.orderId,
    snap.methodId,
    snap.amount,
    snap.currency,
  ];

  try {
    const { rows } = await db.query(sql, params);
    if (!rows.length) {
      logger.warn({ requestId }, 'payment snapshot update: request not found');
      return null;
    }
    logger.info(
      { requestId, provider: snap.provider, status: snap.status, paymentId: snap.paymentId },
      'payment snapshot updated'
    );
    return rows[0];
  } catch (err) {
    logger.error(
      { requestId, err: err?.message },
      'payment snapshot update failed'
    );
    return null;
  }
}

// ----------------------------- Handlers ----------------------------------------

/**
 * Handle an MP payment update by payment_id.
 * - Looks up the enriched payment record to find the linked request_id.
 * - Builds a compact snapshot and persists it in zodika_requests.
 */
async function handleMpPaymentUpdateById(paymentId) {
  try {
    const rec = await mpRepository.findByPaymentId(paymentId);
    if (!rec) {
      logger.warn({ paymentId }, 'no mp_payments record found');
      return;
    }

    const requestId = rec.request_id || null;
    if (!requestId) {
      logger.warn({ paymentId }, 'mp_payments record has no linked request_id yet');
      return;
    }

    const snap = buildMpSnapshot(rec);
    if (!snap) return;

    await updateRequestPaymentSnapshot(requestId, snap);
  } catch (err) {
    logger.error({ paymentId, err: err?.message }, 'handleMpPaymentUpdateById failed');
  }
}

/**
 * Handle an MP payment update when the event already carries requestId and raw status.
 * This path is used for the existing `payment:paid` event.
 */
async function handleMpPaidEvent(evt) {
  try {
    const { requestId, paymentId } = evt || {};
    if (!paymentId) return;

    // Prefer DB record to extract method/order/amount consistently
    const rec = await mpRepository.findByPaymentId(paymentId);
    if (!rec) {
      logger.warn({ paymentId }, 'no mp_payments record found on paid event');
      return;
    }

    const reqId = requestId || rec.request_id || null;
    if (!reqId) {
      logger.warn({ paymentId }, 'paid event has no requestId and join did not resolve it');
      return;
    }

    const snap = buildMpSnapshot(rec);
    if (!snap) return;

    await updateRequestPaymentSnapshot(reqId, snap);
  } catch (err) {
    logger.error({ err: err?.message }, 'handleMpPaidEvent failed');
  }
}

// ----------------------------- Wiring (Event subscriptions) --------------------

let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;

  // Existing event in service.js (fires on APPROVED)
  mpService.events.on('payment:paid', (evt) => {
    // Run async without blocking the emitter path
    setImmediate(() => handleMpPaidEvent(evt));
  });

  // Optional event for ALL statuses (safe to register even if not emitted yet)
  // If you later emit `events.emit('payment:updated', { paymentId })` in the MP webhook,
  // the orchestrator will keep zodika_requests in sync for every status change.
  mpService.events.on('payment:updated', (evt) => {
    const paymentId = evt && (evt.paymentId || evt.payment_id);
    if (!paymentId) return;
    setImmediate(() => handleMpPaymentUpdateById(String(paymentId)));
  });

  logger.info('payments orchestrator initialized');
}

// Auto-init on require, but also export init() for explicit bootstrap if preferred.
init();

module.exports = { init };
