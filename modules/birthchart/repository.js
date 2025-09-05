// modules/birthchart/repository.js
'use strict';

/**
 * Birthchart Repository
 * ---------------------
 * Responsibilities
 *  - Persist a new zodika_requests row for a public form submission.
 *  - Provide a database-level idempotency guard to avoid duplicate rows
 *    when the user double-submits or the network retries occur.
 *
 * Idempotency strategy (no schema changes required):
 *  - Within a short time window (default 10 minutes), treat as duplicates any
 *    submission that matches the following business keys:
 *      • email (lowercased)
 *      • birth_date (YYYY-MM-DD)
 *      • birth_time (HH:MM:SS)
 *      • location identity:
 *          - prefer exact match on birth_place_place_id when present; otherwise
 *          - match on birth_place_full (string equality; already normalized on input)
 *  - We use a CTE that:
 *      1) SELECTs a recent existing row by those keys
 *      2) INSERTs a new row only if the SELECT found nothing
 *      3) Returns either the inserted row or the existing row
 *
 * Notes
 *  - Assumes the table zodika_requests has a created_at with default NOW().
 *  - Keep the column order/types consistent with the existing schema.
 *  - Do not log payloads or PII here; let the service/controller handle structured logs.
 */

const db = require('../../db/db');

// Dedup window (minutes). Can be tuned via env without changing code.
const DEDUP_WINDOW_MIN =
  Number.isFinite(Number(process.env.BIRTHCHART_DEDUP_WINDOW_MIN))
    ? Number(process.env.BIRTHCHART_DEDUP_WINDOW_MIN)
    : 10;

/* ------------------------------- helpers ----------------------------------- */

function toNumberOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toJsonOrNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return v; // pg will serialize JS objects to jsonb
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    try {
      const parsed = JSON.parse(s);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/* ------------------------------- API --------------------------------------- */

/**
 * Create a birthchart request with idempotency (dedup window).
 * @param {object} requestData - validated & normalized payload from the controller
 * @returns {Promise<object>} the persisted (or deduped) row
 */
async function createBirthchartRequest(requestData) {
  const {
    name,
    social_name,
    email,
    birth_date,
    birth_time,
    birth_place,
    product_type,

    birth_place_place_id,
    birth_place_full,
    birth_place_country,
    birth_place_admin1,
    birth_place_admin2,
    birth_place_lat,
    birth_place_lng,
    birth_place_json,

    birth_timezone_id,
    birth_utc_offset_min,
  } = requestData;

  // Normalize primitives defensively (validators already normalized most fields)
  const emailLower = (email || '').toLowerCase().trim();

  const lat = toNumberOrNull(birth_place_lat);
  const lng = toNumberOrNull(birth_place_lng);
  const rawJson = toJsonOrNull(birth_place_json);

  /**
   * Idempotency CTE
   *  - existing: select a recent row that matches our natural keys
   *  - ins: insert only if no recent match
   *  - final select: return the inserted row or the existing row
   *
   * Matching logic for location:
   *   Prefer exact match on place_id when provided; otherwise use the full label.
   */
  const sql = `
    WITH existing AS (
      SELECT *
        FROM zodika_requests
       WHERE email = $3
         AND birth_date = $4::date
         AND birth_time = $5::time
         AND (
              ($8 IS NOT NULL AND birth_place_place_id = $8)
           OR ($8 IS NULL AND COALESCE(birth_place_full, '') = COALESCE($9, ''))
         )
         AND created_at >= NOW() - ($18::int * INTERVAL '1 minute')
       ORDER BY created_at DESC
       LIMIT 1
    ), ins AS (
      INSERT INTO zodika_requests (
        name,                 --  1
        social_name,          --  2
        email,                --  3
        birth_date,           --  4
        birth_time,           --  5
        birth_place,          --  6
        product_type,         --  7
        birth_place_place_id, --  8
        birth_place_full,     --  9
        birth_place_country,  -- 10
        birth_place_admin1,   -- 11
        birth_place_admin2,   -- 12
        birth_place_lat,      -- 13
        birth_place_lng,      -- 14
        birth_place_json,     -- 15
        birth_timezone_id,    -- 16
        birth_utc_offset_min  -- 17
      )
      SELECT
        $1,
        $2,
        $3,
        $4::date,
        $5::time,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13::float8,
        $14::float8,
        $15::jsonb,
        $16,
        $17::int
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING *
    )
    SELECT * FROM ins
    UNION ALL
    SELECT * FROM existing
    LIMIT 1;
  `;

  const values = [
    name,                                //  1
    social_name || null,                 //  2
    emailLower,                          //  3 (normalized)
    birth_date,                          //  4
    birth_time,                          //  5
    birth_place,                         //  6
    product_type,                        //  7
    birth_place_place_id || null,        //  8
    birth_place_full || null,            //  9
    birth_place_country || null,         // 10
    birth_place_admin1 || null,          // 11
    birth_place_admin2 || null,          // 12
    lat,                                 // 13
    lng,                                 // 14
    rawJson,                             // 15
    birth_timezone_id || null,           // 16
    toNumberOrNull(birth_utc_offset_min),// 17
    DEDUP_WINDOW_MIN,                    // 18 (minutes)
  ];

  const { rows } = await db.query(sql, values);
  return rows[0];
}

module.exports = { createBirthchartRequest };
