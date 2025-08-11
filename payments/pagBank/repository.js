// payments/pagbank/repository.js
const db = require('../../db/db');

/**
 * Cria/atualiza o registro de checkout (pagbank_request).
 * Use quando receber a resposta do POST /checkouts.
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
 * Atualiza status do checkout por checkout_id.
 * Use em webhooks de objeto "checkout".
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
 * Log imutável de eventos (pagbank_events).
 * Utilize um event_uid (hash ou id do provedor) para idempotência.
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
  // Quando houver conflito, RETURNING pode vir vazio — e está tudo bem.
  return rows[0] || null;
}

/**
 * Upsert do pagamento consolidado por charge_id (pagbank_payments).
 * Também consolida os dados de customer mais recentes.
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
 * Busca consolidação por charge_id (une com request para pegar product_type e request_id).
 */
async function findByChargeId(charge_id) {
  const sql = `
    SELECT p.*, r.request_id, r.product_type
      FROM pagbank_payments p
      LEFT JOIN pagbank_request r ON r.checkout_id = p.checkout_id
     WHERE p.charge_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [charge_id]);
  return rows[0];
}

/**
 * Busca registro de checkout (pagbank_request) por checkout_id.
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
 * (Opcional, legado do seu fluxo do produto) – mantém se você usa em outros pontos.
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
  // legado
  findBirthchartRequestById,
};
