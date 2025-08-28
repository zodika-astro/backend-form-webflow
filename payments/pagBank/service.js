// payments/pagBank/service.js

const httpClient = require('../../utils/httpClient');
const logger = require('../../utils/logger');
const crypto = require('crypto');
const EventEmitter = require('events');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const { env } = require('../../config/env');
const pagbankRepository = require('./repository');
const { mapWebhookPayload } = require('./mapPayload');

// Event emitter to decouple product delivery
// Ex.: in another module: pagbankService.events.on('payment:paid', ({ requestId, productType, ... }) => { ... })

const events = new EventEmitter();

async function createCheckout({
  requestId,
  name,
  email,
  productType,
  productValue,  
  productName,   
  paymentOptions,
  returnUrl,
  currency
}) {
  if (!requestId) throw new Error('requestId is required');

  const valueNum = Number(productValue);
  if (!Number.isFinite(valueNum) || valueNum <= 0) {
    throw new Error('invalid productValue (cents, integer > 0)');
  }

  const methods = [];
  if (paymentOptions?.allow_pix !== false) methods.push('PIX');
  if (paymentOptions?.allow_card !== false) methods.push('CREDIT_CARD');

  const redirectUrl = returnUrl;

  const payload = JSON.parse(JSON.stringify({
    reference_id: String(requestId),
    items: [{
      name: productName || productType || 'Produto',
      quantity: 1,
      unit_amount: valueNum
   
    }],
    checkout: {
      redirect_url: redirectUrl,
      payment_methods: methods.length ? methods : ['PIX', 'CREDIT_CARD'],
      max_installments: Number(paymentOptions?.max_installments) || 1,
    },
    notification_urls: [process.env.PAGBANK_WEBHOOK_URL],
    ...(name && email ? { customer: { name, email } } : {}),
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
        data.links.find(l => (l.rel || '').toUpperCase() === 'PAY')?.href ||
        data.links.find(l => (l.rel || '').toUpperCase() === 'CHECKOUT')?.href ||
        data.links.find(l => (l.rel || '').toUpperCase() === 'SELF')?.href;
    }
    if (!payLink && data?.payment_url) payLink = data.payment_url;
    if (!payLink && data?.checkout?.payment_url) payLink = data.checkout.payment_url;
    if (!payLink) throw new Error('PAY link not found in PagBank return');

    
    await pagbankRepository.createCheckout({
      request_id: String(requestId),
      product_type: productType,
      checkout_id: data?.id || null,
      status: 'ACTIVE',
      value: valueNum,
      link: payLink,
      customer: (name && email) ? { name, email } : null,
      raw: data,
    });

    return { url: payLink, checkoutId: data?.id || null };
  } catch (e) {
    if (e.response) {
      logger.error('[PagBank][ERR]', {
        status: e.response.status,
        url: e.config?.url,
        data: e.response.data,
        headers: e.response.headers,
      });
    } else {
      logger.error('[PagBank][ERR-NETWORK]', e.message);
    }
    throw e;
  }
}

async function processWebhook(p, meta = {}) {
  try {
    const {
      eventId, objectType, checkoutId, chargeId,
      referenceId, status, customer
    } = mapWebhookPayload(p);

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
        const {
          request_id: requestId,
          product_type: productType
        } = record;

        logger.info(`[PagBank] Payment confirmed — requestId=${requestId} productType=${productType}`);

        events.emit('payment:paid', {
          requestId,
          productType,
          chargeId,
          checkoutId,
          raw: p
        });
      } else {
        logger.warn('[PagBank] PAID with no resolved context (neither chargeId nor checkoutId matched). Check webhook data.');
      }
    }

    return { ok: true };
  } catch (err) {
    logger.error('Error processing PagBank webhook:', err);
    return { ok: false, error: 'internal_error' };
  }
}

module.exports = { createCheckout, processWebhook, events };
