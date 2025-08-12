// modules/birthchart/controller.js
const { validateBirthchartPayload } = require('./validators');
const { createBirthchartRequest } = require('./repository');
const pagbankService = require('../../payments/pagBank/service');

async function processForm(req, res, next) {
  try {
    const payload = req.body;

    // valida payload do formulário
    validateBirthchartPayload(payload);

    // cria a request no banco
    const newRequest = await createBirthchartRequest({
      name: payload.name,
      social_name: payload.social_name,
      email: payload.email,
      birth_date: payload.birth_date,
      birth_time: payload.birth_time,
      birth_place: payload.birth_place,
      product_type: payload.product_type,
    });

    // opções de pagamento (centavos)
    const paymentOptions = {
      allow_pix: true,
      allow_card: true,
      max_installments: 1,
      min_installment_amount: 3500, // R$ 35,00
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
