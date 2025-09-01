// payments/mercadoPago/service.js

const axios = require('axios');
const crypto = require('crypto');
const EventEmitter = require('events');
const logger = require('../../utils/logger');
const { env } = require('../../config/env');
const mpRepository = require('./repository'); // precisa ter métodos análogos ao pagbankRepository
//   - createCheckout({ request_id, product_type, preference_id, status, value, link, customer, raw })
//   - logEvent({ event_uid, payload, headers, query, topic, action, preference_id, payment_id })
//   - updateRequestStatusByPreferenceId(preference_id, status, raw)
//   - upsertPaymentByPaymentId({...})
//   - findByPaymentId(payment_id)
//   - findByPreferenceId(preference_id)

const events = new EventEmitter();
const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/** Axios cliente Mercado Pago */
const mpClient = axios.create({
  baseURL: 'https://api.mercadopago.com',
  timeout: 20000,
});

/** Helpers de URL (mesmos do PagBank para manter consistência) */
const stripQuotesAndSemicolons = (u) => {
  if (!u) return null;
  let s = String(u).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  s = s.replace(/[;\s]+$/g, '');
  return s;
};

const normalizeHttpsUrl = (u, { max = 255 } = {}) => {
  const s = stripQuotesAndSemicolons(u);
  if (!s) return null;
  if (!/^https:\/\/[^\s<>"]+$/i.test(s)) return null;
  if (s.length > max) return null;
  return s;
};

/** Mapeamento simples de status MP -> status interno do seu mp_request */
const mapPreferenceStatusFromPayment = (paymentStatus) => {
  switch ((paymentStatus || '').toLowerCase()) {
    case 'approved':
      return 'APPROVED';
    case 'in_process':
    case 'pending':
      return 'PENDING';
    case 'rejected':
      return 'REJECTED';
    case 'refunded':
    case 'charged_back':
      return 'REFUNDED';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'UPDATED';
  }
};

/** Cria a preference (Checkout Pro) e grava em mp_request */
async function createCheckout({
  requestId,
  name,
  email,
  productType,
  productValue,
  productName,
  paymentOptions,
  currency,
  productImageUrl,
  returnUrl,     // opcional (para sua página de sucesso)
  metadata = {}, // opcional
}) {
  if (!requestId) throw new Error('requestId is required');

  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0) {
    throw new Error('invalid productValue (cents, integer > 0)');
  }

  const PUBLIC_BASE_URL =
    process.env.PUBLIC_BASE_URL ||
    'https://backend-form-webflow-production.up.railway.app';

  // back_urls do MP são opcionais; se não vier returnUrl, usamos uma genérica
  const success = normalizeHttpsUrl(returnUrl) ||
    normalizeHttpsUrl(`${PUBLIC_BASE_URL}/mercadopago/return/success`);
  const failure = normalizeHttpsUrl(`${PUBLIC_BASE_URL}/mercadopago/return/failure`);
  const pending = normalizeHttpsUrl(`${PUBLIC_BASE_URL}/mercadopago/return/pending`);

  const notification_url = normalizeHttpsUrl(process.env.MP_WEBHOOK_URL);
  const picture_url = normalizeHttpsUrl(productImageUrl, { max: 512 }) ||
    null;

  // MP trabalha com valores em reais (ex.: 35.00). Como você usa "cents",
  // convertemos: 3500 -> 35.00
  const amount = Math.round(valueNum) / 100;

  const preferencePayload = {
    external_reference: String(requestId),      // seu request_ref
    items: [
      {
        title: productName || productType || 'Produto',
        quantity: 1,
        unit_price: amount,
        currency_id: currency || 'BRL',
        ...(picture_url ? { picture_url } : {}),
      },
    ],
    payer: (name || email) ? { name, email } : undefined,
    back_urls: (success && failure && pending)
      ? { success, failure, pending }
      : undefined,
    auto_return: success ? 'approved' : undefined, // retorna para success quando aprovado
    notification_url: notification_url || undefined,
    metadata: { source: 'backend', ...metadata },
  };

  try {
    const res = await mpClient.post('/checkout/preferences', preferencePayload, {
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN || env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Idempotency-Key': uuid(),
      },
    });

    const data = res?.data;
    logger.info('[MP][RES create preference]', { status: res?.status, data });

    const preferenceId = data?.id || null;
    const initPoint = data?.init_point || data?.sandbox_init_point || null;
    if (!initPoint) {
      throw new Error('init_point not found in Mercado Pago response');
    }

    // grava em mp_request
    await mpRepository.createCheckout({
      request_id: String(requestId),
      product_type: productType,
      preference_id: preferenceId,
      status: 'CREATED',
      value: valueNum,
      link: initPoint,
      customer: (name || email) ? { name, email } : null,
      raw: data,
    });

    // log no mp_events
    try {
      await mpRepository.logEvent({
        event_uid: `preference_created_${preferenceId || requestId}`,
        payload: { request_payload: preferencePayload, response: data },
        headers: null,
        query: null,
        topic: 'preference',
        action: 'CREATED',
        preference_id: preferenceId,
        payment_id: null,
      });
    } catch (logErr) {
      logger.warn('[MP] could not log preference creation event:', logErr?.message || logErr);
    }

    return { url: initPoint, preferenceId };
  } catch (e) {
    if (e.response) {
      logger.error('[MP][ERR create preference]', {
        status: e.response.status,
        data: e.response.data,
        data_str: (() => { try { return JSON.stringify(e.response.data); } catch { return String(e.response.data); } })(),
        sent_str: (() => { try { return JSON.stringify(preferencePayload); } catch { return '<<payload>>'; } })(),
      });
    } else {
      logger.error('[MP][ERR-NETWORK create preference]', e.message);
    }
    throw e;
  }
}

