// payments/payPal/repository.js
'use strict';

const crypto = require('crypto');
const db = require('../../db/db');

/**
 * Repository: PayPal
 * ------------------
 * Security & integrity:
 * - Não armazenar secrets/tokens/assinaturas (headers e JSON saneados).
 * - Manter campos canônicos em colunas; guardar JSON sanitizado em `raw`.
 * - Garantir idempotência por UNIQUE constraints no banco.
 *
 * Tabelas esperadas:
 *   - paypal_events(provider_event_uid) UNIQUE
 *   - paypal_payments(capture_id) UNIQUE, opcionalmente UNIQUE(order_id)
 *   - paypal_orders(order_id) UNIQUE
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
  'paypal-transmission-sig',
  'paypal-cert-url',
  'paypal-auth-algo',
]);

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

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
    user.length <= 2
      ? '*'.repeat(user.length)
      : user[0] + '*'.repeat(user.length - 2) + user[user.length - 1];
  const domainMasked = domain.replace(/^[^.]*/, (m) =>
    m.length <= 2
      ? '*'.repeat(m.length)
      : m[0] + '*'.repeat(m.length - 2) + m[m.length - 1]
  );
  return `${userMasked}@${domainMasked}`;
}

function maskDigits(value, visible = 2) {
  const s = String(value || '').replace(/\D+/g, '');
  if (!s) return '[REDACTED_DIGITS]';
  const keep = Math.min(visible, s.length);
  return '*'.repeat(s.length - keep) + s.slice(-keep);
}
function maskPhone(value) { return maskDigits(value, 4); }
function maskTaxId(value) { return maskDigits(value, 3); }

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
    out[k] =
      typeof masked === 'object' && masked !== null
        ? sanitizeJson(masked, depth + 1)
        : masked;
  }
  return out;
}

function sanitizeForStorage(obj) { return sanitizeJson(obj); }
function sanitizeQuery(obj) { return sanitizeJson(obj); }

const toNumberOrNull = (v) =>
  v == null || v === '' ? null : Number(v);

// ------------------------------- Hashing helpers (bytea) --------------------------------

function sha256Buffer(input) {
  return crypto.createHash('sha256').update(input).digest();
}

function hashEmail(email) {
  if (!email) return null;
  const normalized = String(email).trim().toLowerCase();
  if (!normalized) return null;
  return sha256Buffer(normalized);
}

function onlyDigits(s) {
  return String(s || '').replace(/\D+/g, '');
}
function hashTaxId(doc) {
  const digits = onlyDigits(doc);
  if (!digits) return null;
  return sha256Buffer(digits);
}

// ------------------------------- Date helpers --------------------------------

