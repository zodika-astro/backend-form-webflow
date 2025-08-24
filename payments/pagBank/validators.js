// modules/pagbank/validators.js

const { z } = require('zod');

const pagbankWebhookSchema = z.object({
  id: z.string().uuid(),
  reference_id: z.string(),
  charges: z.array(z.object({
    id: z.string(),
    status: z.string(),
    amount: z.object({
      value: z.number().int(),
      currency: z.string(),
    }),
    payment_method: z.object({
      type: z.string(),
    }),
  })),
});


function validateWebhookPayload(_payload) {
  return;
}

module.exports = { validateWebhookPayload };
