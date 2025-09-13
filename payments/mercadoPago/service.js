// payments/mercadoPago/service.js
'use strict';

/**
 * Mercado Pago Service
 * --------------------
 * Responsibilities
 *   - Create checkout preferences (hosted checkout) and return the checkout URL.
 *   - Process webhooks and upsert normalized records.
 *   - Emit domain events ("payment:paid") on APPROVED.
 *
 * Production notes
 *   - Preference creation is the critical path for UX. We respond as soon as the
 *     provider returns a valid checkout URL. DB persistence and audit logs run
 *     asynchronously (fire-and-forget) by default to keep the request fast.
 *   - Time budgets are tight to avoid client-side timeouts (499/AbortError).
 *
 * API
 *   - createCheckout(input, ctx?) -> { url, preferenceId }
 *       input fields:
 *         - requestId (required)
 *         - externalReference (optional; defaults to requestId)
 *         - name, email, productType, productValue, productName, paymentOptions,
 *           currency, productImageUrl, returnUrl, metadata
 *   - processWebhook(body, meta, ctx?) -> { ok, ... }
 *   - events (EventEmitter)
 */

const httpClient = require('../../utils/httpClient');
const crypto = require('crypto');
const EventEmitter = require('events');
const baseLogger = require('../../utils/logger').child('payments.mp');
const { AppError } = require('../../utils/appError');
const { env } = require('../../config/env');
const mpRepository = require('./repository');

const events = new EventEmitter();

// Simple UUID fallback
const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/* ------------------------------- Metrics (optional) -------------------------------- */

let prom = null;
try { prom = require('prom-client'); } catch { /* metrics disabled */ }

const mpHistogram = prom
  ? new prom.Histogram({
      name: 'zodika_mp_call_duration_seconds',
      help: 'Mercado Pago call duration',
      labelNames: ['operation', 'status'],
      buckets: [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5],
    })
  : null;

function observe(op, status, startNs) {
  if (!mpHistogram) return;
  const dur = (process.hrtime.bigint() - startNs) / BigInt(1e9);
  mpHistogram.labels(op, String(status || 'ERR')).observe(Number(dur));
}

/* --------------------------------- Helpers ----------------------------------------- */

/** Strip wrapping quotes and trailing semicolons/spaces. */
function stripQuotesAndSemicolons(u) {
  if (!u) return null;
  let s = String(u).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/[.;\s]+$/g, '');
  return s;
}

