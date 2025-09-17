// modules/birthchart/controller.js
'use strict';

/**
 * Birthchart Controller
 * ---------------------
 * Fast path
 *  - Validate/normalize form.
 *  - Persist request (placeholders for timezone).
 *  - Create PSP checkout and return URL immediately (NON-BLOCKING).
 *
 * Deferred work (now moved here)
 *  - Resolve historical timezone via Google Time Zone API using birth_date/time.
 *  - Persist birth_timezone_id, birth_utc_offset_min and birth_utc_offset_hours asynchronously.
 *
 * Non-functional
 *  - Structured logging; no PII in logs.
 *  - AppError for consistent error handling.
 */

const { validateBirthchartPayload } = require('./validators');
const repo = require('./repository'); // will need updateTimezone writer (see notes below)
const { getTimezoneAtMoment, toHours } = require('../../utils/timezone');

const { env } = require('../../config/env');
const { AppError } = require('../../utils/appError');
const baseLogger = require('../../utils/logger').child('form.birthchart');

const mpService = require('../../payments/mercadoPago/service');
const pagbankService = require('../../payments/pagBank/service');

const PRODUCT_IMAGE_URL = 'https://backend-form-webflow-production.up.railway.app/assets/birthchart-productimage.png';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || null;

/** Safe host extraction for logs (prevents leaking full URLs with query params/PII). */
function safeHost(u) {
  try { return new URL(u).host; } catch { return undefined; }
}

/** Shallow pick helper to avoid mass assignment and keep validators stable. */
function pick(input, allowedKeys) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(input, k)) out[k] = input[k];
  }
  return out;
}

/**
 * Normalize to strict HH:MM; returns null if invalid.
 * Keeps consistent with utils/timezone normalization expectations.
 */
function toHHMM(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?/);
  if (!m) return null;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mi = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** Allowed public form fields (whitelist). */
const ALLOWED_FORM_KEYS = [
  'name',
  'social_name',
  'email',
  'birth_date',
  'birth_time',
  'birth_place',

  // hidden/structured location fields
  'birth_place_place_id',
  'birth_place_full',
  'birth_place_country',
  'birth_place_admin1',
  'birth_place_admin2',
  'birth_place_lat',
  'birth_place_lng',
  'birth_place_json',

  // product selector
  'product_type',
];

/* --------------------------- Payment provider select ------------------------------ */
function getPaymentProvider() {
  const raw =
    (typeof process !== 'undefined' && process.env && process.env.PAYMENT_PROVIDER)
      ? process.env.PAYMENT_PROVIDER
      : env && env.PAYMENT_PROVIDER;

  const v = String(raw || 'MERCADO_PAGO').trim().toUpperCase();
  if (v === 'PAGBANK') return 'PAGBANK';
  return 'MERCADO_PAGO';
}

/**
 * Fire-and-forget timezone computation.
 * Uses Google Time Zone API exclusively and persists results if successful.
 */
function triggerAsyncTimezoneCompute({ requestId, birth }) {
  // Detach from the request lifecycle; do not await.
  // Use setImmediate to avoid holding the event loop of the controller handler.
  setImmediate(async () => {
    const log = baseLogger.child('tz.async', { requestId });
    try {
      // Basic guards
      const lat = Number(birth.lat);
      const lng = Number(birth.lng);
      const coordsOk = Number.isFinite(lat) && Number.isFinite(lng);
      const dateStr = String(birth.date || '').slice(0, 10);
      const hhmm = toHHMM(birth.time) || '12:00'; // defensive default

      if (!coordsOk || !dateStr) {
        log.warn({ coordsOk, dateStr }, 'skipping timezone compute: invalid inputs');
        return;
      }
      if (!GOOGLE_MAPS_API_KEY) {
        log.warn('GOOGLE_MAPS_API_KEY not configured; skipping timezone compute');
        return;
      }

      const tz = await getTimezoneAtMoment({
        lat, lng, birthDate: dateStr, birthTime: hhmm, apiKey: GOOGLE_MAPS_API_KEY,
      });

      if (!tz || tz.offsetMin == null) {
        log.warn({ tz }, 'timezone unresolved; not updating DB');
        return;
      }

      const offsetHours = toHours(tz.offsetMin);
      await repo.updateBirthTimezone(requestId, {
        birth_timezone_id: tz.tzId || null,
        birth_utc_offset_min: tz.offsetMin,
        birth_utc_offset_hours: offsetHours,
      });

      log.info(
        { tzId: tz.tzId || null, offsetMin: tz.offsetMin, offsetHours },
        'timezone persisted asynchronously'
      );
    } catch (err) {
      log.error({ msg: err?.message }, 'async timezone compute failed');
    }
  });
}

/**
 * POST /birthchart/birthchartsubmit-form (public)
 * Body: validated by Zod in validateBirthchartPayload (normalized on return)
 */
