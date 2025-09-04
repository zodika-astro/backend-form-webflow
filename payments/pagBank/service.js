'use strict';

/**
 * PagBank Service
 * ---------------
 * - Create hosted checkouts.
 * - Process webhooks (mapPayload cobre feed v1/v2).
 * - Emite "payment:paid".
 *
 * Extras:
 * - URLs seguras (HTTPS + tamanho).
 * - Timeouts/retries via utils/httpClient com idempotência.
 * - Logger por contexto (ctx.log) + correlação.
 * - Métricas Prometheus opcionais.
 */

const httpClient = require('../../utils/httpClient');
const baseLogger = require('../../utils/logger').child('payments.pagbank');
const crypto = require('crypto');
const EventEmitter = require('events');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const { env } = require('../../config/env');
const pagbankRepository = require('./repository');
const { mapWebhookPayload } = require('./mapPayload');

const events = new EventEmitter();

/* --------------------------- Métricas (opcional) --------------------------- */
let prom = null;
try { prom = require('prom-client'); } catch (_) { /* metrics disabled */ }

const pbHistogram = prom
  ? new prom.Histogram({
      name: 'zodika_pagbank_call_duration_seconds',
      help: 'PagBank call duration',
      labelNames: ['operation', 'status'],
      buckets: [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5],
    })
  : null;

function observe(op, status, startNs) {
  if (!pbHistogram) return;
  const dur = (process.hrtime.bigint() - startNs) / BigInt(1e9);
  pbHistogram.labels(op, String(status || 'ERR')).observe(Number(dur));
}

/* -------------------------------- Helpers --------------------------------- */
const stripQuotesAndSemicolons = (u) => {
  if (!u) return null;
  let s = String(u).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  s = s.replace(/[;\s]+$/g, '');
  return s;
};