/** Accept only well-formed HTTPS URLs with bounded length; return null if invalid. */
function normalizeHttpsUrl(u, { max = 255 } = {}) {
  const s = stripQuotesAndSemicolons(u);
  if (!s) return null;
  if (!/^https:\/\/[^\s<>"]+$/i.test(s)) return null;
  if (s.length > max) return null;
  return s;
}

/** Safe host extraction for logs (never log full URLs to avoid query/PII leaks). */
function safeHost(u) {
  try { return new URL(u).host; } catch { return undefined; }
}

/** Map Mercado Pago payment.status → internal request status. */
function mapPreferenceStatusFromPayment(paymentStatus) {
  switch ((paymentStatus || '').toLowerCase()) {
    case 'approved':       return 'APPROVED';
    case 'in_process':
    case 'pending':        return 'PENDING';
    case 'rejected':       return 'REJECTED';
    case 'refunded':
    case 'charged_back':   return 'REFUNDED';
    case 'cancelled':
    case 'canceled':       return 'CANCELED';
    default:               return 'UPDATED';
  }
}

/** Deterministic idempotency key (short and stable per logical request). */
function buildIdempotencyKey(requestId) {
  return `mp-pref-${String(requestId).slice(0, 64)}`;
}

/* --------------------------------- createCheckout ---------------------------------- */

/**
 * Create a hosted checkout preference on Mercado Pago.
 * UX-first strategy:
 *   1) Call provider with a tight timeout (default 8s).
 *   2) If success → return checkout URL immediately.
 *   3) Persist and audit asynchronously (fire-and-forget) to avoid blocking.
 */
async function createCheckout(input, ctx = {}) {
  const {
    requestId, name, email, productType,
    productValue, productName, paymentOptions,
    currency, productImageUrl, returnUrl, metadata = {},
    externalReference, // NEW: optional external reference; falls back to requestId
  } = input || {};

  const log = (ctx.log || baseLogger).child('create', { rid: ctx.requestId });

  // Guards
  if (!requestId) {
    throw AppError.fromUnexpected('mp_checkout_failed', 'requestId is required', { status: 400 });
  }

  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || env.MP_ACCESS_TOKEN;
  if (!MP_ACCESS_TOKEN) {
    throw AppError.fromUnexpected('mp_config_missing', 'MP_ACCESS_TOKEN is not configured', { status: 500 });
  }

  // Product amount in integer cents (>0)
  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0 || !Number.isInteger(valueNum)) {
    throw AppError.fromUnexpected(
      'mp_checkout_failed',
      'invalid productValue (must be integer cents > 0)',
      { status: 400 }
    );
  }

  const PUBLIC_BASE_URL =
    process.env.PUBLIC_BASE_URL || 'https://backend-form-webflow-production.up.railway.app';

  // Back URLs (validated) + webhook
  const FAILURE_URL = process.env.PAYMENT_FAILURE_URL;
  const success = normalizeHttpsUrl(returnUrl)
    || normalizeHttpsUrl(`${PUBLIC_BASE_URL}/mercadoPago/return/success`);
  const failure = normalizeHttpsUrl(FAILURE_URL || `${PUBLIC_BASE_URL}/payment-fail`);
  const pending = normalizeHttpsUrl(`${PUBLIC_BASE_URL}/mercadoPago/return/pending`);
  const notification_url = normalizeHttpsUrl(process.env.MP_WEBHOOK_URL);

  // Optional image for MP checkout UI
  const picture_url = normalizeHttpsUrl(productImageUrl, { max: 512 }) || null;

  // cents → reais
  const amount = Math.round(valueNum) / 100;

  // Payment method rules (exclude boleto)
  const allowPix  = !!(paymentOptions && paymentOptions.allow_pix);
  const allowCard = !!(paymentOptions && paymentOptions.allow_card);
  const maxInstRaw = Number((paymentOptions && paymentOptions.max_installments) ?? 1);
  const maxInst = Number.isFinite(maxInstRaw) ? Math.min(Math.max(1, maxInstRaw), 12) : 1;

  const excluded_payment_types = [{ id: 'ticket' }]; // exclude boleto
  if (!allowCard) excluded_payment_types.push({ id: 'credit_card' });

  const excluded_payment_methods = [];
  if (!allowPix) excluded_payment_methods.push({ id: 'pix' });

  const payer = (name || email)
    ? {
        name:  name  ? String(name).trim().slice(0, 120)  : undefined,
        email: email ? String(email).trim().slice(0, 180) : undefined,
      }
    : undefined;

  const payment_methods = {
    excluded_payment_types,
    excluded_payment_methods,
    installments: maxInst,
    default_installments: maxInst,
  };

  // Choose the value we will send to MP and persist locally
  const extRef = externalReference != null ? String(externalReference) : String(requestId);

  const preferencePayload = {
    external_reference: extRef,
    items: [{
      title: (productName || productType || 'Produto').toString().slice(0, 150),
      quantity: 1,
      unit_price: amount,
      currency_id: currency || 'BRL',
      ...(picture_url ? { picture_url } : {}),
    }],
    payer,
    back_urls: { success, failure, pending },
    auto_return: 'approved',
    notification_url: notification_url || undefined,
    metadata: { source: 'webflow', ...metadata },
    // binary_mode: true, // optional: skip "pending" intermediate state
    payment_methods,
  };

  const op = 'create_preference';
  const t0 = process.hrtime.bigint();
  const url = 'https://api.mercadopago.com/checkout/preferences';

  // Tight budget (env-tunable). Defaults aim to avoid 20s+ client aborts.
  const PER_ATTEMPT_TIMEOUT_MS = Number(process.env.MP_HTTP_TIMEOUT_MS || 8000); // default 8s
  const RETRIES = Number(process.env.MP_HTTP_RETRIES || 0);                      // default 0
  const RETRY_BACKOFF = [0, 250]; // used only if RETRIES > 0

  const options = {
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Idempotency-Key': buildIdempotencyKey(requestId),
    },
    timeout: PER_ATTEMPT_TIMEOUT_MS,
    retries: RETRIES,
    retryBackoffMs: RETRY_BACKOFF,
  };

  // Optional: propagate caller abort if provided by controller
  if (ctx.signal) options.signal = ctx.signal;

  try {
    const res = await httpClient.post(url, preferencePayload, options);
    observe(op, res?.status, t0);
    log.info({ status: res?.status }, 'preference created');

    const data = res?.data || {};
    const preferenceId = data.id || null;

    // Be resilient pulling a usable checkout URL
    const initPoint =
      data.init_point
      || data.sandbox_init_point
      || data?.point_of_interaction?.transaction_data?.ticket_url
      || data?.items?.[0]?.permalink
      || null;

    if (!initPoint) {
      throw AppError.fromUpstream(
        'mp_checkout_failed',
        'init_point not found in Mercado Pago response',
        { provider: 'mercadopago' }
      );
    }

    // Fire-and-forget persistence to keep response snappy (enabled by default)
    const persistAsync = String(process.env.MP_PERSIST_ASYNC || 'true').toLowerCase() === 'true';

    const persistWork = async () => {
      await mpRepository.createCheckout({
        request_id: String(requestId),
        external_reference: extRef, // <-- persist for reconciliation
        product_type: productType,
        preference_id: preferenceId,
        status: 'CREATED',
        value: valueNum,
        link: initPoint,
        customer: (payer ? { name: payer.name, email: payer.email } : null),
        raw: data,
      });

      // Best-effort audit trail
      try {
        await mpRepository.logEvent({
          event_uid: `preference_created_${preferenceId || requestId}`,
          payload: { request_payload: preferencePayload, response: data },
          headers: null,
          query: null,
          topic: 'preference',
          action: 'CREATED',
          preference_id: preferenceId,
          payment_id: null,
        });
      } catch (e) {
        log.warn({ msg: e?.message }, 'could not log preference creation event');
      }
    };

    if (persistAsync) {
      setImmediate(() => {
        persistWork().catch(err =>
          log.warn({ msg: err?.message }, 'persist async failed')
        );
      });
    } else {
      await persistWork();
    }

    log.info({ preferenceId, host: safeHost(initPoint) }, 'checkout ready');
    return { url: initPoint, preferenceId };
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    baseLogger.error(
      { status: e?.response?.status, msg: e?.message },
      'create preference failed'
    );

    // Normalize upstream error into AppError for consistent handling upstream
    throw AppError.fromUpstream(
      'mp_checkout_failed',
      'Failed to create checkout with Mercado Pago',
      e,
      { provider: 'mercadopago', endpoint: url }
    );
  }
}

