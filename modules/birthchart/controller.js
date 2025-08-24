// modules/birthchart/controller.js
const { validateBirthchartPayload } = require('./validators');
const { createBirthchartRequest } = require('./repository');
const { getTimezoneAtMoment } = require('../../utils/timezone');
const pagbankService = require('../../payments/pagBank/service');

async function processForm(req, res, next) {
  try {
    const payload = req.body;

    // valida payload do formulário
    validateBirthchartPayload(payload);
    
    async function processForm(req, res, next) {
      try {
        const payload = req.body;
        validateBirthchartPayload(payload);

    // Compute timezone (if we have coords)
    const { birth_place_lat, birth_place_lng, birth_date, birth_time } = payload;
    const { tzId, offsetMin } = await getTimezoneAtMoment({
          lat: Number(birth_place_lat),
          lng: Number(birth_place_lng),
          birthDate: birth_date,
          birthTime: birth_time,
          apiKey: process.env.GOOGLE_MAPS_API_KEY
    });
    
    // cria a request no banco
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

    // opções de pagamento (centavos)
    const paymentOptions = {
      allow_pix: true,
      allow_card: true,
      max_installments: 1,
    };

    // cria o checkout no PagBank
    const paymentResponse = await pagbankService.createCheckout({
      requestId: newRequest.request_id,
      name: newRequest.name,                    // (opcional, mas o service aceita)
      email: newRequest.email,
      productType: newRequest.product_type,     // service espera "productType"
      productValue: 3500,                       // R$ 35,00 em centavos
      paymentOptions,                           // aqui vai o objeto definido acima
    });

    return res.status(200).json({ url: paymentResponse.url });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  processForm,
};
