// modules/birthchart/controller.js
'use strict';

const { validateBirthchartPayload } = require('./validators');
const { createBirthchartRequest } = require('./repository');
const { getTimezoneAtMoment } = require('../../utils/timezone');
const { get: getSecret } = require('../../config/secretProvider'); // secure secret retrieval
const { env } = require('../../config/env'); // runtime feature flags / non-secret config

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
 * - Do not read secrets directly from process.env in controllers.
 * - Keep logs minimal; do not log PII or tokens.
 */
async function processForm(req, res, next) {
  try {
    const payload = req.body;
    validateBirthchartPayload(payload);

    // Obtain Google Maps API key via the secret provider (cached).
    const googleApiKey = await getSecret('GOOGLE_MAPS_API_KEY');

    // Timezone resolution at the birth moment
    const { tzId, offsetMin } = await getTimezoneAtMoment({
      lat: Number(payload.birth_place_lat),
      lng: Number(payload.birth_place_lng),
      birthDate: payload.birth_date,
      birthTime: payload.birth_time,
      apiKey: googleApiKey,
    });
    // Debug-only: no sensitive data is logged
    console.debug('[Birthchart][TZ]', { tzId, offsetMin });

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

    let paymentResponse;
    if (usePagBank) {
      // PagBank: `createCheckout` does not consume returnUrl/metadata; omit them for clarity.
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
    }

    // Keep the same contract expected by the frontend
    return res.status(200).json({ url: paymentResponse.url });
  } catch (error) {
    return next(error);
  }
}

module.exports = { processForm };
