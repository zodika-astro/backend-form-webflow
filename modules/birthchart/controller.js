// modules/birthchart/controller.js
const { validateBirthchartPayload } = require('./validators');
const { createBirthchartRequest } = require('./repository');
const pagbankService = require('../../payments/pagBank/service');


async function processForm(req, res, next) {
    try {
        const payload = req.body;

        validateBirthchartPayload(payload);

        const newRequest = await createBirthchartRequest({
            name: payload.name,
            social_name: payload.social_name,
            email: payload.email,
            birth_date: payload.birth_date,
            birth_time: payload.birth_time,
            birth_place: payload.birth_place,
            product_type: payload.product_type
        });

        const paymentOptions = {
            allow_pix: true, 
            allow_card: true, 
            max_installments: 1,
            min_installment_amount: 3500 
        };

        const paymentResponse = await pagbankService.createCheckout({
            email: newRequest.email,
            requestId: newRequest.request_id,
            productValue: 3500,
            redirectUrl: 'www.zodika.com.br/birthchart-payment-success'
            paymentOptions: 
        });

        res.status(200).json({ url: paymentResponse.url });

    } catch (error) {
        next(error);
    }
}

module.exports = {
    processForm,
};