const normalizeHttpsUrl = (u, { max = 255 } = {}) => {
  const s = stripQuotesAndSemicolons(u);
  if (!s) return null;
  if (!/^https:\/\/[^\s<>"]+$/i.test(s)) return null;
  if (s.length > max) return null;
  return s;
};

/* ------------------------------- API calls ------------------------------- */

/**
 * Cria checkout hospedado no PagBank.
 */
async function createCheckout({
  requestId,
  name,
  email,
  productType,
  productValue,
  productName,
  paymentOptions,
  currency,
  productImageUrl,
}, ctx = {}) {
  const log = (ctx?.log || baseLogger).child('createCheckout');

  if (!requestId) throw new Error('requestId is required');

  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0) throw new Error('invalid productValue (cents, integer > 0)');

  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://backend-form-webflow-production.up.railway.app';
  const redirectUrlRaw = `${PUBLIC_BASE_URL}/pagbank/return`;
  const redirect_url = normalizeHttpsUrl(redirectUrlRaw);
  if (!redirect_url) throw new Error('invalid redirect_url');

  const methods = [];
  if (paymentOptions?.allow_pix !== false) methods.push('PIX');
  if (paymentOptions?.allow_card !== false) methods.push('CREDIT_CARD');
  const selected = methods.length ? methods : ['PIX', 'CREDIT_CARD'];

  const webhookUrl = normalizeHttpsUrl(process.env.PAGBANK_WEBHOOK_URL);
  const imageUrl =
    normalizeHttpsUrl(productImageUrl, { max: 512 }) ||
    normalizeHttpsUrl(process.env.PAGBANK_PRODUCT_IMAGE_URL, { max: 512 });

  const payload = JSON.parse(JSON.stringify({
    reference_id: String(requestId),
    items: [
      {
        name: productName || productType || 'Produto',
        quantity: 1,
        unit_amount: valueNum, // centavos
        ...(imageUrl ? { image_url: imageUrl } : {}),
      },
    ],
    checkout: { redirect_url },
    payment_methods: selected.map((t) => ({ type: t })),
    payment_methods_configs: selected.includes('CREDIT_CARD')
      ? [
          {
            type: 'CREDIT_CARD',
            config_options: [
              { option: 'INSTALLMENTS_LIMIT', value: String(paymentOptions?.max_installments || '1') },
            ],
          },
        ]
      : undefined,
    payment_notification_urls: webhookUrl ? [webhookUrl] : undefined,
    customer: name && email ? { name, email } : undefined,
    currency: currency || undefined,
  }));

  // compat: usa a ENV existente do seu projeto
  const base = (
    process.env.PAGBANK_BASE_URL ||
    env.PAGBANK_BASE_URL ||
    process.env.PAGBANK_API_BASE ||
    env.PAGBANK_API_BASE ||
    'https://sandbox.api.pagseguro.com'
  ).replace(/\/+$/, '');
  const url = `${base}/checkouts`;
  const op = 'create_checkout';
  const t0 = process.hrtime.bigint();

  const corrHeaders = ctx?.requestId
    ? { 'X-Request-Id': String(ctx.requestId), 'X-Correlation-Id': String(ctx.requestId) }
    : {};

  try {
    const res = await httpClient.post(url, payload, {
      headers: {
        Authorization: `Bearer ${env.PAGBANK_API_TOKEN}`,
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
    log.info({ status: res?.status }, 'checkout created');

    const data = res?.data || {};
    let payLink = null;
    if (Array.isArray(data.links)) {
      payLink =
        data.links.find((l) => (String(l.rel || '').toUpperCase() === 'PAY'))?.href ||
        data.links.find((l) => (String(l.rel || '').toUpperCase() === 'CHECKOUT'))?.href ||
        data.links.find((l) => (String(l.rel || '').toUpperCase() === 'SELF'))?.href;
    }
    if (!payLink && data.payment_url) payLink = data.payment_url;
    if (!payLink && data.checkout?.payment_url) payLink = data.checkout.payment_url;
    if (!payLink) throw new Error('PAY link not found in PagBank return');

    await pagbankRepository.createCheckout({
      request_id: String(requestId),
      product_type: productType,
      checkout_id: data.id || null,
      status: data.status || 'CREATED',
      value: valueNum,
      link: payLink,
      customer: name && email ? { name, email } : null,
      raw: data,
    });

    try {
      await pagbankRepository.logEvent({
        event_uid: `checkout_created_${data.id || requestId}`,
        payload: { request_payload: payload, response: data },
        headers: null,
        query: null,
        topic: 'checkout',
        action: 'CREATED',
        checkout_id: data.id || null,
        charge_id: null,
      });
    } catch (logErr) {
      log.warn({ err: logErr?.message }, 'could not log checkout creation event');
    }

    return { url: payLink, checkoutId: data.id || null };
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    if (e.response) {
      log.error({ status: e.response.status, data: e.response.data }, 'createCheckout error');
    } else {
      log.error({ msg: e.message }, 'createCheckout network error');
    }
    throw e;
  }
}

/* --------------------------- Webhook processing --------------------------- */

async function processWebhook(p, meta = {}, ctx = {}) {
  const log = (ctx?.log || baseLogger).child('processWebhook');

  try {
    const { eventId, objectType, checkoutId, chargeId, referenceId, status, customer } = mapWebhookPayload(p);

    const logged = await pagbankRepository.logEvent({
      event_uid: eventId,
      payload: p,
      headers: meta.headers || null,
      query: meta.query || null,
      topic: meta.topic || null,
      action: meta.action || null,
      checkout_id: checkoutId || null,
      charge_id: chargeId || null,
    });

    if (!logged) {
      log.info({ eventId }, 'duplicate webhook (idempotent)');
    }

    if (checkoutId) {
      await pagbankRepository.updateCheckoutStatusById(checkoutId, status, p);
    }

    if (chargeId) {
      await pagbankRepository.upsertPaymentByChargeId({
        charge_id: chargeId,
        checkout_id: checkoutId || null,
        status,
        request_ref: referenceId || null,
        customer,
        raw: p,
      });
    }

    if (status === 'PAID') {
      const record = chargeId
        ? await pagbankRepository.findByChargeId(chargeId)
        : checkoutId
        ? await pagbankRepository.findByCheckoutId(checkoutId)
        : null;

      if (record) {
        const { request_id: requestId, product_type: productType } = record;
        events.emit('payment:paid', { requestId, productType, chargeId, checkoutId, raw: p });
      }
    }

    return { ok: true };
  } catch (err) {
    log.error({ msg: err?.message }, 'webhook processing error');
    return { ok: false, error: 'internal_error' };
  }
}

module.exports = { createCheckout, processWebhook, events };
