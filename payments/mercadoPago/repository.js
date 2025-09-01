// payments/mercadoPago/repository.js

const db = require('../../db/db');

/**
 * Creates/updates the checkout record (mp_request).
 * Equivalente ao pagbank_request.createCheckout
 */
async function createCheckout({
  request_id,
  product_type,
  preference_id,
  status,
  value,
  link,
  customer,
  raw,
}) {
  const sql = `
    INSERT INTO mp_request (request_id, product_type, preference_id, status, value, link, customer, raw)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (preference_id) DO UPDATE
      SET status     = EXCLUDED.status,
          link       = COALESCE(EXCLUDED.link, mp_request.link),
          customer   = COALESCE(EXCLUDED.customer, mp_request.customer),
          raw        = EXCLUDED.raw,
          updated_at = NOW()
    RETURNING *;
  `;
  const values = [
    request_id,
    product_type,
    preference_id,
    status,
    value,
    link || null,
    customer || null,
    raw || null,
  ];
  const { rows } = await db.query(sql, values);
  return rows[0];
}

/**
 * Update checkout status by preference_id (mp_request).
 * Equivalente ao updateCheckoutStatusById do PagBank
 */
async function updateRequestStatusByPreferenceId(preference_id, status, raw) {
  const sql = `
    UPDATE mp_request
       SET status = $2,
           raw    = $3,
           updated_at = NOW()
     WHERE preference_id = $1
    RETURNING *;
  `;
  const values = [preference_id, status, raw || null];
  const { rows } = await db.query(sql, values);
  return rows[0];
}

/**
 * Immutable event log (mp_events).
 * Equivalente ao pagbank_events.logEvent
 */
async function logEvent({
  event_uid,
  payload,
  headers = null,
  query = null,
  topic = null,
  action = null,
  preference_id = null,
  payment_id = null,
}) {
  const sql = `
    INSERT INTO mp_events (provider_event_uid, topic, action, preference_id, payment_id, headers, query, raw_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (provider_event_uid) DO NOTHING
    RETURNING *;
  `;
  const values = [
    event_uid,
    topic,
    action,
    preference_id,
    payment_id,
    headers,
    query,
    payload,
  ];
  const { rows } = await db.query(sql, values);
  return rows[0] || null; // null => duplicado (idempotência ok)
}

/**
 * Upsert of consolidated payment by payment_id (mp_payments).
 * Equivalente ao upsertPaymentByChargeId do PagBank
 */
async function upsertPaymentByPaymentId({
  payment_id,
  preference_id,
  status,
  status_detail,
  external_reference,
  customer,
  transaction_amount,
  raw,
}) {
  const sql = `
    INSERT INTO mp_payments
      (payment_id, preference_id, status, status_detail, external_reference,
       customer_name, customer_email, customer_tax_id,
       customer_phone_country, customer_phone_area, customer_phone_number,
       customer_address_json, transaction_amount, raw)
    VALUES
      ($1,$2,$3,$4,$5,
       $6,$7,$8,
       $9,$10,$11,
       $12,$13,$14)
    ON CONFLICT (payment_id) DO UPDATE
      SET status                 = EXCLUDED.status,
          status_detail          = EXCLUDED.status_detail,
          preference_id          = COALESCE(EXCLUDED.preference_id, mp_payments.preference_id),
          external_reference     = COALESCE(EXCLUDED.external_reference, mp_payments.external_reference),
          customer_name          = COALESCE(EXCLUDED.customer_name, mp_payments.customer_name),
          customer_email         = COALESCE(EXCLUDED.customer_email, mp_payments.customer_email),
          customer_tax_id        = COALESCE(EXCLUDED.customer_tax_id, mp_payments.customer_tax_id),
          customer_phone_country = COALESCE(EXCLUDED.customer_phone_country, mp_payments.customer_phone_country),
          customer_phone_area    = COALESCE(EXCLUDED.customer_phone_area, mp_payments.customer_phone_area),
          customer_phone_number  = COALESCE(EXCLUDED.customer_phone_number, mp_payments.customer_phone_number),
          customer_address_json  = COALESCE(EXCLUDED.customer_address_json, mp_payments.customer_address_json),
          transaction_amount     = COALESCE(EXCLUDED.transaction_amount, mp_payments.transaction_amount),
          raw                    = EXCLUDED.raw,
          updated_at             = NOW()
    RETURNING *;
  `;
  const values = [
    payment_id,
    preference_id || null,
    status || null,
    status_detail || null,
    external_reference || null,

    customer?.name || null,
    customer?.email || null,
    customer?.tax_id || null,

    customer?.phone_country || null,
    customer?.phone_area || null,
    customer?.phone_number || null,

    customer?.address_json || null,
    transaction_amount != null ? Number(transaction_amount) : null,
    raw || null,
  ];
  const { rows } = await db.query(sql, values);
  return rows[0];
}

/**
 * Busca consolidado por payment_id juntando request
 * (equivalente ao findByChargeId do PagBank, com os dois caminhos de join)
 * - join 1: mp_payments.preference_id -> mp_request.preference_id
 * - join 2: mp_payments.external_reference -> mp_request.request_id
 */
async function findByPaymentId(payment_id) {
  const sql = `
    SELECT p.*,
           COALESCE(r1.request_id, r2.request_id)   AS request_id,
           COALESCE(r1.product_type, r2.product_type) AS product_type
      FROM mp_payments p
      LEFT JOIN mp_request r1 ON r1.preference_id = p.preference_id
      LEFT JOIN mp_request r2 ON r2.request_id     = p.external_reference
     WHERE p.payment_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [payment_id]);
  return rows[0] || null;
}

/**
 * Busca mp_request por preference_id (usado pelo service ao atualizar status)
 */
async function findByPreferenceId(preference_id) {
  const sql = `
    SELECT *
      FROM mp_request
     WHERE preference_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [preference_id]);
  return rows[0] || null;
}

module.exports = {
  createCheckout,
  updateRequestStatusByPreferenceId,
  logEvent,
  upsertPaymentByPaymentId,
  findByPaymentId,
  findByPreferenceId,
};
