// payments/pagbank/repository.js
const db = require('../../db/db');

/**
 * Creates/updates the checkout record (pagbank_request).
 */
async function createCheckout({ request_id, product_type, checkout_id, status, value, link, customer, raw }) {
  const sql = `
    INSERT INTO pagbank_request (request_id, product_type, checkout_id, status, value, link, customer, raw)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (checkout_id) DO UPDATE
      SET status = EXCLUDED.status,
          link = COALESCE(EXCLUDED.link, pagbank_request.link),
          customer = COALESCE(EXCLUDED.customer, pagbank_request.customer),
          raw = EXCLUDED.raw,
          updated_at = NOW()
    RETURNING *;
  `;
  const values = [request_id, product_type, checkout_id, status, value, link || null, customer || null, raw || null];
  const { rows } = await db.query(sql, values);
  return rows[0];
}

/**
 * Update checkout status by checkout_id.
 */
async function updateCheckoutStatusById(checkout_id, status, raw) {
  const sql = `
    UPDATE pagbank_request
       SET status = $2,
           raw = $3,
           updated_at = NOW()
     WHERE checkout_id = $1
    RETURNING *;
  `;
  const values = [checkout_id, status, raw || null];
  const { rows } = await db.query(sql, values);
  return rows[0];
}

/**
  * Immutable event log (pagbank_events).
 */
async function logEvent({ event_uid, payload, headers = null, query = null, topic = null, action = null, checkout_id = null, charge_id = null }) {
  const sql = `
    INSERT INTO pagbank_events (provider_event_uid, topic, action, checkout_id, charge_id, headers, query, raw_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (provider_event_uid) DO NOTHING
    RETURNING *;
  `;
  const values = [event_uid, topic, action, checkout_id, charge_id, headers, query, payload];
  const { rows } = await db.query(sql, values);
  return rows[0] || null;
}

/**
 * Upsert of consolidated payment by charge_id (pagbank_payments).
 */
async function upsertPaymentByChargeId({ charge_id, checkout_id, status, request_ref, customer, raw }) {
  const sql = `
    INSERT INTO pagbank_payments
      (charge_id, checkout_id, status, request_ref,
       customer_name, customer_email, customer_tax_id,
       customer_phone_country, customer_phone_area, customer_phone_number,
       customer_address_json, raw)
    VALUES
      ($1,$2,$3,$4,
       $5,$6,$7,
       $8,$9,$10,
       $11,$12)
    ON CONFLICT (charge_id) DO UPDATE
      SET status = EXCLUDED.status,
          checkout_id = COALESCE(EXCLUDED.checkout_id, pagbank_payments.checkout_id),
          request_ref = COALESCE(EXCLUDED.request_ref, pagbank_payments.request_ref),
          customer_name = COALESCE(EXCLUDED.customer_name, pagbank_payments.customer_name),
          customer_email = COALESCE(EXCLUDED.customer_email, pagbank_payments.customer_email),
          customer_tax_id = COALESCE(EXCLUDED.customer_tax_id, pagbank_payments.customer_tax_id),
          customer_phone_country = COALESCE(EXCLUDED.customer_phone_country, pagbank_payments.customer_phone_country),
          customer_phone_area = COALESCE(EXCLUDED.customer_phone_area, pagbank_payments.customer_phone_area),
          customer_phone_number = COALESCE(EXCLUDED.customer_phone_number, pagbank_payments.customer_phone_number),
          customer_address_json = COALESCE(EXCLUDED.customer_address_json, pagbank_payments.customer_address_json),
          raw = EXCLUDED.raw,
          updated_at = NOW()
    RETURNING *;
  `;
  const values = [
    charge_id, checkout_id || null, status || null, request_ref || null,
    customer?.name || null, customer?.email || null, customer?.tax_id || null,
    customer?.phone_country || null, customer?.phone_area || null, customer?.phone_number || null,
    customer?.address_json || null, raw || null
  ];
  const { rows } = await db.query(sql, values);
  return rows[0];
}

/**
* Searches for consolidation by charge_id (joins with request to get product_type and request_id).
* More robust: tries to match by checkout_id OR by request_ref -> request_id.
*/
async function findByChargeId(charge_id) {
  const sql = `
    SELECT p.*,
           COALESCE(r1.request_id, r2.request_id) AS request_id,
           COALESCE(r1.product_type, r2.product_type) AS product_type
      FROM pagbank_payments p
      LEFT JOIN pagbank_request r1 ON r1.checkout_id = p.checkout_id
      LEFT JOIN pagbank_request r2 ON r2.request_id = p.request_ref
     WHERE p.charge_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [charge_id]);
  return rows[0];
}

/**
 * Search checkout record (pagbank_request) by checkout_id.
 */
async function findByCheckoutId(checkout_id) {
  const sql = `
    SELECT *
      FROM pagbank_request
     WHERE checkout_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [checkout_id]);
  return rows[0];
}

/**
 * Legacy (if used on return).
 */
async function findBirthchartRequestById(requestId) {
  const sql = 'SELECT * FROM birthchart_requests WHERE request_id = $1';
  const { rows } = await db.query(sql, [requestId]);
  return rows[0];
}

module.exports = {
  createCheckout,
  updateCheckoutStatusById,
  logEvent,
  upsertPaymentByChargeId,
  findByChargeId,
  findByCheckoutId,

  findBirthchartRequestById,
};
