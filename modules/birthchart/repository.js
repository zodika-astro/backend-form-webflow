// modules/birthchart/repository.js
'use strict';

/**
 * Birthchart Repository
 * ---------------------
 * Database access layer for the Birthchart request flow.
 *
 * Responsibilities
 *  - Persist validated requests into `public.zodika_requests`.
 *  - Fetch requests by id.
 *
 * Notes
 *  - Inputs are expected to be validated at the controller level (Zod).
 *  - Never log PII in this layer.
 *  - Use parameterized SQL only (no string interpolation).
 */

const db = require('../../db/db');

/* --------------------------------- Helpers --------------------------------- */

/** Trim to `max` length; return null for undefined/empty. */
function toTrimmedOrNull(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return typeof max === 'number' ? s.slice(0, max) : s;
}

/** Lowercase email defensively (validators already do this). */
function toEmail(v) {
  const s = toTrimmedOrNull(v, 254);
  return s ? s.toLowerCase() : null;
}

/** Coerce to finite number or null. */
function toNumberOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Safe JSON acceptor:
 *  - object → returned as-is (size-checked)
 *  - string → parsed (size-checked)
 *  - invalid/too large → null
 */
function toJsonOrNull(v, maxBytes = 10_000) {
  if (v == null) return null;

  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      if (s.length > maxBytes) return null;
      return v;
    } catch {
      return null;
    }
  }

  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    try {
      const parsed = JSON.parse(t);
      const s = JSON.stringify(parsed);
      if (s.length > maxBytes) return null;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  return null;
}

/* ------------------------------- Repository -------------------------------- */

/**
 * Insert a new birthchart request and return the created row (includes `request_id`).
 *
 * @param {Object} data - normalized, validated payload (snake_case)
 * @returns {Promise<Object>} inserted row
 *
 * Required fields (by schema):
 *  - name, email, birth_date, birth_time, birth_place, product_type
 *  - birth_place_place_id, birth_place_full, birth_place_country, birth_place_admin1
 *  - birth_place_lat, birth_place_lng, birth_place_json
 *  - birth_timezone_id, birth_utc_offset_min
 *
 * Optional:
 *  - social_name, birth_place_admin2
 */
async function createBirthchartRequest(data) {
  const {
    name, social_name, email, birth_date, birth_time, birth_place, product_type,
    birth_place_place_id, birth_place_full, birth_place_country, birth_place_admin1,
    birth_place_admin2, birth_place_lat, birth_place_lng, birth_place_json,
    birth_timezone_id, birth_utc_offset_min,
  } = data;

  // Defensive normalization (consistent with validator limits)
  const v_name             = toTrimmedOrNull(name, 120);
  const v_social_name      = toTrimmedOrNull(social_name, 60);
  const v_email            = toEmail(email); // <= 254 chars
  const v_birth_place      = toTrimmedOrNull(birth_place, 120);
  const v_product_type     = toTrimmedOrNull(product_type, 64); // ex: 'birth_chart'
  const v_place_id         = toTrimmedOrNull(birth_place_place_id, 128);
  const v_place_full       = toTrimmedOrNull(birth_place_full, 200);
  const v_place_country    = toTrimmedOrNull(birth_place_country, 2);
  const v_place_admin1     = toTrimmedOrNull(birth_place_admin1, 120);
  const v_place_admin2     = toTrimmedOrNull(birth_place_admin2, 120);
  const v_lat              = toNumberOrNull(birth_place_lat);
  const v_lng              = toNumberOrNull(birth_place_lng);
  const v_place_json       = toJsonOrNull(birth_place_json);
  const v_birth_tz_id      = toTrimmedOrNull(birth_timezone_id, 128);
  const v_birth_utc_offset = toNumberOrNull(birth_utc_offset_min);

  const sql = `
    INSERT INTO public.zodika_requests (
      name,                 -- 1
      social_name,          -- 2
      email,                -- 3
      birth_date,           -- 4
      birth_time,           -- 5
      birth_place,          -- 6
      product_type,         -- 7
      birth_place_place_id, -- 8
      birth_place_full,     -- 9
      birth_place_country,  -- 10
      birth_place_admin1,   -- 11
      birth_place_admin2,   -- 12
      birth_place_lat,      -- 13
      birth_place_lng,      -- 14
      birth_place_json,     -- 15
      birth_timezone_id,    -- 16
      birth_utc_offset_min  -- 17
    ) VALUES (
      $1,                   -- name
      $2,                   -- social_name
      $3,                   -- email
      $4::date,             -- birth_date (YYYY-MM-DD)
      $5::time,             -- birth_time (HH:MM[:SS])
      $6,                   -- birth_place
      $7,                   -- product_type
      $8,                   -- birth_place_place_id
      $9,                   -- birth_place_full
      $10,                  -- birth_place_country (2-letter)
      $11,                  -- birth_place_admin1
      $12,                  -- birth_place_admin2
      $13::float8,          -- birth_place_lat
      $14::float8,          -- birth_place_lng
      $15::jsonb,           -- birth_place_json
      $16,                  -- birth_timezone_id
      $17::int              -- birth_utc_offset_min
    )
    RETURNING *;
  `;

  const params = [
    v_name,
    v_social_name,
    v_email,
    birth_date,            // YYYY-MM-DD
    birth_time,            // HH:MM[:SS]
    v_birth_place,
    v_product_type,
    v_place_id,
    v_place_full,
    v_place_country,
    v_place_admin1,
    v_place_admin2,
    v_lat,
    v_lng,
    v_place_json,
    v_birth_tz_id,
    v_birth_utc_offset,
  ];

  const { rows } = await db.query(sql, params);
  return rows[0];
}

/**
 * Fetch a birthchart request by request_id.
 * @param {number|string} requestId
 * @returns {Promise<object|null>}
 */
async function findByRequestId(requestId) {
  const sql = `
    SELECT *
      FROM public.zodika_requests
     WHERE request_id = $1
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [requestId]);
  return rows[0] || null;
}

module.exports = {
  createBirthchartRequest,
  findByRequestId,
};
