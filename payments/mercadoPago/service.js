'use strict';

/**
 * Mercado Pago Service
 * --------------------
 * - Create checkout preferences (hosted checkout).
 * - Process webhooks e upsert normalizado.
 * - Emite "payment:paid" para downstream.
 *
 * Extras:
 * - URLs seguras (HTTPS + tamanho).
 * - Timeouts/retries pelo utils/httpClient.
 * - Logger estruturado por contexto (ctx.log) com correlação.
 * - Métricas Prometheus opcionais (sem hard dep).
 */

const httpClient = require('../../utils/httpClient');
const crypto = require('crypto');
const EventEmitter = require('events');
const baseLogger = require('../../utils/logger').child('payments.mp');
const { env } = require('../../config/env');
const mpRepository = require('./repository');

const events = new EventEmitter();
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/* --------------------------- Métricas (opcional) --------------------------- */
let prom = null;
try { prom = require('prom-client'); } catch (_) { /* metrics disabled */ }

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

/* -------------------------------- Helpers --------------------------------- */
const stripQuotesAndSemicolons = (u) => {
  if (!u) return null;
  let s = String(u).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  s = s.replace(/[.;\s]+$/g, '');
  return s;
};

const normalizeHttpsUrl = (u, { max = 255 } = {}) => {
  const s = stripQuotesAndSemicolons(u);
  if (!s) return null;
  if (!/^https:\/\/[^\s<>"]+$/i.test(s)) return null;
  if (s.length > max) return null;
  return s;
};

const mapPreferenceStatusFromPayment = (paymentStatus) => {
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
};

/* ------------------------------- API calls ------------------------------- */

/**
 * Cria uma preference (hosted checkout) no MP.
 */
async function createCheckout({
  requestId, name, email, productType,
  productValue, productName, paymentOptions,
  currency, productImageUrl, returnUrl, metadata = {},
}, ctx = {}) {
  const log = (ctx?.log || baseLogger).child('createCheckout');
  if (!requestId) throw new Error('requestId is required');

  // productValue em centavos
  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0) throw new Error('invalid productValue (cents, integer > 0)');

  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://backend-form-webflow-production.up.railway.app';

  const FAILURE_URL = process.env.PAYMENT_FAILURE_URL;
  const success = normalizeHttpsUrl(returnUrl) || normalizeHttpsUrl(`${PUBLIC_BASE_URL}/mercadopago/return/success`);
  const failure = normalizeHttpsUrl(FAILURE_URL || `${PUBLIC_BASE_URL}/payment-fail`);
  const pending = normalizeHttpsUrl(`${PUBLIC_BASE_URL}/mercadopago/return/pending`);

  const notification_url = normalizeHttpsUrl(process.env.MP_WEBHOOK_URL);
  const picture_url = normalizeHttpsUrl(productImageUrl, { max: 512 }) || null;

  const amount = Math.round(valueNum) / 100;

  const allowPix  = !!(paymentOptions && paymentOptions.allow_pix);
  const allowCard = !!(paymentOptions && paymentOptions.allow_card);
  const maxInst   = Number((paymentOptions && paymentOptions.max_installments) ?? 1);

  const excluded_payment_types = [{ id: 'ticket' }]; // nunca boleto
  if (!allowCard) excluded_payment_types.push({ id: 'credit_card' });

  const excluded_payment_methods = [];
  if (!allowPix) excluded_payment_methods.push({ id: 'pix' });

  const payment_methods = {
    excluded_payment_types,
    excluded_payment_methods,
    installments: maxInst,
    default_installments: Math.min(Math.max(1, maxInst), 12),
  };

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
    metadata: { source: 'webflow', ...metadata },
    payment_methods,
    // binary_mode: true, // para eliminar "pending"
  };

  const op = 'create_preference';
  const t0 = process.hrtime.bigint();
  const url = 'https://api.mercadopago.com/checkout/preferences';

  const corrHeaders = ctx?.requestId
    ? { 'X-Request-Id': String(ctx.requestId), 'X-Correlation-Id': String(ctx.requestId) }
    : {};

  try {
    const res = await httpClient.post(url, preferencePayload, {
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN || env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Idempotency-Key': uuid(),
        ...corrHeaders,
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
    if (!initPoint) throw new Error('init_point not found in Mercado Pago response');

    await mpRepository.createCheckout({
      request_id: String(requestId),
      product_type: productType,
      preference_id: preferenceId,
      status: 'CREATED',
      value: valueNum,
      link: initPoint,
      customer: (name || email) ? { name, email } : null,
      raw: data,
    });

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
    } catch (logErr) {
      log.warn({ err: logErr?.message }, 'could not log preference creation event');
    }

    return { url: initPoint, preferenceId };
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    log.error({ status: e?.response?.status, msg: e?.message }, 'createPreference error');
    throw e;
  }
}

/**
 * Busca o pagamento completo por paymentId.
 */
async function fetchPayment(paymentId, ctx = {}) {
  const log = (ctx?.log || baseLogger).child('fetchPayment');
  if (!paymentId) return null;

  const op = 'get_payment';
  const t0 = process.hrtime.bigint();
  const url = `https://api.mercadopago.com/v1/payments/${paymentId}`;

  const corrHeaders = ctx?.requestId
    ? { 'X-Request-Id': String(ctx.requestId), 'X-Correlation-Id': String(ctx.requestId) }
    : {};

  try {
    const res = await httpClient.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN || env.MP_ACCESS_TOKEN}`,
        Accept: 'application/json',
        ...corrHeaders,
      },
      timeout: 15_000,
      retries: 3,
      retryBackoffMs: [0, 250, 600, 1200],
    });
    observe(op, res?.status, t0);
    return res?.data || null;
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    log.error({ paymentId, status: e?.response?.status, msg: e?.message }, 'fetchPayment error');
    return null;
  }
}

/* --------------------------- Webhook processing --------------------------- */

async function processWebhook(body, meta = {}, ctx = {}) {
  const log = (ctx?.log || baseLogger).child('processWebhook');

  try {
    const type = meta?.query?.type || meta?.query?.topic || meta?.topic || body?.type || null;
    const action = body?.action || null;
    const dataId = meta?.query?.id || body?.data?.id || body?.id || null;
    const topic = (type || (action ? action.split('.')[0] : '') || '').toLowerCase();

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
        updatedReq = await mpRepository.updateRequestStatusByRequestId(external_reference, reqStatus, payment);
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
          ? await mpRepository.findByRequestId(external_reference)
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
        }
      }
    }

    return { ok: true };
  } catch (err) {
    log.error({ msg: err?.message }, 'webhook processing error');
    return { ok: false, error: 'internal_error' };
  }
}

module.exports = { createCheckout, processWebhook, events };
