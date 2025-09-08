// payments/pagBank/repository.js
'use strict';

const db = require('../../db/db');

/**
 * Repository: PagBank
 * -------------------
 * Security & integrity principles:
 * - Never persist secrets/tokens/signatures in DB (redact headers & JSON).
 * - Keep canonical business fields in typed columns; store provider "raw" JSON sanitized.
 * - Enforce idempotency at the DB layer:
 *     * pagbank_events(provider_event_uid)  => UNIQUE (append-only; ignore duplicates)
 *     * pagbank_payments(charge_id)         => UNIQUE (UPSERT)
 *     * pagbank_request(checkout_id)        => UNIQUE (UPSERT)
 *
 * NOTE: The SQL assumes proper UNIQUE constraints exist. If they don’t,
 *       please add them in migrations to guarantee idempotency.
 */

// --------------------------------- Sanitization helpers ---------------------------------

// Case-insensitive header names that must be redacted
const SENSITIVE_HEADER_SET = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-access-token',
  'x-client-secret',
  'x-signature', // HMAC/signature headers should not be fully stored
]);

/** Redact sensitive HTTP headers. Keeps non-sensitive headers as-is. */
function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase();
    out[k] = SENSITIVE_HEADER_SET.has(key)
      ? '[REDACTED]'
      : typeof v === 'string'
      ? v
      : safeJsonStringify(v);
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
  const d = domain.replace(/^[^.]*/, (m) =>
    m.length <= 2 ? '*'.repeat(m.length) : m[0] + '*'.repeat(m.length - 2) + m[m.length - 1]
  );
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

  if (SENSITIVE_JSON_KEYS.includes(k)) return '[REDACTED]';

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

  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeJson(v, depth + 1));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const masked = maskValueByKey(k, v);
    out[k] = typeof masked === 'object' && masked !== null ? sanitizeJson(masked, depth + 1) : masked;
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

const toNumberOrNull = (v) => (v == null || v === '' ? null : Number(v));

// ------------------------------------- Repository API -------------------------------------

/**
 * createCheckout
 * --------------
 * Upsert the checkout record in pagbank_request. Idempotent by UNIQUE(checkout_id).
 * Sanitizes "customer" and "raw" to avoid persisting secrets/PII in arbitrary JSON.
 */
async function createCheckout({
  request_id,
  product_type,
  checkout_id,
  status,
  value,
  link,
  customer,
  raw,
}) {
  const sql = `
    INSERT INTO pagbank_request (
      request_id, product_type, checkout_id, status, value, link, customer, raw
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8
    )
    ON CONFLICT (checkout_id) DO UPDATE SET
      status     = EXCLUDED.status,
      link       = COALESCE(EXCLUDED.link, pagbank_request.link),
      customer   = COALESCE(EXCLUDED.customer, pagbank_request.customer),
      raw        = EXCLUDED.raw,
      updated_at = NOW()
    RETURNING *;
  `;

  const safeCustomer = customer ? sanitizeForStorage(customer) : null;
  const safeRaw = raw ? sanitizeForStorage(raw) : null;

  const values = [
    request_id ?? null,
    product_type ?? null,
    checkout_id,
    status ?? null,
    toNumberOrNull(value),
    link ?? null,
    safeCustomer,
    safeRaw,
  ];
  const { rows } = await db.query(sql, values);
  return rows[0];
}

/**
 * updateCheckoutStatusById
 * ------------------------
 * Update checkout status by checkout_id. Idempotent per row.
 * Uses COALESCE to avoid wiping existing raw when a null is passed.
 */
async function updateCheckoutStatusById(checkout_id, status, raw) {
  const sql = `
    UPDATE pagbank_request
       SET status = $2,
           raw    = COALESCE($3, pagbank_request.raw),
           updated_at = NOW()
     WHERE checkout_id = $1
    RETURNING *;
  `;

  const safeRaw = raw ? sanitizeForStorage(raw) : null;

  const values = [checkout_id, status, safeRaw];
  const { rows } = await db.query(sql, values);
  return rows[0] || null;
}

/**
 * logEvent
 * --------
 * Immutable event log (pagbank_events). Idempotent by UNIQUE(provider_event_uid).
 * Returns the inserted row; returns null if it was a duplicate (DO NOTHING).
 */