function toDateOrNull(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

// -------------------------------- Repository functions --------------------------------

/**
 * createOrder
 * -----------
 * Upsert do "created order" em paypal_orders (UNIQUE por order_id).
 * - Sobrescreve `raw` com o snapshot mais recente.
 */
async function createOrder({
  request_id,
  product_type,
  order_id,
  status,
  value_cents,
  customer,
  raw,
}) {
  const sql = `
    INSERT INTO paypal_orders (
      request_id,
      product_type,
      order_id,
      status,
      value_cents,
      customer,
      raw
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7
    )
    ON CONFLICT (order_id) DO UPDATE SET
      status      = EXCLUDED.status,
      value_cents = EXCLUDED.value_cents,
      customer    = COALESCE(EXCLUDED.customer, paypal_orders.customer),
      raw         = EXCLUDED.raw,
      updated_at  = NOW()
    RETURNING *;
  `;

  const safeCustomer = customer ? sanitizeForStorage(customer) : null;
  const safeRaw = raw ? sanitizeForStorage(raw) : null;

  const params = [
    request_id ?? null,
    product_type ?? null,
    order_id,
    status ?? null,
    toNumberOrNull(value_cents),
    safeCustomer,
    safeRaw,
  ];

  const { rows } = await db.query(sql, params);
  return rows[0];
}

/**
 * logEvent
 * --------
 * Append-only log de eventos do provider. Idempotente por UNIQUE(provider_event_uid).
 * Retorna linha inserida; null se duplicado.
 */
async function logEvent({
  event_uid,
  topic,
  action,
  order_id,
  capture_id,
  headers,
  query,
  payload,
}) {
  const sql = `
    INSERT INTO paypal_events (
      provider_event_uid,
      topic,
      action,
      order_id,
      capture_id,
      headers,
      query,
      raw_json
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
    order_id || null,
    capture_id || null,
    safeHeaders || null,
    safeQuery || null,
    safePayload || null,
  ];

  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

/**
 * upsertPaymentByOrderId
 * ----------------------
 * UPSERT em paypal_payments por UNIQUE(order_id).
 * - Mascara PII em colunas text.
 * - Guarda hashes SHA-256 em *_hash para futuras consultas sem PII.
 * - Sobrescreve `raw` com snapshot mais recente.
 */
async function upsertPaymentByOrderId({
  order_id,
  status,
  normalized_status,
  request_id,
  amount_cents,
  currency,
  raw,
}) {
  const safeRaw = raw ? sanitizeForStorage(raw) : null;

  const sql = `
    INSERT INTO paypal_payments (
      order_id,
      capture_id,
      status,
      normalized_status,
      request_id,
      amount_cents,
      currency,
      raw
    ) VALUES (
      $1,NULL,$2,$3,$4,$5,$6,$7
    )
    ON CONFLICT (order_id) DO UPDATE SET
      status           = EXCLUDED.status,
      normalized_status= EXCLUDED.normalized_status,
      request_id       = COALESCE(EXCLUDED.request_id, paypal_payments.request_id),
      amount_cents     = COALESCE(EXCLUDED.amount_cents, paypal_payments.amount_cents),
      currency         = COALESCE(EXCLUDED.currency, paypal_payments.currency),
      raw              = EXCLUDED.raw,
      updated_at       = NOW()
    RETURNING *;
  `;

  const params = [
    order_id,
    status ?? null,
    normalized_status ?? null,
    request_id ?? null,
    toNumberOrNull(amount_cents),
    currency ?? null,
    safeRaw,
  ];

  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

/**
 * upsertPaymentByCaptureId
 * ------------------------
 * UPSERT em paypal_payments por UNIQUE(capture_id).
 * - Caso já exista linha por `order_id`, o ON CONFLICT por capture_id
 *   passa a preencher ambos.
 */
async function upsertPaymentByCaptureId({
  capture_id,
  order_id,
  status,
  normalized_status,
  request_id,
  amount_cents,
  currency,
  raw,
}) {
  const safeRaw = raw ? sanitizeForStorage(raw) : null;

  const sql = `
    INSERT INTO paypal_payments (
      order_id,
      capture_id,
      status,
      normalized_status,
      request_id,
      amount_cents,
      currency,
      raw
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8
    )
    ON CONFLICT (capture_id) DO UPDATE SET
      status           = EXCLUDED.status,
      normalized_status= EXCLUDED.normalized_status,
      request_id       = COALESCE(EXCLUDED.request_id, paypal_payments.request_id),
      order_id         = COALESCE(EXCLUDED.order_id, paypal_payments.order_id),
      amount_cents     = COALESCE(EXCLUDED.amount_cents, paypal_payments.amount_cents),
      currency         = COALESCE(EXCLUDED.currency, paypal_payments.currency),
      raw              = EXCLUDED.raw,
      updated_at       = NOW()
    RETURNING *;
  `;

  const params = [
    order_id ?? null,
    capture_id,
    status ?? null,
    normalized_status ?? null,
    request_id ?? null,
    toNumberOrNull(amount_cents),
    currency ?? null,
    safeRaw,
  ];

  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

/**
 * upsertOrderFromWebhook
 * ----------------------
 * Atualiza/sincroniza paypal_orders a partir de webhooks de order.
 */
async function upsertOrderFromWebhook({
  order_id,
  status,
  normalized_status,
  request_id,
  raw,
}) {
  const safeRaw = raw ? sanitizeForStorage(raw) : null;

  const sql = `
    INSERT INTO paypal_orders (
      request_id,
      product_type,
      order_id,
      status,
      value_cents,
      normalized_status,
      raw
    ) VALUES (
      $1,NULL,$2,$3,NULL,$4,$5
    )
    ON CONFLICT (order_id) DO UPDATE SET
      status           = EXCLUDED.status,
      normalized_status= EXCLUDED.normalized_status,
      request_id       = COALESCE(EXCLUDED.request_id, paypal_orders.request_id),
      raw              = EXCLUDED.raw,
      updated_at       = NOW()
    RETURNING *;
  `;

  const params = [
    request_id ?? null,
    order_id,
    status ?? null,
    normalized_status ?? null,
    safeRaw,
  ];

  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

/**
 * updateRequestStatusByRequestId
 * ------------------------------
 * Atualiza o status da "ordem" atrelada à request no contexto PayPal.
 * (Histórico mais detalhado vive em paypal_events / paypal_payments).
 */
async function updateRequestStatusByRequestId(request_id, status, raw) {
  const safeRaw = raw ? sanitizeForStorage(raw) : null;

  const sql = `
    UPDATE paypal_orders
       SET status = $2,
           raw    = COALESCE($3, paypal_orders.raw),
           updated_at = NOW()
     WHERE request_id = $1
    RETURNING *;
  `;

  const { rows } = await db.query(sql, [request_id, status, safeRaw]);
  return rows[0] || null;
}

module.exports = {
  createOrder,
  logEvent,
  upsertPaymentByOrderId,
  upsertPaymentByCaptureId,
  upsertOrderFromWebhook,
  updateRequestStatusByRequestId,
};
