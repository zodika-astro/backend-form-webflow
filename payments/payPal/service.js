// payments/payPal/service.js
'use strict';

/**
 * PayPal Service
 * --------------
 * Responsibilities
 *   - Create checkout orders (Orders API) and return the order id.
 *   - Capture approved orders.
 *   - Process webhooks and upsert normalized records.
 *   - Emit domain events ("payment:paid") on COMPLETED.
 *
 * Production notes
 *   - Order creation is critical path for UX. Respond as soon as the provider
 *     returns a valid order id. DB persistence and audit logs can run
 *     asynchronously (fire-and-forget) to keep the request fast.
 *   - Time budgets are tight to avoid client-side timeouts (499/AbortError).
 *
 * API
 *   - createCheckout(input, ctx?) -> { orderId, approvalUrl? }
 *   - captureOrder(input, ctx?)   -> PayPal capture/order payload
 *   - processWebhook(body, meta, ctx?) -> { ok, ... }
 *   - events (EventEmitter)
 */

const httpClient   = require('../../utils/httpClient');
const crypto       = require('crypto');
const EventEmitter = require('events');
const baseLogger   = require('../../utils/logger').child('payments.paypal');
const { AppError } = require('../../utils/appError');
const { env }      = require('../../config/env');
const paypalRepo   = require('./repository');
const orchestrator = require('../orchestrator');

const events = new EventEmitter();

// Simple UUID fallback
const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/* ------------------------------- Metrics (optional) -------------------------------- */

let prom = null;
try { prom = require('prom-client'); } catch { /* metrics disabled */ }

const paypalHistogram = prom
  ? new prom.Histogram({
      name: 'zodika_paypal_call_duration_seconds',
      help: 'PayPal call duration',
      labelNames: ['operation', 'status'],
      buckets: [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5],
    })
  : null;

function observe(op, status, startNs) {
  if (!paypalHistogram) return;
  const dur = (process.hrtime.bigint() - startNs) / BigInt(1e9);
  paypalHistogram.labels(op, String(status || 'ERR')).observe(Number(dur));
}

/* --------------------------------- Helpers ----------------------------------------- */

function getPayPalConfig() {
  const CLIENT_ID     = process.env.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_ID;
  const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || env.PAYPAL_CLIENT_SECRET;
  const MODE          = (process.env.PAYPAL_ENV || env.PAYPAL_ENV || 'sandbox').toLowerCase();

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw AppError.fromUnexpected(
      'paypal_config_missing',
      'PAYPAL_CLIENT_ID and/or PAYPAL_CLIENT_SECRET are not configured',
      { status: 500 }
    );
  }

  const API_BASE =
    MODE === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';

  return { CLIENT_ID, CLIENT_SECRET, MODE, API_BASE };
}

/**
 * Convert integer cents → decimal monetary string, e.g. 3500 -> "35.00".
 */
function centsToDecimalString(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  return (v / 100).toFixed(2);
}

/** Map PayPal status → internal request status. */
function mapPayPalStatus(status) {
  switch ((status || '').toUpperCase()) {
    case 'COMPLETED':        return 'APPROVED';
    case 'PENDING':          return 'PENDING';
    case 'DECLINED':
    case 'DENIED':
    case 'FAILED':           return 'REJECTED';
    case 'CANCELLED':
    case 'CANCELED':         return 'CANCELED';
    case 'REFUNDED':         return 'REFUNDED';
    default:                 return 'UPDATED';
  }
}

/** Deterministic idempotency key (short and stable per logical request). */
function buildIdempotencyKey(kind, key) {
  return `paypal-${kind}-${String(key).slice(0, 64)}`;
}

/* ------------------------------ OAuth2 Access Token ------------------------------- */

/**
 * Fetches an OAuth2 access token from PayPal.
 */
async function getAccessToken(ctx = {}) {
  const { CLIENT_ID, CLIENT_SECRET, API_BASE } = getPayPalConfig();
  const log = (ctx.log || baseLogger).child('oauth', { rid: ctx.requestId });

  const op = 'paypal_oauth_token';
  const t0 = process.hrtime.bigint();

  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const url  = `${API_BASE}/v1/oauth2/token`;

  try {
    const res = await httpClient.post(
      url,
      'grant_type=client_credentials',
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: Number(process.env.PAYPAL_HTTP_TIMEOUT_MS || 8000),
        retries: Number(process.env.PAYPAL_HTTP_RETRIES || 0),
        retryBackoffMs: [0, 250],
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }
    );

    observe(op, res?.status, t0);
    const data = res?.data || {};
    if (!data.access_token) {
      throw AppError.fromUpstream(
        'paypal_oauth_failed',
        'PayPal did not return access_token',
        res,
        { provider: 'paypal', endpoint: url }
      );
    }
    return data.access_token;
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    log.error({ status: e?.response?.status, msg: e?.message }, 'oauth token failed');
    throw AppError.fromUpstream(
      'paypal_oauth_failed',
      'Failed to obtain PayPal access token',
      e,
      { provider: 'paypal', endpoint: url }
    );
  }
}