async function logEvent({
  event_uid,
  payload,
  headers = null,
  query = null,
  topic = null,
  action = null,
  checkout_id = null,
  charge_id = null,
}) {
  const sql = `
    INSERT INTO pagbank_events (
      provider_event_uid, topic, action, checkout_id, charge_id, headers, query, raw_json
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8
    )
    ON CONFLICT (provider_event_uid) DO NOTHING
    RETURNING *;
  `;

  const safeHeaders = sanitizeHeaders(headers);
  const safeQuery = sanitizeQuery(query);
  const safePayload = sanitizeForStorage(payload);

  const values = [
    event_uid,
    topic || null,
    action || null,
    checkout_id || null,
    charge_id || null,
    safeHeaders || null,
    safeQuery || null,
    safePayload || null,
  ];
  const { rows } = await db.query(sql, values);
  return rows[0] || null; // null => duplicate
}

/**
 * upsertPaymentByChargeId
 * -----------------------
 * Idempotent UPSERT by UNIQUE(charge_id).
 * Sanitizes address JSON and raw snapshot before persistence.
 */
async function upsertPaymentByChargeId({
  charge_id,
  checkout_id,
  status,
  request_ref,
  customer,
  raw,
}) {
  const sql = `
    INSERT INTO pagbank_payments (
      charge_id, checkout_id, status, request_ref,
      customer_name, customer_email, customer_tax_id,
      customer_phone_country, customer_phone_area, customer_phone_number,
      customer_address_json, raw
    ) VALUES (
      $1,$2,$3,$4,
      $5,$6,$7,
      $8,$9,$10,
      $11,$12
    )
    ON CONFLICT (charge_id) DO UPDATE SET
      status                 = EXCLUDED.status,
      checkout_id            = COALESCE(EXCLUDED.checkout_id, pagbank_payments.checkout_id),
      request_ref            = COALESCE(EXCLUDED.request_ref, pagbank_payments.request_ref),
      customer_name          = COALESCE(EXCLUDED.customer_name, pagbank_payments.customer_name),
      customer_email         = COALESCE(EXCLUDED.customer_email, pagbank_payments.customer_email),
      customer_tax_id        = COALESCE(EXCLUDED.customer_tax_id, pagbank_payments.customer_tax_id),
      customer_phone_country = COALESCE(EXCLUDED.customer_phone_country, pagbank_payments.customer_phone_country),
      customer_phone_area    = COALESCE(EXCLUDED.customer_phone_area, pagbank_payments.customer_phone_area),
      customer_phone_number  = COALESCE(EXCLUDED.customer_phone_number, pagbank_payments.customer_phone_number),
      customer_address_json  = COALESCE(EXCLUDED.customer_address_json, pagbank_payments.customer_address_json),
      raw                    = EXCLUDED.raw,
      updated_at             = NOW()
    RETURNING *;
  `;

  // Keep canonical columns explicit; sanitize only the arbitrary JSON fields
  const safeAddress = customer?.address_json ? sanitizeForStorage(customer.address_json) : null;
  const safeRaw = raw ? sanitizeForStorage(raw) : null;

  const values = [
    charge_id,
    checkout_id ?? null,
    status ?? null,
    request_ref ?? null,

    customer?.name ?? null,
    customer?.email ?? null,
    customer?.tax_id ?? null,

    customer?.phone_country ?? null,
    customer?.phone_area ?? null,
    customer?.phone_number ?? null,

    safeAddress,
    safeRaw,
  ];
  const { rows } = await db.query(sql, values);
  return rows[0];
}

/**
 * findByChargeId
 * --------------
 * Fetch a consolidated payment by charge_id and join related request data.
 * - Primary join by checkout_id (preferred).
 * - Secondary join by request_ref -> request_id.
 *   To avoid type mismatches between TEXT and INT, cast request_id to TEXT on join.
 */
async function findByChargeId(charge_id) {
  const sql = `
    SELECT p.*,
           COALESCE(r1.request_id, r2.request_id)     AS request_id,
           COALESCE(r1.product_type, r2.product_type) AS product_type
      FROM pagbank_payments p
      LEFT JOIN pagbank_request r1
        ON r1.checkout_id = p.checkout_id
      LEFT JOIN pagbank_request r2
        ON r2.request_id::text = p.request_ref
     WHERE p.charge_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [charge_id]);
  return rows[0] || null;
}

/**
 * findByCheckoutId
 * ----------------
 * Fetch checkout record by checkout_id.
 */
async function findByCheckoutId(checkout_id) {
  const sql = `
    SELECT *
      FROM pagbank_request
     WHERE checkout_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [checkout_id]);
  return rows[0] || null;
}

/**
 * findBirthchartRequestById (legacy)
 * ----------------------------------
 * Used in return flows, if applicable.
 */
async function findBirthchartRequestById(requestId) {
  const sql = `
    SELECT *
      FROM birthchart_requests
     WHERE request_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [requestId]);
  return rows[0] || null;
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
