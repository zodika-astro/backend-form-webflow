'use strict';

/**
 * PagBank Service
 * ---------------
 * Responsibilities
 *   - Create hosted checkouts.
 *   - Process PagBank webhooks (feed mapping via mapWebhookPayload).
 *   - Emit domain events ("payment:paid") on PAID.
 *
 * Non-functional
 *   - Explicit per-attempt timeouts with tight retry policy (fail fast).
 *   - HTTPS URL validation and bounded strings.
 *   - Structured logging with correlation (no PII).
 *   - Optional Prometheus metrics (no hard dependency).
 *
 * API
 *   - createCheckout(input, ctx?) -> { url, checkoutId }
 *   - processWebhook(payload, meta, ctx?) -> { ok, ... }
 *   - events (EventEmitter)
 */

const httpClient = require('../../utils/httpClient');
const baseLogger = require('../../utils/logger').child('payments.pagbank');
const { AppError } = require('../../utils/appError');
const crypto = require('crypto');
const EventEmitter = require('events');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const { env } = require('../../config/env');
const pagbankRepository = require('./repository');
const { mapWebhookPayload } = require('./mapPayload');

const events = new EventEmitter();

/* ------------------------------- Metrics (optional) -------------------------------- */
let prom = null;
try { prom = require('prom-client'); } catch { /* metrics disabled */ }

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

/* --------------------------------- Helpers ----------------------------------------- */

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

/** Deterministic idempotency key per logical request. */
function buildIdempotencyKey(requestId) {
  return `pb-co-${String(requestId).slice(0, 64)}`;
}

/* --------------------------------- API calls --------------------------------------- */

/**
 * Create a PagBank checkout session.
 * Notes:
 *   - `unit_amount` is in cents (integer).
 *   - Defaults to PIX + CREDIT_CARD unless explicitly disabled.
 *   - Redirect URL must point back to our /pagBank/return handler.
 */
