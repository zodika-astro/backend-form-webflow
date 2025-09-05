// payments/pagBank/service.js
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
 *   - Explicit timeouts + limited retries with backoff (utils/httpClient).
 *   - HTTPS URL validation and bounded strings.
 *   - Structured logging with correlation (no PII).
 *   - Optional Prometheus metrics (gracefully disabled if not installed).
 *
 * API
 *   - createCheckout(input, ctx?) -> { url, checkoutId }
 *   - processWebhook(payload, meta, ctx?) -> { ok, ... }
 *   - events (EventEmitter)
 */

const httpClient = require('../../utils/httpClient');
const baseLogger = require('../../utils/logger').child('payments.pagbank');
const { AppError } = require('../../utils/appError');
const { get: getSecret } = require('../../config/secretProvider');
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

/** Strip accidental quotes/trailing separators that might come from CMS/spreadsheets. */
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
  // Stable key ensures PagBank dedupes across retries and user double-submits.
  return `zdk:pb:checkout:${String(requestId)}`;
}

/** Resolve PagBank API token using secret provider (fallback to ENV). */
async function resolvePagBankToken() {
  // Prefer external secret manager; fallback to validated env var
  const fromProvider = await getSecret('PAGBANK_API_TOKEN').catch(() => null);
  return fromProvider || env.PAGBANK_API_TOKEN || process.env.PAGBANK_API_TOKEN || null;
}

/** Compute default webhook URL when not explicitly configured. */
function defaultPagBankWebhookUrl() {
  const base = process.env.PUBLIC_BASE_URL || env.PUBLIC_BASE_URL;
  if (!base) return null;
  const pathSecret = (process.env.WEBHOOK_PATH_SECRET || '').trim();
  const suffix = pathSecret ? `/${pathSecret}` : '';
  return `${base.replace(/\/+$/, '')}/webhook/pagbank${suffix}`;
}

/* --------------------------------- API calls --------------------------------------- */

/**
 * Create a PagBank checkout session.
 * Notes:
 *  - `unit_amount` is in cents.
 *  - Defaults to PIX + CREDIT_CARD unless explicitly disabled.
 *  - Redirect URL must point back to our /pagbank/return handler (public).
 *  - Idempotency key is STABLE per requestId to avoid duplicates on retries.
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

  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0) {
    throw AppError.fromUnexpected('pagbank_checkout_failed', 'invalid productValue (cents, integer > 0)', { status: 400 });
  }

  // Resolve API token (fail-closed in production if missing)
  const token = await resolvePagBankToken();
  const isProd = (process.env.NODE_ENV || 'production') === 'production';
  if (isProd && !token) {
    throw AppError.fromUpstream('pagbank_checkout_failed', 'PagBank token unavailable', null, { provider: 'pagbank' });
  }
  if (!token) {
    // Non-prod: allow local testing without secret provider.
    log.warn('PagBank token not configured; attempting request may fail in dev.');
  }

  // Base URL (env already validated via envalid with a default sandbox URL)
  const base = (process.env.PAGBANK_BASE_URL || env.PAGBANK_BASE_URL || 'https://api.pagbank.com.br').replace(/\/+$/, '');
  const url = `${base}/checkouts`;

  // Redirect back to our app
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || env.PUBLIC_BASE_URL || 'https://backend-form-webflow-production.up.railway.app';
  const redirect_url = normalizeHttpsUrl(`${PUBLIC_BASE_URL}/pagbank/return`);
  if (!redirect_url) {
    throw AppError.fromUnexpected('pagbank_checkout_failed', 'invalid redirect_url', { status: 400 });
  }

  // Payment methods (PIX + CARD unless disabled)
  const methods = [];
  if (paymentOptions?.allow_pix !== false) methods.push('PIX');
  if (paymentOptions?.allow_card !== false) methods.push('CREDIT_CARD');
  const selected = methods.length ? methods : ['PIX', 'CREDIT_CARD'];

  // Notification (webhook) URL — prefer explicit, else derive from PUBLIC_BASE_URL
  const configuredWebhook = process.env.PAGBANK_WEBHOOK_URL || env.PAGBANK_WEBHOOK_URL;
  const webhookUrl = normalizeHttpsUrl(configuredWebhook || defaultPagBankWebhookUrl());

  // Product image (optional; limit length)
  const imageUrl =
    normalizeHttpsUrl(productImageUrl, { max: 512 }) ||
    normalizeHttpsUrl(process.env.PAGBANK_PRODUCT_IMAGE_URL || env.PAGBANK_PRODUCT_IMAGE_URL, { max: 512 });

  // Defensive clone to avoid accidental mutations
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
              { option: 'INSTALLMENTS_LIMIT', value: String(paymentOptions?.max_installments || '1') },
            ],
          },
        ]
      : undefined,
    payment_notification_urls: webhookUrl ? [webhookUrl] : undefined,
    customer: name && email ? { name, email } : undefined,
    currency: currency || undefined, // leave undefined if not required by the API
  }));

  const op = 'create_checkout';
  const t0 = process.hrtime.bigint();

  try {
    const res = await httpClient.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // Stable key → PagBank dedupes duplicate creates and our client retries.
        'X-Idempotency-Key': buildIdempotencyKey(requestId),
      },
      timeout: 20_000,
      retries: 2,
      retryBackoffMs: [0, 250, 700],
    });

    observe(op, res?.status, t0);
    baseLogger.info({ status: res?.status }, 'pagbank checkout created');

    const data = res?.data || {};

    // Find the public payment URL across common response shapes
    let payLink = null;
    if (Array.isArray(data.links)) {
      payLink =
        data.links.find((l) => String(l.rel || '').toUpperCase() === 'PAY')?.href ||
        data.links.find((l) => String(l.rel || '').toUpperCase() === 'CHECKOUT')?.href ||
        data.links.find((l) => String(l.rel || '').toUpperCase() === 'SELF')?.href;
    }
    if (!payLink && data.payment_url) payLink = data.payment_url;
    if (!payLink && data.checkout?.payment_url) payLink = data.checkout.payment_url;
    if (!payLink) {
      throw AppError.fromUnexpected('pagbank_checkout_failed', 'PAY link not found in PagBank response');
    }

    // Persist checkout record (customer/raw sanitized in repository)
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

    // Best-effort audit trail (keep payload minimal; repository sanitizes JSON)
    try {
      await pagbankRepository.logEvent({
        event_uid: `checkout_created_${data.id || requestId}`,
        payload: { response: { id: data.id || null, has_pay_link: !!payLink } },
        headers: null,
        query: null,
        topic: 'checkout',
        action: 'CREATED',
        checkout_id: data.id || null,
        charge_id: null,
      });
    } catch (e) {
      baseLogger.warn({ msg: e?.message }, 'could not log checkout creation event');
    }

    baseLogger.info({ checkoutId: data.id || null, host: safeHost(payLink) }, 'pagbank checkout ready');
    return { url: payLink, checkoutId: data.id || null };
  } catch (e) {
    observe(op, e?.response?.status || 'ERR', t0);
    const st = e?.response?.status;
    baseLogger.error({ status: st, msg: e?.message }, st ? 'create checkout failed' : 'create checkout network error');
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

/**
 * Process a verified PagBank webhook (idempotent).
 * Steps
 *   1) Persist raw event (headers/query/body) with stable event_uid.
 *   2) Update checkout status if present.
 *   3) Upsert payment by chargeId with normalized customer fields.
 *   4) Emit "payment:paid" for status === 'PAID'.
 *
 * Tolerant behavior: returns { ok:false } instead of throwing to keep 2xx at the edge.
 */
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