/* --------------------------------- fetchPayment ------------------------------------ */

/**
 * Fetch payment details (used by webhook reconciliation).
 * Retries are conservative; timeouts bounded via env.
 */
async function fetchPayment(paymentId, ctx = {}) {
  const log = (ctx.log || baseLogger).child('fetch', { rid: ctx.requestId });
  if (!paymentId) return null;

  const op = 'get_payment';
  const t0 = process.hrtime.bigint();
  const url = `https://api.mercadopago.com/v1/payments/${paymentId}`;

  const timeoutMs = Number(process.env.MP_FETCH_TIMEOUT_MS || 15000);
  const retries   = Number(process.env.MP_FETCH_RETRIES || 2);

  try {
    const res = await httpClient.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN || env.MP_ACCESS_TOKEN}`,
        Accept: 'application/json',
      },
      timeout: timeoutMs,
      retries,
      retryBackoffMs: [0, 250, 600, 1200],
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    observe(op, res?.status, t0);
    return res?.data || null;
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    log.error({ paymentId, status: e?.response?.status, msg: e?.message }, 'fetch payment failed');
    return null;
  }
}

/* -------------------------------- Webhook handler ---------------------------------- */

async function processWebhook(body, meta = {}, ctx = {}) {
  const log = (ctx.log || baseLogger).child('webhook', { rid: ctx.requestId });

  try {
    // Normalize v1/v2 feed shapes
    const type  = meta?.query?.type || meta?.query?.topic || meta?.topic || body?.type || null;
    const action = body?.action || null;
    const dataId = meta?.query?.id || body?.data?.id || body?.id || null;
    const topic = (type || (action ? action.split('.')[0] : '') || '').toLowerCase();

    // Stable event UID for dedupe/audit
    const providerEventUid =
      (meta?.headers && (meta.headers['x-request-id'] || meta.headers['x-correlation-id'])) ||
      `${topic || 'event'}_${dataId || uuid()}_${Date.now()}`;

    const hintedPaymentId = dataId || body?.payment_id || null;

    await mpRepository.logEvent({
      event_uid: providerEventUid,
      payload: body,
      headers: meta.headers || null,
      query: meta.query || null,
      topic: topic || null,
      action: action || null,
      preference_id: null,
      payment_id: hintedPaymentId || null,
    });

    if (topic === 'payment' && hintedPaymentId) {
      const payment = await fetchPayment(hintedPaymentId, ctx);
      if (!payment) return { ok: true, note: 'payment details not found' };

      const payment_id        = String(payment.id);
      const status            = payment.status;
      const status_detail     = payment.status_detail;
      const external_reference = payment.external_reference || null;
      let   preference_id     = payment.preference_id || null;
      const amount            = Number(payment.transaction_amount || 0);

      const payer   = payment.payer || {};
      const billing = payment.additional_info?.payer?.address || null;

      await mpRepository.upsertPaymentByPaymentId({
        payment_id,
        preference_id,
        status,
        status_detail,
        external_reference,
        customer: {
          name:  payer?.first_name || payer?.name || null,
          email: payer?.email || null,
          tax_id: payer?.identification?.number || null,
          phone_country: null,
          phone_area: null,
          phone_number: payer?.phone?.number || null,
          address_json: billing ? billing : null,
        },
        transaction_amount: amount,
        date_created:     payment?.date_created || null,
        date_approved:    payment?.date_approved || null,
        date_last_updated: payment?.date_last_updated || payment?.last_updated || null,
        raw: payment,
      });

      const reqStatus = mapPreferenceStatusFromPayment(status);
      let updatedReq = null;

      if (preference_id) {
        updatedReq = await mpRepository.updateRequestStatusByPreferenceId(
          preference_id, reqStatus, payment
        );
      } else if (external_reference) {
        // NOTE: Currently assumes external_reference equals internal request_id.
        // If you ever diverge (e.g., use a custom code), switch to:
        // await mpRepository.updateRequestStatusByExternalReference(external_reference, reqStatus, payment);
        updatedReq = await mpRepository.updateRequestStatusByRequestId(
          external_reference, reqStatus, payment
        );
        if (updatedReq?.preference_id) {
          preference_id = updatedReq.preference_id;
          await mpRepository.attachPaymentToPreference(payment_id, preference_id);
        }
      }

      if ((status || '').toLowerCase() === 'approved') {
        const record = (
          payment_id        ? await mpRepository.findByPaymentId(payment_id)
        : preference_id      ? await mpRepository.findByPreferenceId(preference_id)
        : external_reference ? await mpRepository.findByRequestId(external_reference)
        : null
        );

        if (record) {
          const { request_id: requestId, product_type: productType } = record;
          events.emit('payment:paid', {
            requestId,
            productType,
            paymentId: payment_id,
            preferenceId: preference_id || record?.preference_id || null,
            raw: payment,
          });
          log.info({ paymentId: payment_id, preferenceId: preference_id || undefined }, 'payment approved');
        }
      }
    }

    return { ok: true };
  } catch (err) {
    const wrapped = AppError.fromUnexpected(
      'mp_webhook_failed',
      'Error processing Mercado Pago webhook',
      { cause: err }
    );
    log.error({ code: wrapped.code, msg: wrapped.message }, 'webhook processing failed');
    return { ok: false, error: wrapped.code };
  }
}

module.exports = { createCheckout, processWebhook, events };
