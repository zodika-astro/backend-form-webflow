// payments/pagBank/service.js
'use strict';

/**
 * PagBank Service
 * ---------------
 * Role:
 *   - Create hosted checkouts.
 *   - Process PagBank webhooks (feed v1/v2 mapping via mapWebhookPayload).
 *   - Emit "payment:paid" domain events.
 *
 * Non-functional requirements:
 *   - Strict HTTPS URL validation for redirects/webhooks.
 *   - Explicit timeouts/retries (utils/httpClient) with idempotency keys.
 *   - Repository layer concentrates persistence and idempotent upserts.
 *   - Optional Prometheus metrics; safe to run without prom-client.
 *
 * Public API:
 *   - createCheckout({...}) -> { url, checkoutId }
 *   - processWebhook(payload, meta) -> { ok, ... }
 *   - events (EventEmitter): emits { requestId, productType, chargeId, checkoutId, raw }
 */

const httpClient = require('../../utils/httpClient');
const logger = require('../../utils/logger').child('payments.pagbank');
const crypto = require('crypto');
const EventEmitter = require('events');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const { env } = require('../../config/env');
const pagbankRepository = require('./repository');
const { mapWebhookPayload } = require('./mapPayload');

const events = new EventEmitter();

/* -------------------------------- Metrics (optional) -------------------------------- */
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

/* --------------------------------- Helpers ------------------------------------------ */

const stripQuotesAndSemicolons = (u) => {
  if (!u) return null;
  let s = String(u).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  s = s.replace(/[;\s]+$/g, '');
  return s;
};

/**
 * Accept only well-formed HTTPS URLs with bounded length.
 */
const normalizeHttpsUrl = (u, { max = 255 } = {}) => {
  const s = stripQuotesAndSemicolons(u);
  if (!s) return null;
  if (!/^https:\/\/[^\s<>"]+$/i.test(s)) return null;
  if (s.length > max) return null;
  return s;
};

/* --------------------------------- API calls ---------------------------------------- */

/**
 * Create PagBank checkout.
 * Notes:
 *   - Amount is expressed in cents (unit_amount).
 *   - Methods default to PIX + CREDIT_CARD unless explicitly disabled.
 *   - Redirect URL validated and derived from PUBLIC_BASE_URL.
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
}) {
  if (!requestId) throw new Error('requestId is required');

  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0) {
    throw new Error('invalid productValue (cents, integer > 0)');
  }

  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://backend-form-webflow-production.up.railway.app';
  const redirectUrlRaw = `${PUBLIC_BASE_URL}/pagbank/return`;
  const redirect_url = normalizeHttpsUrl(redirectUrlRaw);
  if (!redirect_url) throw new Error('invalid redirect_url');

  // Payment methods: default to PIX + CARD unless user disabled
  const methods = [];
  if (paymentOptions?.allow_pix !== false) methods.push('PIX');
  if (paymentOptions?.allow_card !== false) methods.push('CREDIT_CARD');
  const selected = methods.length ? methods : ['PIX', 'CREDIT_CARD'];

  const webhookUrl = normalizeHttpsUrl(process.env.PAGBANK_WEBHOOK_URL);
  const imageUrl =
    normalizeHttpsUrl(productImageUrl, { max: 512 }) ||
    normalizeHttpsUrl(process.env.PAGBANK_PRODUCT_IMAGE_URL, { max: 512 });

  // Build request payload (defensive clone)
  const payload = JSON.parse(JSON.stringify({
    reference_id: String(requestId),
    items: [
      {
        name: productName || productType || 'Produto',
        quantity: 1,
        unit_amount: valueNum, // cents
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
              {
                option: 'INSTALLMENTS_LIMIT',
                value: String(paymentOptions?.max_installments || '1'),
              },
            ],
          },
        ]
      : undefined,
    payment_notification_urls: webhookUrl ? [webhookUrl] : undefined,
    customer: name && email ? { name, email } : undefined,
    currency: currency || undefined,
  }));

  // Use explicit base to avoid relying on httpClient baseURL
  const base = (process.env.PAGBANK_API_BASE || env.PAGBANK_API_BASE || 'https://api.pagbank.com.br').replace(/\/+$/,'');
  const url = `${base}/checkouts`;
  const op = 'create_checkout';
  const t0 = process.hrtime.bigint();

  try {
    const res = await httpClient.post(url, payload, {
      headers: {
        Authorization: `Bearer ${env.PAGBANK_API_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Idempotency-Key': uuid(),
      },
      timeout: 20_000,
      retries: 2,
      retryBackoffMs: [0, 250, 700],
    });

    observe(op, res?.status, t0);
    logger.info('[PagBank][createCheckout] OK', { status: res?.status });

    const data = res?.data || {};

    // Resolve "pay" link from typical PagBank response shapes
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

    // Persist request/checkout linkage
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

    // Best-effort audit log
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
      logger.warn('[PagBank] could not log checkout creation event:', logErr?.message || logErr);
    }

    return { url: payLink, checkoutId: data.id || null };
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    if (e.response) {
      logger.error('[PagBank][createCheckout] error', {
        status: e.response.status,
        data: e.response.data,
      });
    } else {
      logger.error('[PagBank][createCheckout] network error', { msg: e.message });
    }
    throw e;
  }
}

/* ------------------------------ Webhook processing ---------------------------------- */

/**
 * Process a (verified) PagBank webhook.
 * Steps:
 *   1) Log raw event (headers/query/body) for diagnostics.
 *   2) Update checkout status when applicable.
 *   3) Upsert payment by chargeId with normalized customer fields.
 *   4) Emit "payment:paid" when status === 'PAID'.
 */
async function processWebhook(p, meta = {}) {
  try {
    // mapWebhookPayload abstracts version differences on PagBank feed
    const { eventId, objectType, checkoutId, chargeId, referenceId, status, customer } = mapWebhookPayload(p);

    // 1) Raw event audit (idempotent on event_uid)
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
      logger.info('[PagBank] Duplicate Webhook — continuing idempotent processing');
    }

    // 2) Update checkout state if present
    if (checkoutId) {
      await pagbankRepository.updateCheckoutStatusById(checkoutId, status, p);
    }

    // 3) Upsert normalized payment row
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

    // 4) Emit domain event on paid
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
    logger.error('[PagBank] Error processing webhook:', err?.message || err);
    return { ok: false, error: 'internal_error' };
  }
}

module.exports = { createCheckout, processWebhook, events };
