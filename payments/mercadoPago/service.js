// payments/mercadoPago/service.js
'use strict';

/**
 * Mercado Pago Service
 * --------------------
 * Responsibilities
 *  - Create checkout preferences (hosted checkout).
 *  - Process webhooks and upsert normalized records.
 *  - Emit domain events ("payment:paid") on APPROVED.
 *
 * Non-functional
 *  - Exponential backoff (utils/httpClient) + explicit timeouts.
 *  - HTTPS URL normalization and length bounds for safety.
 *  - Structured logging with request correlation (no PII).
 *  - Optional Prometheus metrics (gracefully disabled if absent).
 *
 * API
 *  - createCheckout(input, ctx?) -> { url, preferenceId }
 *  - processWebhook(body, meta, ctx?) -> { ok, ... }
 *  - events (EventEmitter)
 */

const httpClient = require('../../utils/httpClient');
const crypto = require('crypto');
const EventEmitter = require('events');
const baseLogger = require('../../utils/logger').child('payments.mp');
const { AppError } = require('../../utils/appError');
const { env } = require('../../config/env');
const { get: getSecret } = require('../../config/secretProvider');
const mpRepository = require('./repository');

const events = new EventEmitter();
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/* --------------------------------- Metrics (optional) -------------------------------- */
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

/* --------------------------------- Helpers ------------------------------------------ */

