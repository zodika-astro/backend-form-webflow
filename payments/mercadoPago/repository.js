// payments/mercadoPago/repository.js
'use strict';

const db = require('../../db/db');

/**
 * Repository: Mercado Pago
 * ------------------------
 * Security & integrity principles:
 * - Never persist secrets/tokens/signatures in DB (redact headers & JSON).
 * - Keep canonical business fields in typed columns; store provider "raw" JSON sanitized.
 * - Enforce idempotency at the DB layer:
 *     * mp_events(provider_event_uid)        => UNIQUE (append-only; ignore duplicates)
 *     * mp_payments(payment_id)              => UNIQUE (UPSERT)
 *     * mp_request(preference_id)            => UNIQUE (UPSERT)
 *
 * NOTE: The SQL here assumes proper UNIQUE constraints exist. If they don’t,
 *       please add them in migrations to guarantee idempotency.
 */

// ------------------------------- Sanitization helpers --------------------------------

const SENSITIVE_HEADER_SET = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-access-token',
  'x-client-secret',
  'x-signature',
]);

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const keyLower = String(k).toLowerCase();
    out[k] = SENSITIVE_HEADER_SET.has(keyLower)
      ? '[REDACTED]'
      : typeof v === 'string'
      ? v
      : safeJsonStringify(v);
  }
  return out;
}

const SENSITIVE_JSON_KEYS = [
  'authorization',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'secret',
  'client_secret',
  'api_key',
  'apikey',
  'password',
  'pwd',
  'signature',
  'hmac',
  'security_code',
  'cvv',
  'cvc',
  'card_number',
  'pan',
  'card',
];

const PII_KEYS = [
  'email',
  'e-mail',
  'mail',
  'tax_id',
  'document',
  'cpf',
  'cnpj',
  'phone',
  'phone_number',
  'mobile',
  'whatsapp',
];

function maskEmail(value) {
  const s = String(value || '');
  const [user, domain] = s.split('@');
  if (!domain) return '[REDACTED_EMAIL]';
  const userMasked =
    user.length <= 2 ? '*'.repeat(user.length) : user[0] + '*'.repeat(user.length - 2) + user[user.length - 1];
  const domainMasked = domain.replace(/^[^.]*/, (m) =>
    m.length <= 2 ? '*'.repeat(m.length) : m[0] + '*'.repeat(m.length - 2) + m[m.length - 1]
  );
  return `${userMasked}@${domainMasked}`;
}

function maskDigits(value, visible = 2) {
  const s = String(value || '').replace(/\D+/g, '');
  if (!s) return '[REDACTED_DIGITS]';
  const keep = Math.min(visible, s.length);
  return '*'.repeat(s.length - keep) + s.slice(-keep);
}

function maskPhone(value) {
  return maskDigits(value, 4);
}
function maskTaxId(value) {
  return maskDigits(value, 3);
}

function maskValueByKey(key, value) {
  const k = String(key).toLowerCase();
  if (SENSITIVE_JSON_KEYS.includes(k)) return '[REDACTED]';
  if (PII_KEYS.includes(k)) {
    if (k.includes('email') || k === 'mail' || k === 'e-mail') return maskEmail(value);
    if (k.includes('phone') || k === 'mobile' || k === 'whatsapp') return maskPhone(value);
    if (k === 'tax_id' || k === 'document' || k === 'cpf' || k === 'cnpj') return maskTaxId(value);
    return '[REDACTED_PII]';
  }
  return value;
}

