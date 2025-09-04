// modules/birthchart/controller.js
'use strict';

const { validateBirthchartPayload } = require('./validators');
const { createBirthchartRequest } = require('./repository');
const { getTimezoneAtMoment } = require('../../utils/timezone');
const { get: getSecret } = require('../../config/secretProvider'); // secure secret retrieval
const { env } = require('../../config/env'); // runtime feature flags / non-secret config

// Logger (namespaced) — preserva correlação via req.log quando disponível
const baseLogger = require('../../utils/logger').child('form.birthchart');

// Payment providers
const mpService = require('../../payments/mercadoPago/service');
const pagbankService = require('../../payments/pagBank/service');

const PRODUCT_IMAGE_URL = 'https://backend-form-webflow-production.up.railway.app/assets/birthchart-productimage.png';

/**
 * Controller: Birthchart
 * ----------------------
 * - Validates and normalizes payload from the public form.
 * - Resolves timezone using Google Time Zone API (API key via secret provider).
 * - Creates a checkout using the selected PSP:
 *     - If env.PAGBANK_ENABLED === true → PagBank
 *     - Otherwise → Mercado Pago (default)
 *
 * Security notes:
 * - Do not log PII or tokens; keep logs minimal and structured.
 * - Secrets must be retrieved via secretProvider (never directly from process.env here).
 */

function safeHost(u) {
  try { return new URL(u).host; } catch { return undefined; }
}

async function processForm(req, res, next) {
  // Derive a request-scoped logger (keeps requestId/correlation from middleware)
  const logger = (req.log || baseLogger).child('processForm');

  try {
    logger.info('received submission');

    const payload = req.body;
    validateBirthchartPayload(payload);

    // Obtain Google Maps API key via the secret provider (cached).
    const googleApiKey = await getSecret('GOOGLE_MAPS_API_KEY');

    // Timezone resolution at the birth moment (no PII in logs)
    const { tzId, offsetMin } = await getTimezoneAtMoment({
      lat: Number(payload.birth_place_lat),
      lng: Number(payload.birth_place_lng),
      birthDate: payload.birth_date,
      birthTime: payload.birth_time,
      apiKey: googleApiKey,
    });
    logger.info({ tzId, offsetMin }, 'timezone resolved');

    // Persist the request in the repository
    const newRequest = await createBirthchartRequest({
      name:                 payload.name,
      social_name:          payload.social_name,
      email:                payload.email,
      birth_date:           payload.birth_date,
      birth_time:           payload.birth_time,
      birth_place:          payload.birth_place,
      product_type:         payload.product_type,

      birth_place_place_id: payload.birth_place_place_id,
      birth_place_full:     payload.birth_place_full,
      birth_place_country:  payload.birth_place_country,
      birth_place_admin1:   payload.birth_place_admin1,
      birth_place_admin2:   payload.birth_place_admin2,
      birth_place_lat:      payload.birth_place_lat,
      birth_place_lng:      payload.birth_place_lng,
      birth_place_json:     payload.birth_place_json,

      birth_timezone_id:    tzId,
      birth_utc_offset_min: offsetMin,
    });
    logger.info({ requestId: newRequest.request_id, productType: newRequest.product_type }, 'request persisted');

    // Product definition for checkout
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
      // Used by Mercado Pago back_urls (success)
      returnUrl: `https://www.zodika.com.br/birthchart-payment-success?ref=${newRequest.request_id}`,
      metadata: {
        source: 'webflow',
        product_version: 'v1',
      },
    };

    // Choose PSP based on feature flag (bool validated by envalid)
    const usePagBank = env.PAGBANK_ENABLED === true;
    logger.info({ provider: usePagBank ? 'pagbank' : 'mercadopago' }, 'selecting PSP');

    let paymentResponse;

    if (usePagBank) {
      // PagBank: returnUrl/metadata não são usados aqui
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
      });

      logger.info(
        { checkoutId: paymentResponse.checkoutId || null, host: safeHost(paymentResponse.url) },
        'pagbank checkout created'
      );
    } else {
      // Mercado Pago (default)
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
      });

      logger.info(
        { preferenceId: paymentResponse.preferenceId || null, host: safeHost(paymentResponse.url) },
        'mercadopago preference created'
      );
    }

    // Keep the same contract expected by the frontend
    return res.status(200).json({ url: paymentResponse.url });
  } catch (error) {
    // Log structured error (stack é manejada pelo error handler em produção)
    const msg = error?.message || 'unknown_error';
    const code = error?.status || 500;
    // Não incluir payload/PII aqui
    (req.log || baseLogger).error({ err: msg, status: code }, 'failed to process form');
    return next(error);
  }
}

module.exports = { processForm };
