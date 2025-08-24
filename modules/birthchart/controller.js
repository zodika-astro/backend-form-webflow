// modules/birthchart/controller.js
const { validateBirthchartPayload } = require('./validators');
const { createBirthchartRequest } = require('./repository');
const { getTimezoneAtMoment } = require('../../utils/timezone');
const pagbankService = require('../../payments/pagBank/service');

async function processForm(req, res, next) {
  try {
    const payload = req.body;

    // 1) Validação do payload
    validateBirthchartPayload(payload);

    // 2) (Opcional) Calcular timezone no momento do nascimento
    //    Se faltar algo (sem lat/lng ou sem API key), a função já devolve { tzId: null, offsetMin: null }
    const { tzId, offsetMin } = await getTimezoneAtMoment({
      lat: Number(payload.birth_place_lat),
      lng: Number(payload.birth_place_lng),
      birthDate: payload.birth_date,
      birthTime: payload.birth_time,
      apiKey: process.env.GOOGLE_MAPS_API_KEY,
    });
    console.log('[DEBUG TZ]', { tzId, offsetMin });

    // 3) Inserir a request no banco (incluindo os campos novos de local e timezone)
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

    // 4) Opções de pagamento e criação do checkout no PagBank
    const paymentOptions = { allow_pix: true, allow_card: true, max_installments: 1 };

    const paymentResponse = await pagbankService.createCheckout({
      requestId: newRequest.request_id,
      name: newRequest.name,
      email: newRequest.email,
      productType: newRequest.product_type,
      productValue: 3500, // R$ 35,00 em centavos
      paymentOptions,
    });

    // 5) Resposta para o front
    return res.status(200).json({ url: paymentResponse.url });
  } catch (error) {
    return next(error);
  }
}

module.exports = { processForm };
