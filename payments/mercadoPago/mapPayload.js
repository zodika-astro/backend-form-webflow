// payments/mercadoPago/mapPayload.js

const crypto = require('crypto');

/** Mantém compatibilidade com seu PagBank mapPayload util */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  const allKeys = Object.keys(obj).sort();
  const out = {};
  for (const k of allKeys) out[k] = obj[k];
  return JSON.stringify(out);
}

function hashPayload(obj) {
  return crypto.createHash('sha256')
    .update(stableStringify(obj))
    .digest('hex');
}

/**
 * Normaliza dados de cliente a partir do "payment" do Mercado Pago.
 * O MP geralmente envia: payment.payer = { email, identification, first_name, last_name, phone: {number}, ... }
 * e o endereço pode vir em payment.additional_info.payer.address
 */
function normalizeCustomer(payer = {}, additionalInfo = {}) {
  const address = additionalInfo?.payer?.address || null;

  // O MP não separa claramente DDI/DDD, então mantemos simples:
  const phoneNumber = payer?.phone?.number || null;

  const name =
    payer?.name ||
    [payer?.first_name, payer?.last_name].filter(Boolean).join(' ').trim() ||
    null;

  return {
    name: name || null,
    email: payer?.email || null,
    tax_id: payer?.identification?.number || null,
    phone_country: null,
    phone_area: null,
    phone_number: phoneNumber || null,
    address_json: address || null,
  };
}

/** Para o MP, frequentemente o payload vem com { data: { id } }. */
function unwrapData(payload = {}) {
  if (payload && payload.data && typeof payload.data === 'object') return payload.data;
  return payload;
}

function detectObjectType(raw = {}) {
  // MP costuma mandar type='payment' ou action='payment.created'
  const t = (raw.type || raw.topic || '').toString().toLowerCase();
  if (t === 'payment') return 'payment';
  if (typeof raw.action === 'string' && raw.action.includes('payment')) return 'payment';

  // Caso o payload já seja um "payment" completo
  if (raw.transaction_amount != null && raw.status && raw.id) return 'payment';

  // Outros tipos possíveis (merchant_order etc.) podem ser tratados no futuro
  return 'unknown';
}

function normalizeMoneyFromPayment(payment = {}) {
  const raw = payment.transaction_amount ?? 0;
  const currency = payment.currency_id ?? null;

  let cents = 0;
  if (typeof raw === 'number') {
    cents = Math.round(raw * 100);
  } else if (typeof raw === 'string') {
    cents = raw.includes('.') ? Math.round(parseFloat(raw) * 100) : parseInt(raw, 10) * 100;
    if (!Number.isFinite(cents)) cents = 0;
  }

  return { cents, currency };
}

function normalizeStatus(s) {
  if (!s) return 'UNKNOWN';
  const up = String(s).toUpperCase();
  const map = {
    APPROVED: 'APPROVED',
    PENDING: 'PENDING',
    IN_PROCESS: 'PENDING',
    IN_MEDIATION: 'PENDING',
    REJECTED: 'REJECTED',
    CANCELLED: 'CANCELED',
    CANCELLED: 'CANCELED',
    REFUNDED: 'REFUNDED',
    CHARGED_BACK: 'CHARGED_BACK',
  };
  return map[up] || up || 'UNKNOWN';
}

/**
 * Mapeia um payload (seja a notificação fina {data:{id}} ou um payment completo)
 * em um objeto padronizado para o seu fluxo.
 *
 * Observação: no seu service do MP, você já faz o GET /v1/payments/{id} para obter
 * o pagamento completo. Este mapper é útil caso você queira inspecionar rapidamente
 * o conteúdo bruto recebido ou manter um padrão com o PagBank.
 */
function mapWebhookPayload(rawPayload) {
  // rawPayload: pode ser { type, action, data:{ id } } OU um "payment" completo
  const p = unwrapData(rawPayload);

  // Se só temos {id}, o service vai buscar os detalhes depois.
  const objectType = detectObjectType(rawPayload) || 'unknown';

  // Identificadores comuns
  const paymentId =
    p?.id ||
    rawPayload?.id ||
    rawPayload?.payment_id ||
    null;

  const preferenceId =
    p?.preference_id ||
    rawPayload?.preference_id ||
    null;

  const externalReference =
    p?.external_reference ||
    rawPayload?.external_reference ||
    null;

  // Status e valores (quando já vierem no corpo; se não vierem, ficam nulos)
  const status = normalizeStatus(p?.status || rawPayload?.status || null);
  const { cents: value_cents, currency } = normalizeMoneyFromPayment(p || {});

  // Cliente
  const customer = normalizeCustomer(p?.payer || {}, p?.additional_info || {});

  // Provider UID para idempotência
  const providerId =
    rawPayload?.id ||
    rawPayload?.notification_id ||
    null;

  const eventId = providerId
    ? `mp_${objectType}_${providerId}`
    : hashPayload({ h: rawPayload, t: objectType });

  return {
    eventId,
    objectType,
    preferenceId,
    paymentId,
    externalReference,
    status,
    value_cents,
    currency,
    customer,
    rawPayload: p, // guardamos só o miolo relevante
  };
}

module.exports = {
  mapWebhookPayload,
  normalizeCustomer,
  stableStringify,
  hashPayload,
  normalizeStatus,
};
