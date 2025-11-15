// payments/payPal/validators.js
'use strict';

const { z } = require('zod');

/**
 * PayPal Webhook Envelope Schema
 * --------------------------------
 * This schema matches the typical PayPal webhook format:
 *
 * {
 *   "id": "WH-XXX",
 *   "event_type": "CHECKOUT.ORDER.APPROVED",
 *   "resource": {
 *      "id": "ORDER-123",
 *      "status": "APPROVED"
 *   }
 * }
 *
 * We intentionally keep the schema permissive (passthrough)
 * to avoid blocking webhook delivery in case PayPal changes fields.
 */
const paypalWebhookEnvelopeSchema = z.object({
  id: z.string().optional(),  // PayPal webhook id (not needed internally)
  event_type: z.string().optional(),
  resource: z.object({
    id: z.string().optional(),
    status: z.string().optional(),  // APPROVED | COMPLETED | DECLINED | VOIDED | PENDING...
  })
  .partial()                   // allow empty resource object
  .optional(),
})
.passthrough();

/**
 * PayPal Order Schema
 * --------------------------------
 * Used when PayPal sends full `resource` for ORDER events.
 * E.g:
 * {
 *   "id": "ORDER-123",
 *   "status": "APPROVED",
 *   "purchase_units": [...]
 * }
 */
const paypalOrderSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  purchase_units: z.any().optional(),
}).passthrough();

/**
 * PayPal Capture Schema
 * --------------------------------
 * Some webhook events provide a "capture" object instead of an order.
 * E.g:
 * {
 *   "id": "CAPTURE-XYZ",
 *   "status": "COMPLETED",
 *   "amount": { "value": "35.00", "currency_code": "BRL" }
 * }
 */
const paypalCaptureSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  amount: z.object({
    value: z.string().optional(),
    currency_code: z.string().optional(),
  }).optional(),
}).passthrough();

/**
 * validateWebhookPayload(payload)
 * --------------------------------
 * We validate PayPal webhook payloads in a tolerant way:
 *
 * 1. If the envelope format is valid → accept.
 * 2. If the envelope resource matches an Order → accept.
 * 3. If the envelope resource matches a Capture → accept.
 * 4. If none match → still accept (never block webhooks).
 *
 * This follows the same philosophy you use for Mercado Pago and PagBank:
 * “validate lightly, never break provider delivery”.
 */
function validateWebhookPayload(payload) {
  try {
    // 1) Full envelope (most common scenario)
    const env = paypalWebhookEnvelopeSchema.safeParse(payload);
    if (env.success && env.data?.resource?.id) {
      return true;
    }

    // 2) Resource matches Order schema
    if (payload?.resource) {
      const orderTry = paypalOrderSchema.safeParse(payload.resource);
      if (orderTry.success && orderTry.data.id) return true;

      const captureTry = paypalCaptureSchema.safeParse(payload.resource);
      if (captureTry.success && captureTry.data.id) return true;
    }

    // 3) Default: accept silently
    // We NEVER block PayPal webhooks even if schema changes
    return true;

  } catch (err) {
    // Throw only if you want visibility in logs — not to reject webhook
    throw new Error(`Invalid PayPal webhook payload: ${err.message}`);
  }
}

module.exports = {
  validateWebhookPayload,
  paypalWebhookEnvelopeSchema,
  paypalOrderSchema,
  paypalCaptureSchema,
};
