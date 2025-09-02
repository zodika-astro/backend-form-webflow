// payments/mercadoPago/repository.js
'use strict';

const db = require('../../db/db');

/**
 * Security-first sanitization helpers
 * ----------------------------------
 * We must never persist sensitive data (secrets, tokens, auth headers, full cookies)
 * into event/failure tables or "raw" JSON columns. The functions below:
 *  - redact sensitive HTTP headers (Authorization, Cookie, Set-Cookie, API keys, signatures)
 *  - scrub sensitive keys inside arbitrary JSON payloads (tokens, secrets, card data, passwords)
 *  - lightly mask common PII fields (email, tax_id/CPF/CNPJ, phone), keeping enough signal for debugging
 *
 * Notes:
 * - Keep canonical business fields (e.g., customer name/email on mp_payments) in their dedicated columns.
 *   The "raw" columns and event tables are NOT a place to store full PII or secrets.
 * - These utilities avoid mutating the original objects by cloning during traversal.
 */

// Case-insensitive header names that must be redacted
const SENSITIVE_HEADER_SET = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-access-token',
  'x-client-secret',
  'x-signature', // HMAC/signature headers should not be stored in full
]);

/** Redact sensitive HTTP headers. Keeps non-sensitive headers as-is. */
function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase();
    if (SENSITIVE_HEADER_SET.has(key)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = typeof v === 'string' ? v : safeJsonStringify(v);
    }
  }
  return out;
}

// Keys inside JSON payloads that should be fully redacted (case-insensitive match)
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

// Keys that carry PII we want to softly mask
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

/** Mask helpers for PII (keep minimal debugging signal) */
function maskEmail(value) {
  const s = String(value || '');
  const [user, domain] = s.split('@');
  if (!domain) return '[REDACTED_EMAIL]';
  const u = user.length <= 2 ? '*'.repeat(user.length) : user[0] + '*'.repeat(user.length - 2) + user[user.length - 1];
  const d = domain.replace(/^[^.]*/, m => (m.length <= 2 ? '*'.repeat(m.length) : m[0] + '*'.repeat(m.length - 2) + m[m.length - 1]));
  return `${u}@${d}`;
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
  // CPF/CNPJ: keep last 3 digits
  return maskDigits(value, 3);
}

// Decide how to mask a value based on the key semantics
function maskValueByKey(key, value) {
  const k = String(key).toLowerCase();

  if (SENSITIVE_JSON_KEYS.includes(k)) {
    return '[REDACTED]';
  }

  if (PII_KEYS.includes(k)) {
    if (k.includes('email') || k === 'mail' || k === 'e-mail') return maskEmail(value);
    if (k.includes('phone') || k === 'mobile' || k === 'whatsapp') return maskPhone(value);
    if (k === 'tax_id' || k === 'document' || k === 'cpf' || k === 'cnpj') return maskTaxId(value);
    return '[REDACTED_PII]';
  }

  return value;
}

/**
 * Recursively sanitize an arbitrary JSON-like structure.
 * - Redacts sensitive keys entirely
 * - Masks PII fields
 * - Limits depth to avoid pathological objects
 */
function sanitizeJson(value, depth = 0) {
  if (value == null) return value;
  if (depth > 8) return '[TRUNCATED_DEPTH]';

  // Primitives
  if (typeof value !== 'object') return value;

  // Arrays
  if (Array.isArray(value)) {
    return value.map(v => sanitizeJson(v, depth + 1));
  }

  // Plain objects
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const masked = maskValueByKey(k, v);
    out[k] = typeof masked === 'object' && masked !== null
      ? sanitizeJson(masked, depth + 1)
      : masked;
  }
  return out;
}

/** Safe stringify for diagnostic storage (never throws) */
function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

/** Public sanitizers used by the repository functions */
function sanitizeForStorage(obj) {
  return sanitizeJson(obj);
}
function sanitizeQuery(obj) {
  return sanitizeJson(obj);
}

/* ------------------------------------------------------------------------------------------------
 * Repository functions (Mercado Pago)
 * All raw/header/payload fields pass through sanitization BEFORE persistence.
 * ------------------------------------------------------------------------------------------------ */

/**
 * mp_request: create/update the created preference record
 * Expected fields:
 *  - request_id (string/int as text), product_type, preference_id, status, value (in cents),
 *    link, customer (json), raw (json)
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
    INSERT INTO mp_request (
      request_id, product_type, preference_id, status, value, link, customer, raw
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8
    )
    ON CONFLICT (preference_id) DO UPDATE SET
      status      = EXCLUDED.status,
      value       = EXCLUDED.value,
      link        = EXCLUDED.link,
      customer    = COALESCE(EXCLUDED.customer, mp_request.customer),
      raw         = EXCLUDED.raw,
      updated_at  = NOW()
    RETURNING *;
  `;

  // Only sanitize structures that might contain secrets/PII beyond canonical columns
  const safeCustomer = customer ? sanitizeForStorage(customer) : null;
  const safeRaw = raw ? sanitizeForStorage(raw) : null;

  const params = [
    request_id,
    product_type,
    preference_id,
    status,
    value,
    link,
    safeCustomer,
    safeRaw,
  ];
  const { rows } = await db.query(sql, params);
  return rows[0];
}

/**
 * mp_events: append-only record of received events
 * If provider_event_uid already exists, ignore (idempotent)
 */
async function logEvent({
  event_uid,
  topic,
  action,
  preference_id,
  payment_id,
  headers,
  query,
  payload,
}) {
  const sql = `
    INSERT INTO mp_events (
      provider_event_uid, topic, action, preference_id, payment_id, headers, query, raw_json
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8
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
    safeHeaders || null,
    safeQuery || null,
    safePayload || null,
  ];
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

/**
 * Update request status by preference_id
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
 * Update request status by request_id (external_reference)
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
  const { rows } = await db.query(sql, [String(request_id), status, safeRaw]);
  return rows[0] || null;
}

/**
 * mp_payments: upsert by payment_id
 * IMPORTANT: keep the exact order of the 17 parameters as in the INSERT
 */
async function upsertPaymentByPaymentId({
  payment_id,
  preference_id,
  status,
  status_detail,
  external_reference,
  customer = {},
  transaction_amount,
  date_created,       // string ISO or Date
  date_approved,      // string ISO or Date
  date_last_updated,  // string ISO or Date
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

  // Keep canonical columns explicit; sanitize only the "raw" and nested address JSON
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
    transaction_amount != null ? Number(transaction_amount) : null,

    date_created ?? null,
    date_approved ?? null,
    date_last_updated ?? null,

    safeRaw,
  ];

  const { rows } = await db.query(sql, values);
  return rows[0];
}

/**
 * Find payment (with request_id/product_type) by payment_id
 */
async function findByPaymentId(payment_id) {
  const sql = `
    SELECT p.*,
           COALESCE(r1.request_id, r2.request_id)     AS request_id,
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
 * Find request by preference_id
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
 * Find request by request_id (external_reference)
 */
async function findByRequestId(request_id) {
  const sql = `
    SELECT *
      FROM mp_request
     WHERE request_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [String(request_id)]);
  return rows[0] || null;
}

/**
 * Attach payment to a preference (when webhook arrives without preferId and we discover later)
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
  updateRequestStatusByRequestId,

  // payments
  upsertPaymentByPaymentId,
  findByPaymentId,
  findByPreferenceId,
  findByRequestId,
  attachPaymentToPreference,
};
