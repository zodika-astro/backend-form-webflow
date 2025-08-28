// modules/birthchart/controller.js

const { validateBirthchartPayload } = require('./validators');
const { createBirthchartRequest } = require('./repository');
const { getTimezoneAtMoment } = require('../../utils/timezone');
const pagbankService = require('../../payments/pagBank/service');

async function processForm(req, res, next) {
  try {
    const payload = req.body;
    validateBirthchartPayload(payload);

    // Timezone 
    const { tzId, offsetMin } = await getTimezoneAtMoment({
      lat: Number(payload.birth_place_lat),
      lng: Number(payload.birth_place_lng),
      birthDate: payload.birth_date,
      birthTime: payload.birth_time,
      apiKey: process.env.GOOGLE_MAPS_API_KEY,
    });
    console.log('[DEBUG TZ]', { tzId, offsetMin });

    // Repository
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

    // Product
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
      
      returnUrl: `https://www.zodika.com.br/birthchart-payment-success?ref=${newRequest.request_id}`,
    
      metadata: {
        source: 'webflow',
        product_version: 'v1',
      },
    };

    // Checkout
    const paymentResponse = await pagbankService.createCheckout({
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
      // extra
      currency:   product.currency,
      returnUrl:  product.returnUrl,
      metadata:   product.metadata,
    });

    // frontend
    return res.status(200).json({ url: paymentResponse.url });
  } catch (error) {
    return next(error);
  }
}

module.exports = { processForm };