async function processForm(req, res, next) {
  const logger = (req.log || baseLogger).child('processForm', { rid: req.requestId });

  try {
    /* ----------------------- consent & input guards ------------------------ */
    const privacyConsent = (() => {
      const raw =
        req.body?.privacyConsent ??
        req.body?.privacy_agreed ??
        req.body?.privacy ??
        req.body?.privacy_policy ??
        req.body?.policy ??
        req.body?.terms;
      if (raw == null) return false;
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'number') return raw === 1;
      const s = String(raw).trim().toLowerCase();
      return s === 'true' || s === 'on' || s === 'yes' || s === '1' || s === 'checked';
    })();

    if (!privacyConsent) {
      throw new AppError(
        'privacy_consent_required',
        'Privacy Policy consent is required to submit this form.',
        400,
        { field: 'privacyConsent' }
      );
    }

    // Build a safe, trimmed, typed object from req.body (replaces older `filtered`)
    const raw = pick(req.body, ALLOWED_FORM_KEYS);
    const filtered = {};
    for (const [k, v] of Object.entries(raw)) {
      filtered[k] = typeof v === 'string' ? v.trim() : v;
    }

    // Default product if not provided (keeps downstream stable)
    if (!filtered.product_type) filtered.product_type = 'birth_chart';

    // Normalize numeric fields
    if (filtered.birth_place_lat != null && typeof filtered.birth_place_lat === 'string') {
      const n = Number(filtered.birth_place_lat);
      if (!Number.isNaN(n)) filtered.birth_place_lat = n;
    }
    if (filtered.birth_place_lng != null && typeof filtered.birth_place_lng === 'string') {
      const n = Number(filtered.birth_place_lng);
      if (!Number.isNaN(n)) filtered.birth_place_lng = n;
    }

    // Validate/normalize via schema (may throw)
    const input = validateBirthchartPayload(filtered);

    /* ------------------- persist request (PII kept out of logs) ----------- */
    const newRequest = await repo.createBirthchartRequest({
      name:                 input.name,
      social_name:          input.social_name,
      email:                input.email,
      birth_date:           input.birth_date,
      birth_time:           input.birth_time,
      birth_place:          input.birth_place,
      product_type:         input.product_type,

      birth_place_place_id: input.birth_place_place_id,
      birth_place_full:     input.birth_place_full,
      birth_place_country:  input.birth_place_country,
      birth_place_admin1:   input.birth_place_admin1,
      birth_place_admin2:   input.birth_place_admin2,
      birth_place_lat:      input.birth_place_lat,
      birth_place_lng:      input.birth_place_lng,
      birth_place_json:     input.birth_place_json,

      // placeholders (to be filled asynchronously right after submit)
      birth_timezone_id:    null,
      birth_utc_offset_min: null,
      birth_utc_offset_hours: null,
    }).catch((e) => {
      throw AppError.fromUpstream('db_persist_failed', 'Could not persist birthchart request', e, { entity: 'birthchart_request' });
    });

    logger.info({ requestId: newRequest.request_id, productType: newRequest.product_type }, 'request persisted');

    /* --------- trigger async timezone compute (does NOT block response) --- */
    triggerAsyncTimezoneCompute({
      requestId: newRequest.request_id,
      birth: {
        date: input.birth_date,
        time: input.birth_time,
        lat:  input.birth_place_lat,
        lng:  input.birth_place_lng,
      },
    });

    /* ----------------------- compose product for checkout ------------------ */
    const product = {
      productType:  newRequest.product_type,
      productName:  'MAPA NATAL ZODIKA',
      priceCents:   3500,
      currency:     'BRL',
      payment: {
        allow_pix: true,
        allow_card: true,
        max_installments: 1,
      },
      successUrl: `https://www.zodika.com.br/birthchart-payment-success?ref=${encodeURIComponent(newRequest.request_id)}`,
      metadata: {
        source: 'webflow',
        product_version: 'v1',
      },
    };

    /* ----------------------- route to the chosen PSP ---------------------- */
    const provider = getPaymentProvider();
    logger.info({ provider }, 'selecting PSP');

    const ctx = { requestId: req.requestId, log: req.log || baseLogger };
    let paymentResponse;

    if (provider === 'PAGBANK') {
      paymentResponse = await pagbankService.createCheckout({
        requestId:    newRequest.request_id,
        name:         newRequest.name,
        email:        newRequest.email,
        productType:  product.productType,
        productName:  product.productName,
        productValue: product.priceCents,
        paymentOptions: {
          allow_pix:        product.payment.allow_pix,
          allow_card:       product.payment.allow_card,
          max_installments: product.payment.max_installments,
        },
        productImageUrl: PRODUCT_IMAGE_URL,
        currency:   product.currency,
      }, ctx);

      logger.info(
        { checkoutId: paymentResponse.checkoutId || null, host: safeHost(paymentResponse.url) },
        'pagbank checkout created'
      );
    } else {
      paymentResponse = await mpService.createCheckout({
        requestId:    newRequest.request_id,
        name:         newRequest.name,
        email:        newRequest.email,
        productType:  product.productType,
        productName:  product.productName,
        productValue: product.priceCents,
        paymentOptions: {
          allow_pix:        product.payment.allow_pix,
          allow_card:       product.payment.allow_card,
          max_installments: product.payment.max_installments,
        },
        productImageUrl: PRODUCT_IMAGE_URL,
        currency:   product.currency,
        metadata:   product.metadata,
      }, ctx);

      logger.info(
        { preferenceId: paymentResponse.preferenceId || null, host: safeHost(paymentResponse.url) },
        'mercadopago preference created'
      );
    }

    /* ------------------- contract expected by the frontend ----------------- */
    return res.status(200).json({ url: paymentResponse.url });
  } catch (err) {
    if (err && err.name === 'ValidationError' && !err.code) {
      const wrapped = AppError.validation('validation_error', 'Validation Error', {
        details: err.details || undefined,
      });
      (req.log || baseLogger).error({ code: wrapped.code, status: wrapped.status }, 'validation failed');
      return next(wrapped);
    }

    if (err instanceof AppError) {
      (req.log || baseLogger).error({ code: err.code, status: err.status }, 'request failed');
      return next(err);
    }

    const wrapped = AppError.fromUnexpected('form_processing_failed', 'Failed to process request', { cause: err });
    (req.log || baseLogger).error({ code: wrapped.code, status: wrapped.status }, 'request failed (unexpected)');
    return next(wrapped);
  }
}

module.exports = { processForm };