/* --------------------------------- createCheckout ---------------------------------- */

/**
 * Create a PayPal order (Orders API).
 *
 * UX-first strategy:
 *   1) Call provider with tight timeout.
 *   2) If success → return order id immediately.
 *   3) Persist and audit asynchronously to avoid blocking.
 */
async function createCheckout(input, ctx = {}) {
  const {
    requestId, name, email, productType,
    productValue, productName, paymentOptions,
    currency,
  } = input || {};

  const log = (ctx.log || baseLogger).child('create', { rid: ctx.requestId });

  // Guards
  if (!requestId) {
    throw AppError.fromUnexpected(
      'paypal_checkout_failed',
      'requestId is required',
      { status: 400 }
    );
  }

  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0 || !Number.isInteger(valueNum)) {
    throw AppError.fromUnexpected(
      'paypal_checkout_failed',
      'invalid productValue (must be integer cents > 0)',
      { status: 400 }
    );
  }

  const amountStr = centsToDecimalString(valueNum);
  const { API_BASE } = getPayPalConfig();
  const accessToken = await getAccessToken(ctx);

  const op = 'paypal_create_order';
  const t0 = process.hrtime.bigint();
  const url = `${API_BASE}/v2/checkout/orders`;

  const description =
    productName ||
    productType ||
    'Produto digital';

  // Observação: em fluxo Smart Buttons, return_url/cancel_url podem ser omitidos,
  // pois o JS lida com a aprovação/cancelamento no front.
  const orderPayload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: String(requestId),
        description: description.toString().slice(0, 127),
        amount: {
          currency_code: currency || 'BRL',
          value: amountStr,
        },
      },
    ],
    application_context: {
      brand_name: 'zodika',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
    },
    payer: (name || email)
      ? {
          name: name
            ? { given_name: String(name).slice(0, 127) }
            : undefined,
          email_address: email || undefined,
        }
      : undefined,
  };

  const options = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'PayPal-Request-Id': buildIdempotencyKey('order', requestId),
    },
    timeout: Number(process.env.PAYPAL_HTTP_TIMEOUT_MS || 8000),
    retries: Number(process.env.PAYPAL_HTTP_RETRIES || 0),
    retryBackoffMs: [0, 250],
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };

  try {
    const res = await httpClient.post(url, orderPayload, options);
    observe(op, res?.status, t0);

    const data = res?.data || {};
    const orderId = data.id || null;
    if (!orderId) {
      throw AppError.fromUpstream(
        'paypal_checkout_failed',
        'order id not found in PayPal response',
        res,
        { provider: 'paypal', endpoint: url }
      );
    }

    // approval URL não é necessária para Smart Buttons, mas deixamos se vier.
    let approvalUrl = null;
    if (Array.isArray(data.links)) {
      const approveLink = data.links.find((l) => l.rel === 'approve');
      approvalUrl = approveLink?.href || null;
    }

    // Fire-and-forget persistence (opcional)
    const persistAsync = String(process.env.PAYPAL_PERSIST_ASYNC || 'true')
      .toLowerCase() === 'true';

    const persistWork = async () => {
      try {
        await paypalRepo.createOrder({
          request_id: String(requestId),
          product_type: productType,
          order_id: orderId,
          status: data.status || 'CREATED',
          value_cents: valueNum,
          customer: (name || email) ? { name, email } : null,
          raw: data,
        });
      } catch (e) {
        log.warn({ msg: e?.message }, 'could not persist PayPal order');
      }

      // Snapshot para orchestrator (ex.: salvar link/amount num lugar central)
      try {
        if (typeof orchestrator.snapshotCheckoutCreated === 'function') {
          await orchestrator.snapshotCheckoutCreated({
            requestId: Number(requestId),
            checkoutId: orderId,
            link: approvalUrl || null,
            amountCents: valueNum,
            currency: currency || 'BRL',
          });
        }
      } catch (e) {
        log.warn({ msg: e?.message }, 'could not snapshot CREATED state (PayPal)');
      }

      // Audit trail (best-effort)
      try {
        await paypalRepo.logEvent({
          event_uid: `order_created_${orderId || requestId}`,
          payload: { request_payload: orderPayload, response: data },
          headers: null,
          topic: 'order',
          action: 'CREATED',
          order_id: orderId,
        });
      } catch (e) {
        log.warn({ msg: e?.message }, 'could not log order creation event');
      }
    };

    if (persistAsync) {
      setImmediate(() => {
        persistWork().catch((err) =>
          log.warn({ msg: err?.message }, 'persist async failed')
        );
      });
    } else {
      await persistWork();
    }

    log.info({ orderId, status: data.status }, 'PayPal order ready');
    return { orderId, approvalUrl };
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    baseLogger.error(
      { status: e?.response?.status, msg: e?.message },
      'create order failed'
    );

    throw AppError.fromUpstream(
      'paypal_checkout_failed',
      'Failed to create checkout with PayPal',
      e,
      { provider: 'paypal', endpoint: url }
    );
  }
}

