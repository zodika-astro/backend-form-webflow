// payments/pagBank/mapPayload.js
const crypto = require('crypto');

/**
 * Gera um hash SHA256 do payload para ser usado como um ID único
 * de evento (event_uid) em casos onde o provedor não oferece um.
 * @param {object} obj - O objeto payload.
 * @returns {string} O hash SHA256 do payload.
 */
function hashPayload(obj) {
  const str = JSON.stringify(obj || {});
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Normaliza os dados do cliente de um objeto PagBank para um formato interno.
 * @param {object} customer - O objeto de cliente do PagBank.
 * @returns {object} O objeto de cliente normalizado.
 */
function normalizeCustomer(customer = {}) {
  const phone = Array.isArray(customer.phones) ? customer.phones[0] : undefined;
  const address = customer.address ? customer.address : undefined;
  return {
    name: customer.name || null,
    email: customer.email || null,
    tax_id: customer.tax_id || null,
    phone_country: phone?.country || null,
    phone_area: phone?.area || null,
    phone_number: phone?.number || null,
    address_json: address ? JSON.stringify(address) : null,
  };
}

/**
 * Mapeia e normaliza um payload de webhook do PagBank para um objeto interno padrão.
 * Isso centraliza a lógica de extração de dados e a torna idempotente.
 *
 * @param {object} pagbankPayload - O payload bruto recebido do PagBank.
 * @returns {object} O objeto de payload normalizado.
 */
function mapWebhookPayload(pagbankPayload) {
  // Identificação do objeto principal
  const isCheckoutObject = pagbankPayload?.object === 'checkout' || (!!pagbankPayload?.id && !!pagbankPayload?.status && pagbankPayload?.items);
  
  const checkoutId = isCheckoutObject ? pagbankPayload.id : pagbankPayload?.checkout?.id || null;
  const firstCharge = Array.isArray(pagbankPayload?.charges) ? pagbankPayload.charges[0] : undefined;
  const chargeId = firstCharge?.id || null;
  const status = firstCharge?.status || pagbankPayload?.status || 'UPDATED';

  // Consolida o reference_id com fallback
  const referenceId = pagbankPayload?.reference_id || pagbankPayload?.checkout?.reference_id || null;

  // Extrai o customer mais recente
  const customerData = normalizeCustomer(pagbankPayload.customer || pagbankPayload?.checkout?.customer || {});

  // Extrai o valor do pagamento
  const value = firstCharge?.amount?.value || 0;

  // Retorna o objeto de dados mapeado.
  return {
    eventId: pagbankPayload?.id ? `pg_${pagbankPayload.id}` : hashPayload(pagbankPayload),
    checkoutId,
    chargeId,
    referenceId,
    status,
    value,
    customer: customerData,
    rawPayload: pagbankPayload,
  };
}

module.exports = {
  mapWebhookPayload,
  normalizeCustomer,
};
