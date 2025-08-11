// modules/birthchart/controller.js
const { validateBirthchartPayload } = require('./validators');
const { createBirthchartRequest } = require('./repository');
const pagbankService = require('../../payments/pagbank/service');


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
            birth_place: payload.birth_place
        });

        const paymentResponse = await pagbankService.createPayment({
            email: newRequest.email,
            requestId: newRequest.request_id,
            productValue: 3500, 
        });

        res.status(200).json({ url: paymentResponse.url });

    } catch (error) {
        next(error);
    }
}

module.exports = {
    processForm,
};