/**
 * Resolve e carrega detalhes de pagamento no MP.
 * É usado para processar webhooks de topic/type "payment".
 */
async function fetchPayment(paymentId) {
  if (!paymentId) return null;

  try {
    const res = await mpClient.get(`/v1/payments/${paymentId}`, {
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN || env.MP_ACCESS_TOKEN}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });
    return res?.data || null;
  } catch (e) {
    const status = e?.response?.status;
    logger.error('[MP][ERR fetchPayment]', { paymentId, status, msg: e?.message, data: e?.response?.data });
    return null;
  }
}

/**
 * Processa webhook do Mercado Pago:
 * - salva em mp_events (auditoria)
 * - quando for payment, carrega detalhes e faz upsert em mp_payments
 * - atualiza status do mp_request pela preference_id
 * - emite "payment:paid" quando approved
 */
async function processWebhook(body, meta = {}) {
  try {
    // Estruturas típicas do MP:
    // 1) { "type": "payment", "data": { "id": "123" } }
    // 2) { "action": "payment.created", "data": { "id": "123" } } (outras variações)
    // 3) Querystring às vezes contém ?type=payment&id=123
    const type = meta?.query?.type || body?.type || null;
    const action = body?.action || null;
    const dataId = meta?.query?.id || body?.data?.id || null;

    // Heurísticas específicas
    const topic = type || (action ? action.split('.')[0] : null); // "payment", "merchant_order", etc.

    // Para criar um "uid" idempotente do evento
    const providerEventUid =
      (meta?.headers && (meta.headers['x-request-id'] || meta.headers['x-correlation-id'])) ||
      `${topic || 'event'}_${dataId || uuid()}_${Date.now()}`;

    // Extra (quando o MP envia já o payment no corpo — menos comum)
    const hintedPaymentId =
      dataId || body?.id || body?.payment_id || null;

    // Log do evento cru
    await mpRepository.logEvent({
      event_uid: providerEventUid,
      payload: body,
      headers: meta.headers || null,
      query: meta.query || null,
      topic: topic || null,
      action: action || null,
      preference_id: null,
      payment_id: hintedPaymentId || null,
    });

    // Processamento por tipo
    if ((topic || '').toLowerCase() === 'payment' && hintedPaymentId) {
      const payment = await fetchPayment(hintedPaymentId);
      if (!payment) return { ok: true, note: 'payment details not found' };

      // Campos úteis do pagamento
      const payment_id = String(payment.id);
      const status = payment.status;                 // approved|pending|rejected|refunded|cancelled|in_process
      const status_detail = payment.status_detail;   // accredited, cc_rejected_*, etc.
      const external_reference = payment.external_reference || null;
      const preference_id = payment.preference_id || null;
      const amount = Number(payment.transaction_amount || 0);

      const payer = payment.payer || {};
      const billing = payment.additional_info?.payer?.address || null;

      // upsert em mp_payments
      await mpRepository.upsertPaymentByPaymentId({
        payment_id,
        preference_id,
        status,
        status_detail,
        external_reference,
        customer: {
          name: payer?.first_name || payer?.name || null,
          email: payer?.email || null,
          tax_id: payer?.identification?.number || null,
          phone_country: payer?.phone?.area_code ? null : null, // MP não separa DDI/DDD de forma padrão aqui
          phone_area: null,
          phone_number: payer?.phone?.number || null,
          address_json: billing ? billing : null,
        },
        transaction_amount: amount,
        raw: payment,
      });

      // atualiza mp_request pelo preference_id (quando existir)
      if (preference_id) {
        const reqStatus = mapPreferenceStatusFromPayment(status);
        await mpRepository.updateRequestStatusByPreferenceId(preference_id, reqStatus, payment);
      }

      // evento de aprovação
      if ((status || '').toLowerCase() === 'approved') {
        // tentar resgatar o request para emitir contexto
        const record = (payment_id
          ? await mpRepository.findByPaymentId(payment_id)
          : preference_id
          ? await mpRepository.findByPreferenceId(preference_id)
          : null);

        if (record) {
          const { request_id: requestId, product_type: productType } = record;
          events.emit('payment:paid', {
            requestId,
            productType,
            paymentId: payment_id,
            preferenceId: preference_id,
            raw: payment,
          });
        }
      }
    }

    // Você pode adicionar o ramo "merchant_order" futuramente se precisar.
    return { ok: true };
  } catch (err) {
    logger.error('[MP] Error processing webhook:', err?.message || err);
    return { ok: false, error: 'internal_error' };
  }
}

module.exports = { createCheckout, processWebhook, events };