/* --------------------------------- captureOrder ------------------------------------ */

/**
 * Capture a PayPal order after buyer approval.
 */
async function captureOrder(input, ctx = {}) {
  const { orderId, requestId } = input || {};
  const log = (ctx.log || baseLogger).child('capture', { rid: ctx.requestId });

  if (!orderId) {
    throw AppError.fromUnexpected(
      'paypal_capture_failed',
      'orderId is required',
      { status: 400 }
    );
  }

  const { API_BASE } = getPayPalConfig();
  const accessToken = await getAccessToken(ctx);

  const op = 'paypal_capture_order';
  const t0 = process.hrtime.bigint();
  const url = `${API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`;

  const options = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'PayPal-Request-Id': buildIdempotencyKey('capture', orderId),
    },
    timeout: Number(process.env.PAYPAL_HTTP_TIMEOUT_MS || 10000),
    retries: Number(process.env.PAYPAL_HTTP_RETRIES || 0),
    retryBackoffMs: [0, 250],
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };

  try {
    const res = await httpClient.post(url, {}, options);
    observe(op, res?.status, t0);

    const data = res?.data || {};
    const normalizedStatus = mapPayPalStatus(data.status);

    // Extração básica de capture para valor/horário
    const pu = Array.isArray(data.purchase_units) ? data.purchase_units[0] : null;
    const payments = pu?.payments || {};
    const captures = Array.isArray(payments.captures) ? payments.captures : [];
    const capture = captures[0] || null;

    const amountValue = capture?.amount?.value || pu?.amount?.value || null;
    const amountCurrency = capture?.amount?.currency_code || pu?.amount?.currency_code || null;

    const valueCents = amountValue != null
      ? Math.round(Number(amountValue) * 100)
      : null;

    // Persistência / snapshot best-effort
    const persistAsync = String(process.env.PAYPAL_PERSIST_ASYNC || 'true')
      .toLowerCase() === 'true';

    const persistWork = async () => {
      const safeReqId = requestId || pu?.reference_id || null;

      try {
        await paypalRepo.upsertPaymentByOrderId({
          order_id: orderId,
          status: data.status,
          normalized_status: normalizedStatus,
          request_id: safeReqId,
          amount_cents: valueCents,
          currency: amountCurrency || null,
          raw: data,
        });
      } catch (e) {
        log.warn({ msg: e?.message }, 'could not upsert PayPal payment');
      }

      // Snapshot para zodika_requests via orchestrator
      try {
        if (typeof orchestrator.updateFromPayPal === 'function') {
          await orchestrator.updateFromPayPal(data, {
            requestId: safeReqId ? Number(safeReqId) : undefined,
            orderId,
          });
        }
      } catch (e) {
        log.warn({ msg: e?.message }, 'payment snapshot skipped (PayPal)');
      }

      // Atualizar status da request se tivermos request_id
      if (safeReqId) {
        try {
          await paypalRepo.updateRequestStatusByRequestId(
            safeReqId,
            normalizedStatus,
            data
          );
        } catch (e) {
          log.warn({ msg: e?.message }, 'could not update request status from PayPal capture');
        }
      }

      // Emitir evento "payment:paid" se COMPLETED
      if (normalizedStatus === 'APPROVED') {
        events.emit('payment:paid', {
          requestId: safeReqId || null,
          productType: pu?.reference_id ? 'birth_chart' : null, // TODO: mapear melhor se precisar
          orderId,
          raw: data,
        });
        log.info({ orderId }, 'payment approved via PayPal capture');
      }
    };

    if (persistAsync) {
      setImmediate(() => {
        persistWork().catch((err) =>
          log.warn({ msg: err?.message }, 'capture persist async failed')
        );
      });
    } else {
      await persistWork();
    }

    return data;
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    baseLogger.error(
      { status: e?.response?.status, msg: e?.message },
      'capture order failed'
    );

    throw AppError.fromUpstream(
      'paypal_capture_failed',
      'Failed to capture order with PayPal',
      e,
      { provider: 'paypal', endpoint: url }
    );
  }
}

/* -------------------------------- Webhook handler ---------------------------------- */

/**
 * Process PayPal webhooks.
 *
 * body: raw PayPal event
 * meta: { headers, query, topic, auth }
 */