/** Trim quotes and dangling separators that might sneak in via CMS/spreadsheets. */
function stripQuotesAndSemicolons(u) {
  if (!u) return null;
  let s = String(u).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
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

/** Build a stable idempotency key per business entity (requestId). */
function buildIdempotencyKey(requestId) {
  // Stable key ensures MP dedupes across retries and user double-submits.
  return `zdk:mp:pref:${String(requestId)}`;
}

/** Map Mercado Pago payment.status → internal request status. */
function mapPreferenceStatusFromPayment(paymentStatus) {
  switch ((paymentStatus || '').toLowerCase()) {
    case 'approved': return 'APPROVED';
    case 'in_process':
    case 'pending':  return 'PENDING';
    case 'rejected': return 'REJECTED';
    case 'refunded':
    case 'charged_back': return 'REFUNDED';
    case 'cancelled':
    case 'canceled': return 'CANCELED';
    default: return 'UPDATED';
  }
}

/** Resolve MP access token using secret provider (fallback to ENV). */
async function resolveMpAccessToken() {
  // Prefer external secret manager; fallback to validated env var
  const fromProvider = await getSecret('MP_ACCESS_TOKEN').catch(() => null);
  return fromProvider || env.MP_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN || null;
}

/* --------------------------------- API calls ---------------------------------------- */

/**
 * Create a hosted checkout preference on Mercado Pago.
 * Notes:
 *  - Amount is provided in cents; we convert to BRL with 2 decimals.
 *  - Boleto is excluded by default (only PIX + credit card).
 *  - Idempotency via stable `X-Idempotency-Key` derived from requestId.
 */
async function createCheckout(input, ctx = {}) {
  const {
    requestId, name, email, productType,
    productValue, productName, paymentOptions,
    currency, productImageUrl, returnUrl, metadata = {},
  } = input || {};

  const log = (ctx.log || baseLogger).child('create', { rid: ctx.requestId });

  if (!requestId) throw AppError.fromUnexpected('mp_checkout_failed', 'requestId is required', { status: 400 });

  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0) {
    throw AppError.fromUnexpected('mp_checkout_failed', 'invalid productValue (cents, integer > 0)', { status: 400 });
  }

  const token = await resolveMpAccessToken();
  const isProd = (process.env.NODE_ENV || 'production') === 'production';
  if (isProd && !token) {
    // Fail closed in production rather than creating unpaid flows.
    throw AppError.fromUpstream('mp_checkout_failed', 'Mercado Pago token unavailable', null, { provider: 'mercadopago' });
  }
  if (!token) {
    // Non-prod: allow local testing without secret provider.
    log.warn('Mercado Pago token not configured; attempting request may fail in dev.');
  }

  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://backend-form-webflow-production.up.railway.app';

  // back_urls (validated) + notification target
  const FAILURE_URL = process.env.PAYMENT_FAILURE_URL || env.PAYMENT_FAILURE_URL;
  const success = normalizeHttpsUrl(returnUrl) || normalizeHttpsUrl(`${PUBLIC_BASE_URL}/mercadopago/return/success`);
  const failure = normalizeHttpsUrl(FAILURE_URL || `${PUBLIC_BASE_URL}/payment-fail`);
  const pending = normalizeHttpsUrl(`${PUBLIC_BASE_URL}/mercadopago/return/pending`);
  const notification_url = normalizeHttpsUrl(process.env.MP_WEBHOOK_URL || env.MP_WEBHOOK_URL);

  // product image for MP UI (optional)
  const picture_url = normalizeHttpsUrl(productImageUrl, { max: 512 }) || null;

  // cents → reais
  const amount = Math.round(valueNum) / 100;

  // Accept PIX and/or Credit Card; explicitly exclude boleto.
  const allowPix  = !!(paymentOptions && paymentOptions.allow_pix);
  const allowCard = !!(paymentOptions && paymentOptions.allow_card);
  const maxInst   = Number((paymentOptions && paymentOptions.max_installments) ?? 1);

  const excluded_payment_types = [{ id: 'ticket' }];
  if (!allowCard) excluded_payment_types.push({ id: 'credit_card' });

  const excluded_payment_methods = [];
  if (!allowPix) excluded_payment_methods.push({ id: 'pix' });

  const payment_methods = {
    excluded_payment_types,
    excluded_payment_methods,
    installments: maxInst,
    default_installments: Math.min(Math.max(1, maxInst), 12),
  };

  // Metadata: keep bounded to avoid upstream rejections
  const safeMetadata = (() => {
    try {
      const raw = { source: 'webflow', ...metadata };
      const str = JSON.stringify(raw);
      return str.length > 2000 ? { source: 'webflow' } : raw;
    } catch {
      return { source: 'webflow' };
    }
  })();

  const preferencePayload = {
    external_reference: String(requestId),
    items: [{
      title: productName || productType || 'Produto',
      quantity: 1,
      unit_price: amount,
      currency_id: currency || 'BRL',
      ...(picture_url ? { picture_url } : {}),
    }],
    payer: (name || email) ? { name, email } : undefined,
    back_urls: { success, failure, pending },
    auto_return: 'approved',
    notification_url: notification_url || undefined,
    metadata: safeMetadata,
    // binary_mode: true, // optional: skip intermediate "pending"
    payment_methods,
  };

  const op = 'create_preference';
  const t0 = process.hrtime.bigint();
  const url = 'https://api.mercadopago.com/checkout/preferences';

  try {
    const res = await httpClient.post(url, preferencePayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // Stable key → MP dedupes duplicates and our internal httpClient retries.
        'X-Idempotency-Key': buildIdempotencyKey(requestId),
      },
      timeout: 20_000,
      retries: 2,
      retryBackoffMs: [0, 250, 700],
    });

    observe(op, res?.status, t0);
    log.info({ status: res?.status }, 'preference created');

    const data = res?.data || {};
    const preferenceId = data.id || null;
    const initPoint = data.init_point || data.sandbox_init_point || null;
    if (!initPoint) {
      throw AppError.fromUnexpected('mp_checkout_failed', 'init_point not found in Mercado Pago response');
    }

    // Persist request checkout (ensure external_reference recorded)
    await mpRepository.createCheckout({
      request_id: String(requestId),
      external_reference: String(requestId),
      product_type: productType,
      preference_id: preferenceId,
      status: 'CREATED',
      value: valueNum,
      link: initPoint,
      customer: (name || email) ? { name, email } : null,
      raw: data,
    });

    // Best-effort audit trail (payload sanitized in repository)
    try {
      await mpRepository.logEvent({
        event_uid: `preference_created_${preferenceId || requestId}`,
        payload: { response: { id: preferenceId, has_init_point: !!initPoint } }, // keep minimal
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

    log.info({ preferenceId, host: safeHost(initPoint) }, 'checkout ready');
    return { url: initPoint, preferenceId };
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    log.error({ status: e?.response?.status, msg: e?.message }, 'create preference failed');
    // Normalize upstream error into AppError with standardized code
    throw AppError.fromUpstream(
      'mp_checkout_failed',
      'Failed to create checkout with Mercado Pago',
      e,
      { provider: 'mercadopago', endpoint: url }
    );
  }
}

/** Fetch full payment details; used by webhook reconciliation. */
async function fetchPayment(paymentId, ctx = {}) {
  const log = (ctx.log || baseLogger).child('fetch', { rid: ctx.requestId });
  if (!paymentId) return null;

  const token = await resolveMpAccessToken();
  if (!token) {
    log.warn({ paymentId }, 'access token unavailable while fetching payment');
    return null;
  }

  const op = 'get_payment';
  const t0 = process.hrtime.bigint();
  const url = `https://api.mercadopago.com/v1/payments/${paymentId}`;

  try {
    const res = await httpClient.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 15_000,
      retries: 3,
      retryBackoffMs: [0, 250, 600, 1200],
    });
    observe(op, res?.status, t0);
    return res?.data || null;
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    log.error({ paymentId, status: e?.response?.status, msg: e?.message }, 'fetch payment failed');
    return null;
  }
}

