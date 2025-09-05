// modules/birthchart/repository.js
'use strict';

const db = require('../../db/db');

/**
 * Birthchart Repository
 * ---------------------
 * Responsibilities
 * - Persist a normalized birthchart request into `zodika_requests`.
 * - Never log PII or secrets here; let upper layers decide how to log.
 *
 * Design notes
 * - Trust but verify: validators should already sanitize inputs, but we still
 *   defensively clamp sizes and coerce types to avoid DB errors.
 * - JSON handling: accept either an object or a JSON string; parse safely.
 * - All persistence is parameterized; no string interpolation.
 */

// ------------------------------- Helpers ------------------------------------

/** Return `null` when input is empty/undefined; otherwise trimmed string limited to `max`. */
function toTrimmedOrNull(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return typeof max === 'number' ? s.slice(0, max) : s;
}

/** Lowercase e-mail defensively (validators already do this). */
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

/** Safe JSON acceptor: object → as-is; string → parsed; invalid → null. */
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
      // size guard
      const s = JSON.stringify(parsed);
      if (s.length > maxBytes) return null;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

// ------------------------------- Repository ---------------------------------

/**
 * Inserts a birthchart request and returns the created row.
 * All fields are passed as parameters; types are coerced defensively.
 *
 * @param {Object} requestData - normalized input (already validated upstream)
 * @returns {Promise<Object>} - the inserted row
 * @throws {Error} - bubbles DB errors (caught and wrapped by the controller)
 */
async function createBirthchartRequest(requestData) {
  const {
    name, social_name, email, birth_date, birth_time, birth_place, product_type,
    birth_place_place_id, birth_place_full, birth_place_country, birth_place_admin1,
    birth_place_admin2, birth_place_lat, birth_place_lng, birth_place_json,
    birth_timezone_id, birth_utc_offset_min,
  } = requestData;

  // Defensive normalization (aligned with validators’ max lengths)
  const v_name                = toTrimmedOrNull(name, 120);
  const v_social_name         = toTrimmedOrNull(social_name, 60);
  const v_email               = toEmail(email); // 254
  const v_birth_place         = toTrimmedOrNull(birth_place, 120);
  const v_product_type        = toTrimmedOrNull(product_type, 64); // literal 'birth_chart'
  const v_place_id            = toTrimmedOrNull(birth_place_place_id, 128);
  const v_place_full          = toTrimmedOrNull(birth_place_full, 200);
  const v_place_country       = toTrimmedOrNull(birth_place_country, 2);
  const v_place_admin1        = toTrimmedOrNull(birth_place_admin1, 120);
  const v_place_admin2        = toTrimmedOrNull(birth_place_admin2, 120);
  const v_lat                 = toNumberOrNull(birth_place_lat);
  const v_lng                 = toNumberOrNull(birth_place_lng);
  const v_place_json          = toJsonOrNull(birth_place_json); // object or null
  const v_birth_tz_id         = toTrimmedOrNull(birth_timezone_id, 128);
  const v_birth_utc_offset    = toNumberOrNull(birth_utc_offset_min);

  const sql = `
    INSERT INTO zodika_requests (
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
    birth_date,            // already YYYY-MM-DD
    birth_time,            // already HH:MM
    v_birth_place,
    v_product_type,
    v_place_id,
    v_place_full,
    v_place_country,
    v_place_admin1,
    v_place_admin2,
    v_lat,
    v_lng,
    v_place_json,          // pg will serialize object → json; explicit ::jsonb cast parses the text
    v_birth_tz_id,
    v_birth_utc_offset,
  ];

  // Let the controller wrap DB errors into AppError.fromUpstream()
  const { rows } = await db.query(sql, params);
  return rows[0];
}

module.exports = { createBirthchartRequest };
