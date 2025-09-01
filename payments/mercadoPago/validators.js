// payments/mercadoPago/validators.js

const { z } = require('zod');

/**
 * Schema de "payment" do Mercado Pago (mínimo necessário para não travar o fluxo).
 * Quando o webhook chega só com { data: { id } }, validamos a forma do envelope.
 */
const paymentSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  status: z.string().optional(),            // approved | pending | rejected | in_process | refunded | cancelled...
  status_detail: z.string().optional(),
  transaction_amount: z.union([z.number(), z.string()]).optional(),
  currency_id: z.string().optional(),
  external_reference: z.string().optional(),
  preference_id: z.string().optional(),
  payer: z.any().optional(),
  additional_info: z.any().optional(),
}).passthrough();

const envelopeSchema = z.object({
  type: z.string().optional(),              // "payment"
  action: z.string().optional(),            // "payment.created" | "payment.updated"
  data: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
  }).optional(),
}).passthrough();

/**
 * Valida payload de webhook do MP sem ser rígido demais.
 * - Se vier envelope { data: { id } }, aceitamos.
 * - Se vier um payment completo (ex.: em testes), validamos com paymentSchema.
 * - Caso contrário, passamos (não travamos o webhook), igual à sua filosofia no PagBank.
 */
function validateWebhookPayload(payload) {
  try {
    // 1) Envelope padrão (mais comum no MP)
    const envOk = envelopeSchema.safeParse(payload);
    if (envOk.success && envOk.data?.data?.id) return true;

    // 2) Payload "payment" completo
    const payOk = paymentSchema.safeParse(payload);
    if (payOk.success && payOk.data?.id) return true;

    // 3) Se não casou com nenhum, não travamos o fluxo (mantém filosofia do PagBank)
    return true;
  } catch (e) {
    throw new Error(`Invalid Mercado Pago webhook payload: ${e.message}`);
  }
}

module.exports = { validateWebhookPayload };