async function createCheckout(input, ctx = {}) {
  const {
    requestId,
    name,
    email,
    productType,
    productValue,
    productName,
    paymentOptions,
    currency,
    productImageUrl,
  } = input || {};

  const log = (ctx.log || baseLogger).child('create', { rid: ctx.requestId });

  if (!requestId) {
    throw AppError.fromUnexpected('pagbank_checkout_failed', 'requestId is required', { status: 400 });
  }

  const PB_TOKEN = process.env.PAGBANK_API_TOKEN || env.PAGBANK_API_TOKEN;
  if (!PB_TOKEN) {
    throw AppError.fromUnexpected('pagbank_config_missing', 'PAGBANK_API_TOKEN is not configured', { status: 500 });
  }

  // Amount must be integer cents > 0
  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0 || !Number.isInteger(valueNum)) {
    throw AppError.fromUnexpected(
      'pagbank_checkout_failed',
      'invalid productValue (must be integer cents > 0)',
      { status: 400 }
    );
  }

  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://backend-form-webflow-production.up.railway.app';
  // IMPORTANT: match the mount path in index.js -> app.use('/pagBank', pagbankReturnRouter)
  const redirectUrlRaw = `${PUBLIC_BASE_URL}/pagBank/return`;
  const redirect_url = normalizeHttpsUrl(redirectUrlRaw);
  if (!redirect_url) {
    throw AppError.fromUnexpected('pagbank_checkout_failed', 'invalid redirect_url', { status: 400 });
  }

  // Payment methods (PIX + CARD unless disabled)
  const wantPix  = paymentOptions?.allow_pix !== false;
  const wantCard = paymentOptions?.allow_card !== false;
  const methods = [];
  if (wantPix) methods.push('PIX');
  if (wantCard) methods.push('CREDIT_CARD');
  const selected = methods.length ? methods : ['PIX', 'CREDIT_CARD'];

  // Cap installments to [1..12]
  const maxInstRaw = Number(paymentOptions?.max_installments ?? 1);
  const maxInstallments = Number.isFinite(maxInstRaw) ? Math.min(Math.max(1, maxInstRaw), 12) : 1;

  const webhookUrl = normalizeHttpsUrl(process.env.PAGBANK_WEBHOOK_URL || env.PAGBANK_WEBHOOK_URL);
  const imageUrl =
    normalizeHttpsUrl(productImageUrl, { max: 512 }) ||
    normalizeHttpsUrl(process.env.PAGBANK_PRODUCT_IMAGE_URL || env.PAGBANK_PRODUCT_IMAGE_URL, { max: 512 });

  // Defensive clone to avoid accidental mutations
  const payload = JSON.parse(JSON.stringify({
    reference_id: String(requestId),
    items: [
      {
        name: (productName || productType || 'Produto').toString().slice(0, 150),
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
              { option: 'INSTALLMENTS_LIMIT', value: String(maxInstallments) },
            ],
          },
        ]
      : undefined,
    payment_notification_urls: webhookUrl ? [webhookUrl] : undefined,
    customer: (name || email) ? { name, email } : undefined,
    currency: currency || undefined,
  }));

  // Prefer configured base; fallback to official API.
  const base = (process.env.PAGBANK_BASE_URL || env.PAGBANK_BASE_URL || 'https://api.pagbank.com.br').replace(/\/+$/, '');
  const url = `${base}/checkouts`;

  const op = 'create_checkout';
  const t0 = process.hrtime.bigint();

  // Tight budget: 12s per attempt, 1 retry → worst-case ~24s.
  const PER_ATTEMPT_TIMEOUT_MS = 12_000;
  const RETRIES = 1;

  try {
    const res = await httpClient.post(url, payload, {
      headers: {
        Authorization: `Bearer ${PB_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Idempotency-Key': buildIdempotencyKey(requestId),
      },
      timeout: PER_ATTEMPT_TIMEOUT_MS,
      retries: RETRIES,
      retryBackoffMs: [0, 250],
    });

    observe(op, res?.status, t0);
    log.info({ status: res?.status }, 'checkout created');

    const data = res?.data || {};

    // Find the public payment URL across common response shapes
    let payLink = null;
    if (Array.isArray(data.links)) {
      const rel = (x) => String(x?.rel || '').toUpperCase();
      payLink =
        data.links.find((l) => rel(l) === 'PAY')?.href ||
        data.links.find((l) => rel(l) === 'CHECKOUT')?.href ||
        data.links.find((l) => rel(l) === 'SELF')?.href;
    }
    if (!payLink && data.payment_url) payLink = data.payment_url;
    if (!payLink && data.checkout?.payment_url) payLink = data.checkout.payment_url;
    if (!payLink) {
      throw AppError.fromUnexpected('pagbank_checkout_failed', 'PAY link not found in PagBank return');
    }

    await pagbankRepository.createCheckout({
      request_id: String(requestId),
      product_type: productType,
      checkout_id: data.id || null,
      status: data.status || 'CREATED',
      value: valueNum,
      link: payLink,
      customer: (name || email) ? { name, email } : null,
      raw: data,
    });

    // Best-effort audit trail
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
    } catch (e) {
      log.warn({ msg: e?.message }, 'could not log checkout creation event');
    }

    log.info({ checkoutId: data.id || null, host: safeHost(payLink) }, 'checkout ready');
    return { url: payLink, checkoutId: data.id || null };
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    if (e?.response) {
      log.error({ status: e.response.status, msg: e?.message }, 'create checkout failed');
    } else {
      log.error({ msg: e?.message }, 'create checkout network error');
    }
    // Normalize upstream error into AppError with standardized code
    throw AppError.fromUpstream(
      'pagbank_checkout_failed',
      'Failed to create checkout with PagBank',
      e,
      { provider: 'pagbank', endpoint: url }
    );
  }
}

/* -------------------------------- Webhook handler ---------------------------------- */

async function processWebhook(p, meta = {}, ctx = {}) {
  const log = (ctx.log || baseLogger).child('webhook', { rid: ctx.requestId });

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
      log.info({ eventId }, 'duplicate webhook (already logged)');
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
        log.info({ chargeId, checkoutId }, 'payment confirmed (PAID)');
      }
    }

    return { ok: true };
  } catch (err) {
    const wrapped = AppError.fromUnexpected('pagbank_webhook_failed', 'Error processing PagBank webhook', { cause: err });
    log.error({ code: wrapped.code, msg: wrapped.message }, 'webhook processing failed');
    return { ok: false, error: wrapped.code };
  }
}

module.exports = { createCheckout, processWebhook, events };