function sanitizeJson(value, depth = 0) {
  if (value == null) return value;
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeJson(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const masked = maskValueByKey(k, v);
    out[k] = typeof masked === 'object' && masked !== null ? sanitizeJson(masked, depth + 1) : masked;
  }
  return out;
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function sanitizeForStorage(obj) {
  return sanitizeJson(obj);
}
function sanitizeQuery(obj) {
  return sanitizeJson(obj);
}

const toNumberOrNull = (v) => (v == null || v === '' ? null : Number(v));

// -------------------------------- Repository functions --------------------------------

/**
 * createCheckout
 * --------------
 * Upsert the "created preference" record in mp_request.
 * Idempotent by UNIQUE(preference_id).
 *
 * Expected fields:
 *  - request_id (int FK to your application request)
 *  - external_reference (TEXT from MP; do not coerce to int)
 *  - product_type, preference_id, status, value (cents), link, customer (json), raw (json)
 */
async function createCheckout({
  request_id,
  external_reference,
  product_type,
  preference_id,
  status,
  value,
  link,
  customer,
  raw,
}) {
  const sql = `
    INSERT INTO mp_request (
      request_id, external_reference, product_type, preference_id, status, value, link, customer, raw
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9
    )
    ON CONFLICT (preference_id) DO UPDATE SET
      status             = EXCLUDED.status,
      value              = EXCLUDED.value,
      link               = EXCLUDED.link,
      external_reference = COALESCE(EXCLUDED.external_reference, mp_request.external_reference),
      customer           = COALESCE(EXCLUDED.customer, mp_request.customer),
      raw                = EXCLUDED.raw,
      updated_at         = NOW()
    RETURNING *;
  `;

  const safeCustomer = customer ? sanitizeForStorage(customer) : null;
  const safeRaw = raw ? sanitizeForStorage(raw) : null;

  const params = [
    request_id ?? null,
    external_reference ?? null,
    product_type ?? null,
    preference_id,
    status ?? null,
    toNumberOrNull(value),
    link ?? null,
    safeCustomer,
    safeRaw,
  ];

  const { rows } = await db.query(sql, params);
  return rows[0];
}

/**
 * logEvent
 * --------
 * Append-only log of provider events. Idempotent by UNIQUE(provider_event_uid).
 * Returns the inserted row; returns null if it was a duplicate (DO NOTHING).
 */
async function logEvent({ event_uid, topic, action, preference_id, payment_id, headers, query, payload }) {
  const sql = `
    INSERT INTO mp_events (
      provider_event_uid, topic, action, preference_id, payment_id, merchant_order_id, headers, query, raw_json
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9
    )
    ON CONFLICT (provider_event_uid) DO NOTHING
    RETURNING *;
  `;

  const safeHeaders = sanitizeHeaders(headers);
  const safeQuery = sanitizeQuery(query);
  const safePayload = sanitizeForStorage(payload);

  const params = [
    event_uid,
    topic || null,
    action || null,
    preference_id || null,
    payment_id || null,
    null, // merchant_order_id is unused for payment webhooks; keep for schema compatibility
    safeHeaders || null,
    safeQuery || null,
    safePayload || null,
  ];

  const { rows } = await db.query(sql, params);
  return rows[0] || null; // null => duplicate
}

/**
 * updateRequestStatusByPreferenceId
 * ---------------------------------
 * Update mp_request by preference_id (idempotent per row).
 */
async function updateRequestStatusByPreferenceId(preference_id, status, raw) {
  const sql = `
    UPDATE mp_request
       SET status = $2,
           raw = COALESCE($3, mp_request.raw),
           updated_at = NOW()
     WHERE preference_id = $1
    RETURNING *;
  `;
  const safeRaw = raw ? sanitizeForStorage(raw) : null;
  const { rows } = await db.query(sql, [preference_id, status, safeRaw]);
  return rows[0] || null;
}

/**
 * updateRequestStatusByRequestId (legacy/internal)
 * -----------------------------------------------
 * Update mp_request by INTERNAL request_id (int FK).
 * Prefer using updateRequestStatusByExternalReference for MP-facing flows.
 */
async function updateRequestStatusByRequestId(request_id, status, raw) {
  const sql = `
    UPDATE mp_request
       SET status = $2,
           raw = COALESCE($3, mp_request.raw),
           updated_at = NOW()
     WHERE request_id = $1
    RETURNING *;
  `;
  const safeRaw = raw ? sanitizeForStorage(raw) : null;
  const { rows } = await db.query(sql, [request_id, status, safeRaw]);
  return rows[0] || null;
}

/**
 * updateRequestStatusByExternalReference (preferred)
 * -------------------------------------------------
 * Update mp_request by EXTERNAL reference (TEXT from MP).
 */
async function updateRequestStatusByExternalReference(external_reference, status, raw) {
  const sql = `
    UPDATE mp_request
       SET status = $2,
           raw = COALESCE($3, mp_request.raw),
           updated_at = NOW()
     WHERE external_reference = $1
    RETURNING *;
  `;
  const safeRaw = raw ? sanitizeForStorage(raw) : null;
  const { rows } = await db.query(sql, [external_reference, status, safeRaw]);
  return rows[0] || null;
}

/**
 * upsertPaymentByPaymentId
 * ------------------------
 * Idempotent UPSERT by UNIQUE(payment_id).
 * IMPORTANT: keep parameter order aligned with the INSERT.
 */
async function upsertPaymentByPaymentId({
  payment_id,
  preference_id,
  status,
  status_detail,
  external_reference,
  customer = {},
  transaction_amount,
  date_created,      // ISO string or Date
  date_approved,     // ISO string or Date
  date_last_updated, // ISO string or Date
  raw,
}) {
  const sql = `
    INSERT INTO mp_payments (
      payment_id, preference_id, status, status_detail, external_reference,
      customer_name, customer_email, customer_tax_id,
      customer_phone_country, customer_phone_area, customer_phone_number,
      customer_address_json, transaction_amount,
      date_created, date_approved, date_last_updated, raw
    ) VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,
      $9,$10,$11,
      $12,$13,
      $14,$15,$16,$17
    )
    ON CONFLICT (payment_id) DO UPDATE SET
      status                 = EXCLUDED.status,
      status_detail          = EXCLUDED.status_detail,
      date_created           = COALESCE(EXCLUDED.date_created, mp_payments.date_created),
      date_approved          = COALESCE(EXCLUDED.date_approved, mp_payments.date_approved),
      date_last_updated      = COALESCE(EXCLUDED.date_last_updated, mp_payments.date_last_updated),
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

  const safeAddress = customer?.address_json ? sanitizeForStorage(customer.address_json) : null;
  const safeRaw = raw ? sanitizeForStorage(raw) : null;

  const values = [
    payment_id,
    preference_id ?? null,
    status ?? null,
    status_detail ?? null,
    external_reference ?? null,

    customer?.name ?? null,
    customer?.email ?? null,
    customer?.tax_id ?? null,

    customer?.phone_country ?? null,
    customer?.phone_area ?? null,
    customer?.phone_number ?? null,

    safeAddress,
    toNumberOrNull(transaction_amount),

    date_created ?? null,
    date_approved ?? null,
    date_last_updated ?? null,

    safeRaw,
  ];

  const { rows } = await db.query(sql, values);
  return rows[0];
}

/**
 * findByPaymentId
 * ---------------
 * Fetch a payment and join the related request (by preference_id or external_reference).
 * Uses external_reference join to avoid int/text casts and to match MP semantics.
 */
async function findByPaymentId(payment_id) {
  const sql = `
    SELECT p.*,
           COALESCE(r1.request_id, r2.request_id)     AS request_id,
           COALESCE(r1.product_type, r2.product_type) AS product_type
      FROM mp_payments p
      LEFT JOIN mp_request r1 ON r1.preference_id = p.preference_id
      LEFT JOIN mp_request r2 ON r2.external_reference = p.external_reference
     WHERE p.payment_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [payment_id]);
  return rows[0] || null;
}

