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
 *  - Post-payment job footprints in `public.product_jobs`.
 *  - Update timezone fields on the request (if missing).
 *
 * Notes
 *  - Inputs are expected to be validated at the controller level (Zod).
 *  - Never log PII in this layer.
 *  - Use parameterized SQL only (no string interpolation).
 */

const db = require('../../db/db');

/* --------------------------------- Helpers --------------------------------- */

function toTrimmedOrNull(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return typeof max === 'number' ? s.slice(0, max) : s;
}
function toEmail(v) {
  const s = toTrimmedOrNull(v, 254);
  return s ? s.toLowerCase() : null;
}
function toNumberOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toJsonOrNull(v, maxBytes = 10_000) {
  if (v == null) return null;
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      if (s.length > maxBytes) return null;
      return v;
    } catch { return null; }
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    try {
      const parsed = JSON.parse(t);
      const s = JSON.stringify(parsed);
      if (s.length > maxBytes) return null;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  }
  return null;
}

/* ------------------------------- Requests ---------------------------------- */

async function createBirthchartRequest(data) {
  const {
    name, social_name, email, birth_date, birth_time, birth_place, product_type,
    birth_place_place_id, birth_place_full, birth_place_country, birth_place_admin1,
    birth_place_admin2, birth_place_lat, birth_place_lng, birth_place_json,
    birth_timezone_id, birth_utc_offset_min,
  } = data;

  const v_name             = toTrimmedOrNull(name, 120);
  const v_social_name      = toTrimmedOrNull(social_name, 60);
  const v_email            = toEmail(email);
  const v_birth_place      = toTrimmedOrNull(birth_place, 120);
  const v_product_type     = toTrimmedOrNull(product_type, 64); // e.g. 'birth_chart'
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
      name, social_name, email, birth_date, birth_time, birth_place, product_type,
      birth_place_place_id, birth_place_full, birth_place_country, birth_place_admin1,
      birth_place_admin2, birth_place_lat, birth_place_lng, birth_place_json,
      birth_timezone_id, birth_utc_offset_min
    ) VALUES (
      $1, $2, $3, $4::date, $5::time, $6, $7,
      $8, $9, $10, $11,
      $12, $13::float8, $14::float8, $15::jsonb,
      $16, $17::int
    )
    RETURNING *;
  `;
  const params = [
    v_name, v_social_name, v_email, birth_date, birth_time, v_birth_place, v_product_type,
    v_place_id, v_place_full, v_place_country, v_place_admin1,
    v_place_admin2, v_lat, v_lng, v_place_json,
    v_birth_tz_id, v_birth_utc_offset,
  ];
  const { rows } = await db.query(sql, params);
  return rows[0];
}

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

/**
 * Update timezone fields only if currently missing/empty.
 * Stores offset in MINUTES in DB (canonical). External payloads use hours.
 */
async function updateTimezoneIfMissing(requestId, { tzId, offsetMin }) {
  const sql = `
    UPDATE public.zodika_requests
       SET birth_timezone_id     = COALESCE(NULLIF(birth_timezone_id, ''), $2),
           birth_utc_offset_min  = COALESCE(birth_utc_offset_min, $3),
           updated_at            = NOW()
     WHERE request_id = $1
       AND (birth_timezone_id IS NULL OR birth_timezone_id = '' OR birth_utc_offset_min IS NULL)
    RETURNING *;
  `;
  const params = [requestId, tzId ?? null, Number.isFinite(offsetMin) ? Math.trunc(offsetMin) : null];
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

/* ---------------------------- Product Jobs (audit) -------------------------- */

/**
 * Return SUCCEEDED job (idempotency gate) if any for (request, product, trigger).
 */
async function findSucceededJob(requestId, productType, triggerStatus) {
  const sql = `
    SELECT *
      FROM public.product_jobs
     WHERE request_id = $1
       AND product_type = $2
       AND trigger_status = $3
       AND status = 'SUCCEEDED'
     LIMIT 1;
  `;
  const { rows } = await db.query(sql, [requestId, productType, triggerStatus]);
  return rows[0] || null;
}

/**
 * Insert RUNNING job with attempt = last_attempt + 1.
 */
async function markJobStart(requestId, productType, triggerStatus) {
  const sql = `
    INSERT INTO public.product_jobs (
      request_id, product_type, trigger_status, status, attempt
    ) VALUES (
      $1, $2, $3, 'RUNNING',
      COALESCE((
        SELECT MAX(attempt) + 1
          FROM public.product_jobs
         WHERE request_id = $1
           AND product_type = $2
           AND trigger_status = $3
      ), 1)
    )
    RETURNING *;
  `;
  const { rows } = await db.query(sql, [requestId, productType, triggerStatus]);
  return rows[0];
}

/**
 * Optional partial metrics update while RUNNING.
 */
async function markJobPartialMetrics(jobId, {
  ephemeris_http_status = null,
  webhook_http_status = null,
  ephemeris_duration_ms = null,
  webhook_duration_ms = null,
}) {
  const sql = `
    UPDATE public.product_jobs
       SET ephemeris_http_status = COALESCE($2, ephemeris_http_status),
           webhook_http_status   = COALESCE($3, webhook_http_status),
           ephemeris_duration_ms = COALESCE($4, ephemeris_duration_ms),
           webhook_duration_ms   = COALESCE($5, webhook_duration_ms),
           updated_at            = NOW()
     WHERE job_id = $1
    RETURNING *;
  `;
  const params = [jobId, ephemeris_http_status, webhook_http_status, ephemeris_duration_ms, webhook_duration_ms];
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

async function markJobSucceeded(jobId, {
  ephemeris_http_status = null,
  webhook_http_status = null,
  ephemeris_duration_ms = null,
  webhook_duration_ms = null,
}) {
  const sql = `
    UPDATE public.product_jobs
       SET status = 'SUCCEEDED',
           ephemeris_http_status = $2,
           webhook_http_status   = $3,
           ephemeris_duration_ms = $4,
           webhook_duration_ms   = $5,
           updated_at = NOW()
     WHERE job_id = $1
    RETURNING *;
  `;
  const params = [jobId, ephemeris_http_status, webhook_http_status, ephemeris_duration_ms, webhook_duration_ms];
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

async function markJobFailed(jobId, errorMessage) {
  const sql = `
    UPDATE public.product_jobs
       SET status = 'FAILED',
           error_message = $2,
           updated_at = NOW()
     WHERE job_id = $1
    RETURNING *;
  `;
  const { rows } = await db.query(sql, [jobId, String(errorMessage || '').slice(0, 2000)]);
  return rows[0] || null;
}

module.exports = {
  // Requests
  createBirthchartRequest,
  findByRequestId,
  updateTimezoneIfMissing,

  // Jobs
  findSucceededJob,
  markJobStart,
  markJobPartialMetrics,
  markJobSucceeded,
  markJobFailed,
};
