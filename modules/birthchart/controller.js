// modules/birthchart/controller.js
'use strict';

/**
 * Birthchart Controller
 * ---------------------
 * Responsibilities
 *  - Validate and normalize public form input.
 *  - Resolve timezone at the given birth moment (Google Time Zone API).
 *  - Persist the request record.
 *  - Create a checkout on the selected PSP (PagBank or Mercado Pago).
 *
 * Non-functional
 *  - Structured logging with request correlation (no PII).
 *  - Standardized error codes (AppError) for upstream and internal failures.
 *  - Never trust raw req.body: filter/whitelist allowed fields before validation.
 */

const { validateBirthchartPayload } = require('./validators');
const { createBirthchartRequest } = require('./repository');
const { getTimezoneAtMoment } = require('../../utils/timezone');
const { get: getSecret } = require('../../config/secretProvider');
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
/* NEW: Minimal, in-file normalizers (no extra imports to avoid breakage).    */
/* -------------------------------------------------------------------------- */
/**
 * Accepts common consent field shapes from the frontend and maps to boolean.
 * Supports: boolean true/false, "on", "yes", "1", "true", "checked".
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
 * Picks the most likely reCAPTCHA token field sent by the frontend.
 * Supports: recaptcha_token, recaptchaToken, g-recaptcha-response, etc.
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
 * Feature flag: by default captcha is required unless explicitly disabled via env.
 * We intentionally read from process.env to avoid depending on envalid schema changes.
 */
const RECAPTCHA_REQUIRED =
  String(process.env.RECAPTCHA_REQUIRED ?? 'true').trim().toLowerCase() !== 'false';

/** Allowed public form fields (whitelist). Extra fields (e.g., CAPTCHA) are ignored here. */
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

/**
 * POST /birthchart/birthchartsubmit-form (public)
 * Body: validated by Zod in validateBirthchartPayload (normalized on return)
 *
 * Security:
 * - Router middlewares may enforce CAPTCHA/Privacy; we additionally normalize
 *   and enforce here to be robust against field-name drift on the frontend.
 * - We still ignore unexpected fields before validation/persistence.
 */
async function processForm(req, res, next) {
  // Derive a request-scoped logger (keeps correlation-id from middleware)
  const logger = (req.log || baseLogger).child('processForm', { rid: req.requestId });

  try {
    /* ----------------------- NEW: consent & captcha guards ---------------------- */
    // Normalize privacy consent from multiple possible field names.
    const privacyConsent = normalizeConsent(req.body);
    if (!privacyConsent) {
      // Use 400 to indicate client-side correction needed.
      throw new AppError(
        'privacy_consent_required',
        'Privacy Policy consent is required to submit this form.',
        400,
        { field: 'privacyConsent' }
      );
    }

    // Extract captcha token in a tolerant way; require it unless explicitly disabled.
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
        hasCaptchaHeader: !!req.captcha,     // from middleware (if any)
        hasCaptchaToken: !!captchaToken,     // from body
      },
      'consent/captcha normalized'
    );
    /* -------------------------------------------------------------------------- */

    // 1) Filter raw body (avoid mass assignment) and validate/normalize
    const filtered = pick(req.body, ALLOWED_FORM_KEYS);

    // If your validators already throw AppError.validation, this will bubble up intact.
    // If they throw a plain error, we convert to AppError in the catch block below.
    const input = validateBirthchartPayload(filtered);

    // 2) Resolve timezone (no PII in logs)
    const googleApiKey = await getSecret('GOOGLE_MAPS_API_KEY').catch((e) => {
      throw AppError.fromUpstream('secret_fetch_failed', 'Failed to load Google API key', e, { provider: 'secrets' });
    });

    const tz = await getTimezoneAtMoment({
      lat: Number(input.birth_place_lat),
      lng: Number(input.birth_place_lng),
      birthDate: input.birth_date,
      birthTime: input.birth_time,
      apiKey: googleApiKey,
    }).catch((e) => {
      throw AppError.fromUpstream('tz_lookup_failed', 'Failed to resolve timezone', e, { provider: 'google_timezone' });
    });

    if (!tz || !tz.tzId || typeof tz.offsetMin !== 'number') {
      // NOTE: keeping existing semantics; AppError.internal may not exist in your class,
      // so keep using a standard AppError with 500 to avoid breaking.
      throw new AppError('tz_invalid', 'Resolved timezone is invalid', 500, { got: tz ? Object.keys(tz) : null });
    }

    logger.info({ tzId: tz.tzId, offsetMin: tz.offsetMin }, 'timezone resolved');

    // 3) Persist request (minimal payload in logs; avoid PII)
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

      birth_timezone_id:    tz.tzId,
      birth_utc_offset_min: tz.offsetMin,
    }).catch((e) => {
      throw AppError.fromUpstream('db_persist_failed', 'Could not persist birthchart request', e, { entity: 'birthchart_request' });
    });

    logger.info({ requestId: newRequest.request_id, productType: newRequest.product_type }, 'request persisted');

    // 4) Compose product for checkout
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
      // Used by Mercado Pago back_urls (success page)
      returnUrl: `https://www.zodika.com.br/birthchart-payment-success?ref=${newRequest.request_id}`,
      metadata: {
        source: 'webflow',
        product_version: 'v1',
      },
    };

    // 5) Route to PSP (feature flag validated by envalid)
    const usePagBank = env.PAGBANK_ENABLED === true;
    logger.info({ provider: usePagBank ? 'pagbank' : 'mercadopago' }, 'selecting PSP');

    const ctx = { requestId: req.requestId, log: req.log || baseLogger };
    let paymentResponse;

    if (usePagBank) {
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
        returnUrl:  product.returnUrl,
        metadata:   product.metadata,
      }, ctx);

      logger.info(
        { preferenceId: paymentResponse.preferenceId || null, host: safeHost(paymentResponse.url) },
        'mercadopago preference created'
      );
    }

    // 6) Contract expected by the frontend
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
