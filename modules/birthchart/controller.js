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
 *  - No secrets read directly from process.env (use secret provider).
 */

const { validateBirthchartPayload } = require('./validators');
const { createBirthchartRequest } = require('./repository');
const { getTimezoneAtMoment } = require('../../utils/timezone');
const { get: getSecret } = require('../../config/secretProvider');
const { env } = require('../../config/env');
const { AppError } = require('../../utils/appError');

// Logger (namespaced); request-scoped logger is derived from middleware (req.log)
const baseLogger = require('../../utils/logger').child('form.birthchart');

// PSP services
const mpService = require('../../payments/mercadoPago/service');
const pagbankService = require('../../payments/pagBank/service');

const PRODUCT_IMAGE_URL = 'https://backend-form-webflow-production.up.railway.app/assets/birthchart-productimage.png';

/** Safe host extraction for logs (prevents leaking full URLs with query params/PII). */
function safeHost(u) {
  try { return new URL(u).host; } catch { return undefined; }
}

/**
 * POST /birthchart (public)
 * Body: validated by Zod in validateBirthchartPayload (normalized on return)
 */
async function processForm(req, res, next) {
  // Derive a request-scoped logger (keeps correlation-id from middleware)
  const logger = (req.log || baseLogger).child('processForm', { rid: req.requestId });

  try {
    logger.info('received submission');

    // 1) Validate & normalize input
    //    - If your validators already throw AppError.validation, this will bubble up intact.
    //    - If they throw a plain error, we convert to AppError in the catch block below.
    const input = validateBirthchartPayload(req.body);

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
    // Normalize non-AppError validation failures
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
