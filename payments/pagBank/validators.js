// payments/pagBank/validators.js

const { z } = require('zod');

const chargeSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  amount: z.object({
    value: z.union([z.number(), z.string()]).optional(),
    currency: z.string().optional(),
  }).optional(),
  reference_id: z.string().optional(),
  customer: z.any().optional(),
});

const checkoutSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  reference_id: z.string().optional(),
  items: z.any().optional(),
  customer: z.any().optional(),
});

const payloadSchema = z.object({

  data: z.any().optional(),
}).passthrough();

function validateWebhookPayload(payload) {
  try {
    const root = payloadSchema.parse(payload);
    const p = (root && root.data && typeof root.data === 'object') ? root.data : payload;


    if (Array.isArray(p?.charges) && p.charges.length) {
      chargeSchema.parse(p.charges[0]);
      return true;
    }
    if (p?.object === 'checkout' || (p?.items && p?.id)) {
      checkoutSchema.parse(p);
      return true;
    }

    return true;
  } catch (e) {
  
    throw new Error(`Invalid webhook payload: ${e.message}`);
  }
}

module.exports = { validateWebhookPayload };