async function processWebhook(body, meta = {}, ctx = {}) {
  const log = (ctx.log || baseLogger).child('webhook', { rid: ctx.requestId });

  try {
    const eventType = body?.event_type || meta?.topic || null;
    const resource  = body?.resource || {};
    const headers   = meta.headers || {};
    const webhookId = process.env.PAYPAL_WEBHOOK_ID || env.PAYPAL_WEBHOOK_ID || null;

    // Audit event first
    const providerEventUid =
      headers['x-request-id'] ||
      headers['x-correlation-id'] ||
      `${eventType || 'event'}_${resource.id || uuid()}_${Date.now()}`;

    await paypalRepo.logEvent({
      event_uid: providerEventUid,
      payload: body,
      headers,
      query: meta.query || null,
      topic: eventType || null,
      action: null,
      order_id: resource.id || null,
    });

    // (Opcional) Verificação de assinatura via API do PayPal.
    // Mantemos como TODO para não explodir complexidade agora.
    // meta.auth.signatureOk pode ser ajustado aqui se você implementar depois.

    // Tratamento básico de eventos relevantes
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      await handleCaptureCompletedWebhook(body, meta, ctx, log);
    } else if (eventType === 'CHECKOUT.ORDER.APPROVED') {
      await handleOrderApprovedWebhook(body, meta, ctx, log);
    }

    return { ok: true };
  } catch (err) {
    const wrapped = AppError.fromUnexpected(
      'paypal_webhook_failed',
      'Error processing PayPal webhook',
      { cause: err }
    );
    log.error({ code: wrapped.code, msg: wrapped.message }, 'webhook processing failed');
    return { ok: false, error: wrapped.code };
  }
}

/**
 * Handle PAYMENT.CAPTURE.COMPLETED webhooks.
 * This is the strongest confirmation that money moved.
 */
async function handleCaptureCompletedWebhook(body, meta, ctx, log) {
  const resource = body?.resource || {};
  const captureId = resource.id || null;
  const status = resource.status || 'COMPLETED';

  const orderId =
    resource.supplementary_data?.related_ids?.order_id ||
    resource?.custom_id ||
    null;

  const amountValue = resource?.amount?.value || null;
  const amountCurrency = resource?.amount?.currency_code || null;
  const valueCents = amountValue != null
    ? Math.round(Number(amountValue) * 100)
    : null;

  const normalizedStatus = mapPayPalStatus(status);

  // requestId pode estar em custom_id ou reference_id (dependendo de como você modelar depois)
  const safeReqId = resource.custom_id || null;

  try {
    await paypalRepo.upsertPaymentByCaptureId({
      capture_id: captureId,
      order_id: orderId,
      status,
      normalized_status: normalizedStatus,
      request_id: safeReqId,
      amount_cents: valueCents,
      currency: amountCurrency || null,
      raw: resource,
    });
  } catch (e) {
    log.warn({ msg: e?.message }, 'could not upsert capture from webhook');
  }

  if (safeReqId) {
    try {
      await paypalRepo.updateRequestStatusByRequestId(
        safeReqId,
        normalizedStatus,
        resource
      );
    } catch (e) {
      log.warn({ msg: e?.message }, 'could not update request status from capture webhook');
    }
  }

  if (normalizedStatus === 'APPROVED') {
    events.emit('payment:paid', {
      requestId: safeReqId || null,
      productType: null, // TODO: se você armazenar product_type no repo, pode preencher aqui
      orderId,
      captureId,
      raw: resource,
    });
    log.info({ orderId, captureId }, 'payment approved via PayPal webhook');
  }
}

/**
 * Handle CHECKOUT.ORDER.APPROVED webhooks.
 * Many setups rely solely on CAPTURE.COMPLETED, mas podemos usar esse
 * evento para reconciliar estados intermediários, se necessário.
 */
async function handleOrderApprovedWebhook(body, meta, ctx, log) {
  const resource = body?.resource || {};
  const orderId = resource.id || null;
  const status  = resource.status || 'APPROVED';
  const normalizedStatus = mapPayPalStatus(status);

  const pu = Array.isArray(resource.purchase_units) ? resource.purchase_units[0] : null;
  const referenceId = pu?.reference_id || null;

  try {
    await paypalRepo.upsertOrderFromWebhook({
      order_id: orderId,
      status,
      normalized_status: normalizedStatus,
      request_id: referenceId,
      raw: resource,
    });
  } catch (e) {
    log.warn({ msg: e?.message }, 'could not upsert order from webhook');
  }

  if (referenceId) {
    try {
      await paypalRepo.updateRequestStatusByRequestId(
        referenceId,
        normalizedStatus,
        resource
      );
    } catch (e) {
      log.warn({ msg: e?.message }, 'could not update request status from order webhook');
    }
  }
}

module.exports = {
  createCheckout,
  captureOrder,
  processWebhook,
  events,
};
