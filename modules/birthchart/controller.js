// modules/birthchart/controller.js
'use strict';

/**
 * Birthchart Controller
 * ---------------------
 * Responsibilities (fast path)
 *  - Validate and normalize public form input.
 *  - Persist the request record (with timezone placeholders).
 *  - Create a checkout on the selected PSP (PagBank or Mercado Pago).
 *  - Return the checkout URL immediately (do not block on timezone).
 *
 * Deferred work
 *  - Timezone resolution is deferred to the post-payment workflow (e.g., payment-approved webhook).
 *    This keeps form submission fast and avoids long upstream waits on external providers.
 *
 * Non-functional
 *  - Structured logging with request correlation (no PII).
 *  - Standardized error codes (AppError) for upstream and internal failures.
 *  - Never trust raw req.body: filter/whitelist allowed fields before validation.
 *
 * Business rule
 *  - Product-specific success URLs live in the product module (here).
 *  - PSP back_urls/redirects always point back to our backend return controllers.
 *    The return controller decides final redirects (success/fail/pending).
 */

const { validateBirthchartPayload } = require('./validators');
const { createBirthchartRequest } = require('./repository');

// Note: timezone resolution is now deferred. Imports are kept to avoid breaking other flows
// that may still rely on these modules elsewhere in the app.
const { getTimezoneAtMoment } = require('../../utils/timezone'); // intentionally unused here (deferred)
const { get: getSecret } = require('../../config/secretProvider'); // intentionally unused here (deferred)

const { env } = require('../../config/env');
const { AppError } = require('../../utils/appError');

// Logger (namespaced); request-scoped logger comes from middleware (req.log)
const baseLogger = require('../../utils/logger').child('form.birthchart');

// PSP services
const mpService = require('../../payments/mercadoPago/service');
const pagbankService = require('../../payments/pagBank/service');

const PRODUCT_IMAGE_URL = 'https://backend-form-webflow-production.up.railway.app/assets/birthchart-productimage.png';

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

/* -------------------------------------------------------------------------- */
/* Normalizers                                                                */
/* -------------------------------------------------------------------------- */
/**
 * Accept consent field variants and map to boolean.
 * Supports: boolean, number (1), "on"/"yes"/"1"/"true"/"checked".
 */
function normalizeConsent(body = {}) {
  const raw =
    body.privacyConsent ??
    body.privacy_agreed ??
    body.privacy ??
    body.privacy_policy ??
    body.policy ??
    body.terms;

  if (raw == null) return false;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;

  const s = String(raw).trim().toLowerCase();
  return s === 'true' || s === 'on' || s === 'yes' || s === '1' || s === 'checked';
}

/**
 * Pick the most likely reCAPTCHA token field from the request body.
 */
function pickCaptchaToken(body = {}) {
  return (
    body.recaptcha_token ??
    body.recaptchaToken ??
    body.captcha_token ??
    body.captchaToken ??
    body['g-recaptcha-response'] ??
    body.g_recaptcha_response ??
    body.captcha ??
    null
  );
}

/**
 * Feature flag: captcha is required unless explicitly disabled via env.
 * Read from process.env to avoid changing envalid schema.
 */
const RECAPTCHA_REQUIRED =
  String(process.env.RECAPTCHA_REQUIRED ?? 'true').trim().toLowerCase() !== 'false';

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
/**
 * Select payment provider from env.
 * Accepted values (case-insensitive): "MERCADO_PAGO" | "PAGBANK"
 * Default: "MERCADO_PAGO"
 */
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
 * POST /birthchart/birthchartsubmit-form (public)
 * Body: validated by Zod in validateBirthchartPayload (normalized on return)
 */
async function processForm(req, res, next) {
  const logger = (req.log || baseLogger).child('processForm', { rid: req.requestId });

  try {
    /* ----------------------- consent & captcha guards ----------------------- */
    const privacyConsent = normalizeConsent(req.body);
    if (!privacyConsent) {
      throw new AppError(
        'privacy_consent_required',
        'Privacy Policy consent is required to submit this form.',
        400,
        { field: 'privacyConsent' }
      );
    }

    const captchaToken = pickCaptchaToken(req.body);
    if (RECAPTCHA_REQUIRED && !captchaToken) {
      throw new AppError(
        'recaptcha_token_missing',
        'reCAPTCHA token is missing.',
        400,
        { provider: 'recaptcha_v3' }
      );
    }

    logger.info(
      {
        hasCaptchaHeader: !!req.captcha, // from middleware (if any)
        hasCaptchaToken: !!captchaToken, // from body
      },
      'consent/captcha normalized'
    );
    /* ----------------------------------------------------------------------- */

    // 1) Filter raw body and include captcha for schema compatibility.
    const filtered = pick(req.body, ALLOWED_FORM_KEYS);

    // Satisfy current validator shape: pass captcha as `captcha_token` (not persisted).
    if (captchaToken) filtered.captcha_token = String(captchaToken);

    // 2) Validate/normalize via schema (may throw)
    const input = validateBirthchartPayload(filtered);

    // 3) DEFER timezone resolution to post-payment workflow.
    //    Persist placeholders now; a webhook/worker should compute and update later.
    const tz = { tzId: null, offsetMin: null, deferred: true };
    logger.info({ deferred: true }, 'timezone resolution deferred');

    // 4) Persist request (minimal payload in logs; avoid PII)
    const newRequest = await createBirthchartRequest({
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

      // placeholders (to be filled after payment approval)
      birth_timezone_id:    tz.tzId,
      birth_utc_offset_min: tz.offsetMin,
    }).catch((e) => {
      throw AppError.fromUpstream('db_persist_failed', 'Could not persist birthchart request', e, { entity: 'birthchart_request' });
    });

    logger.info({ requestId: newRequest.request_id, productType: newRequest.product_type }, 'request persisted');

    // 5) Compose product for checkout
    // NOTE: successUrl is documented here (business rule), but NOT sent to the PSP.
    // PSP return URLs always point back to our backend return controllers.
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
      // Product-specific success URL (used by return controllers).
      successUrl: `https://www.zodika.com.br/birthchart-payment-success?ref=${encodeURIComponent(newRequest.request_id)}`,
      metadata: {
        source: 'webflow',
        product_version: 'v1',
      },
    };

    // 6) Route to PSP using PAYMENT_PROVIDER env
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
      // Default: MERCADO_PAGO
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
        // Intentionally DO NOT pass successUrl/returnUrl to the provider.
        metadata:   product.metadata,
      }, ctx);

      logger.info(
        { preferenceId: paymentResponse.preferenceId || null, host: safeHost(paymentResponse.url) },
        'mercadopago preference created'
      );
    }

    // 7) Contract expected by the frontend
    return res.status(200).json({ url: paymentResponse.url });
  } catch (err) {
    // Normalize non-AppError validation failures (e.g., Zod)
    if (err && err.name === 'ValidationError' && !err.code) {
      const wrapped = AppError.validation('validation_error', 'Validation Error', {
        details: err.details || undefined,
      });
      (req.log || baseLogger).error({ code: wrapped.code, status: wrapped.status }, 'validation failed');
      return next(wrapped);
    }

    // Pass through known AppErrors; wrap unknown as internal
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