/* -------------------------------- Webhook handler ----------------------------------- */

/**
 * Process an authenticated webhook (idempotent).
 *  1) Persist raw event for audit (headers/query/body).
 *  2) If topic=payment, fetch full payment and upsert normalized row.
 *  3) Update request status (approved/pending/rejected/…).
 *  4) Emit "payment:paid" on APPROVED.
 *
 * Note: Tolerant handler — returns { ok:false } on failure to avoid 5xx to the provider.
 */
async function processWebhook(body, meta = {}, ctx = {}) {
  const log = (ctx.log || baseLogger).child('webhook', { rid: ctx.requestId });

  try {
    // Normalize v1/v2 feed shapes
    const type = meta?.query?.type || meta?.query?.topic || meta?.topic || body?.type || null;
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

      const payment_id = String(payment.id);
      const status = payment.status;
      const status_detail = payment.status_detail;
      const external_reference = payment.external_reference || null;
      let   preference_id = payment.preference_id || null;
      const amount = Number(payment.transaction_amount || 0);

      const payer = payment.payer || {};
      const billing = payment.additional_info?.payer?.address || null;

      await mpRepository.upsertPaymentByPaymentId({
        payment_id,
        preference_id,
        status,
        status_detail,
        external_reference,
        customer: {
          name: payer?.first_name || payer?.name || null,
          email: payer?.email || null,
          tax_id: payer?.identification?.number || null,
          phone_country: null,
          phone_area: null,
          phone_number: payer?.phone?.number || null,
          address_json: billing ? billing : null,
        },
        transaction_amount: amount,
        date_created: payment?.date_created || null,
        date_approved: payment?.date_approved || null,
        date_last_updated: payment?.date_last_updated || payment?.last_updated || null,
        raw: payment,
      });

      const reqStatus = mapPreferenceStatusFromPayment(status);
      let updatedReq = null;

      if (preference_id) {
        updatedReq = await mpRepository.updateRequestStatusByPreferenceId(preference_id, reqStatus, payment);
      } else if (external_reference) {
        // Align with repository semantics: external_reference is TEXT from MP
        updatedReq = await mpRepository.updateRequestStatusByExternalReference(external_reference, reqStatus, payment);
        if (updatedReq?.preference_id) {
          preference_id = updatedReq.preference_id;
          await mpRepository.attachPaymentToPreference(payment_id, preference_id);
        }
      }

      if ((status || '').toLowerCase() === 'approved') {
        const record = (payment_id
          ? await mpRepository.findByPaymentId(payment_id)
          : preference_id
          ? await mpRepository.findByPreferenceId(preference_id)
          : external_reference
          ? await mpRepository.findByExternalReference(external_reference)
          : null);

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
    // Keep behavior tolerant but log with a standardized code for observability.
    const wrapped = AppError.fromUnexpected('mp_webhook_failed', 'Error processing Mercado Pago webhook', { cause: err });
    log.error({ code: wrapped.code, msg: wrapped.message }, 'webhook processing failed');
    return { ok: false, error: wrapped.code };
  }
}

module.exports = { createCheckout, processWebhook, events };
