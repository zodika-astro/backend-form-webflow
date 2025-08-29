// payments/pagBank/service.js

const httpClient = require('../../utils/httpClient');
const logger = require('../../utils/logger');
const crypto = require('crypto');
const EventEmitter = require('events');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const { env } = require('../../config/env');
const pagbankRepository = require('./repository');
const { mapWebhookPayload } = require('./mapPayload');

const events = new EventEmitter();

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
}) {
  if (!requestId) throw new Error('requestId is required');

  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0) throw new Error('invalid productValue (cents, integer > 0)');

  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://backend-form-webflow-production.up.railway.app';
  const redirectUrlRaw = `${PUBLIC_BASE_URL}/pagbank/return`;
  const redirect_url = normalizeHttpsUrl(redirectUrlRaw);
  if (!redirect_url) throw new Error('invalid redirect_url');

  const methods = [];
  if (paymentOptions?.allow_pix !== false) methods.push('PIX');
  if (paymentOptions?.allow_card !== false) methods.push('CREDIT_CARD');
  const selected = methods.length ? methods : ['PIX', 'CREDIT_CARD'];

  const webhookUrl = normalizeHttpsUrl(process.env.PAGBANK_WEBHOOK_URL);
  const imageUrl = normalizeHttpsUrl(productImageUrl, { max: 512 }) || normalizeHttpsUrl(process.env.PAGBANK_PRODUCT_IMAGE_URL, { max: 512 });

  const payload = JSON.parse(JSON.stringify({
    reference_id: String(requestId),
    items: [
      {
        name: productName || productType || 'Produto',
        quantity: 1,
        unit_amount: valueNum,
        ...(imageUrl ? { image_url: imageUrl } : {})
      },
    ],
    checkout: { redirect_url },
    payment_methods: selected.map((t) => ({ type: t })),
    payment_methods_configs: selected.includes('CREDIT_CARD')
      ? [
          {
            type: 'CREDIT_CARD',
            config_options: [
              {
                option: 'INSTALLMENTS_LIMIT',
                value: String(paymentOptions?.max_installments || '1'),
              },
            ],
          },
        ]
      : undefined,
    payment_notification_urls: webhookUrl ? [webhookUrl] : undefined,
    customer: name && email ? { name, email } : undefined,
    currency: currency || undefined,
  }));

  try {
    const res = await httpClient.post('/checkouts', payload, {
      headers: {
        Authorization: `Bearer ${env.PAGBANK_API_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Idempotency-Key': uuid(),
      },
      timeout: 20000,
    });

    const data = res?.data;
    logger.info('[PagBank][RES]', { status: res?.status, url: res?.config?.url, data });

    let payLink = null;
    if (Array.isArray(data?.links)) {
      payLink =
        data.links.find((l) => (l.rel || '').toUpperCase() === 'PAY')?.href ||
        data.links.find((l) => (l.rel || '').toUpperCase() === 'CHECKOUT')?.href ||
        data.links.find((l) => (l.rel || '').toUpperCase() === 'SELF')?.href;
    }
    if (!payLink && data?.payment_url) payLink = data.payment_url;
    if (!payLink && data?.checkout?.payment_url) payLink = data.checkout.payment_url;
    if (!payLink) throw new Error('PAY link not found in PagBank return');

    await pagbankRepository.createCheckout({
      request_id: String(requestId),
      product_type: productType,
      checkout_id: data?.id || null,
      status: data?.status || 'CREATED',
      value: valueNum,
      link: payLink,
      customer: name && email ? { name, email } : null,
      raw: data,
    });

    try {
      await pagbankRepository.logEvent({
        event_uid: `checkout_created_${data?.id || requestId}`,
        payload: { request_payload: payload, response: data },
        headers: null,
        query: null,
        topic: 'checkout',
        action: 'CREATED',
        checkout_id: data?.id || null,
        charge_id: null,
      });
    } catch (logErr) {
      logger.warn('[PagBank] could not log checkout creation event:', logErr?.message || logErr);
    }

    return { url: payLink, checkoutId: data?.id || null };
  } catch (e) {
    if (e.response) {
      logger.error('[PagBank][ERR]', {
        status: e.response.status,
        url: e.config?.url,
        data: e.response.data,
        data_str: (() => {
          try { return JSON.stringify(e.response.data); } catch { return String(e.response.data); }
        })(),
        headers: e.response.headers,
        sent: e.config?.data,
        sent_str: (() => {
          try { return JSON.stringify(e.config?.data); } catch { return String(e.config?.data); }
        })(),
      });
    } else {
      logger.error('[PagBank][ERR-NETWORK]', e.message);
    }
    throw e;
  }
}

async function processWebhook(p, meta = {}) {
  try {
    const { eventId, objectType, checkoutId, chargeId, referenceId, status, customer } = mapWebhookPayload(p);

    const logged = await pagbankRepository.logEvent({
      event_uid: eventId,
      payload: p,
      headers: meta.headers || null,
      query: meta.query || null,
      topic: meta.topic || null,
      action: meta.action || null,
      checkout_id: checkoutId || null,
      charge_id: chargeId || null,
    });

    if (!logged) {
      logger.info('[PagBank] Duplicate Webhook — continuing idempotent processing');
    }

    if (checkoutId) {
      await pagbankRepository.updateCheckoutStatusById(checkoutId, status, p);
    }

    if (chargeId) {
      await pagbankRepository.upsertPaymentByChargeId({
        charge_id: chargeId,
        checkout_id: checkoutId || null,
        status,
        request_ref: referenceId || null,
        customer,
        raw: p,
      });
    }

    if (status === 'PAID') {
      const record = chargeId
        ? await pagbankRepository.findByChargeId(chargeId)
        : checkoutId
        ? await pagbankRepository.findByCheckoutId(checkoutId)
        : null;

      if (record) {
        const { request_id: requestId, product_type: productType } = record;
        events.emit('payment:paid', { requestId, productType, chargeId, checkoutId, raw: p });
      }
    }

    return { ok: true };
  } catch (err) {
    logger.error('Error processing PagBank webhook:', err);
    return { ok: false, error: 'internal_error' };
  }
}

module.exports = { createCheckout, processWebhook, events };