/**
 * findByPreferenceId
 * ------------------
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

/**
 * findByRequestId (internal FK)
 * -----------------------------
 */
async function findByRequestId(request_id) {
  const sql = `
    SELECT *
      FROM mp_request
     WHERE request_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [request_id]);
  return rows[0] || null;
}

/**
 * findByExternalReference (TEXT from MP)
 * --------------------------------------
 */
async function findByExternalReference(external_reference) {
  const sql = `
    SELECT *
      FROM mp_request
     WHERE external_reference = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [external_reference]);
  return rows[0] || null;
}

/**
 * attachPaymentToPreference
 * -------------------------
 * Attach a payment to a preference after-the-fact (when discovered later).
 */
async function attachPaymentToPreference(payment_id, preference_id) {
  const sql = `
    UPDATE mp_payments
       SET preference_id = $2,
           updated_at = NOW()
     WHERE payment_id = $1
    RETURNING *;
  `;
  const { rows } = await db.query(sql, [payment_id, preference_id]);
  return rows[0] || null;
}

module.exports = {
  // requests / events
  createCheckout,
  logEvent,
  updateRequestStatusByPreferenceId,
  updateRequestStatusByRequestId,          // legacy/internal
  updateRequestStatusByExternalReference,  // preferred for MP
  findByExternalReference,

  // payments
  upsertPaymentByPaymentId,
  findByPaymentId,
  findByPreferenceId,
  findByRequestId,
  attachPaymentToPreference,
};
