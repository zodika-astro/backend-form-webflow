// modules/birthchart/handler.js
'use strict';

/**
 * Birthchart Handler (post-payment, product-specific)
 * --------------------------------------------------
 * APPROVED on product_type = 'birth_chart':
 *   1) Load request (timezone already persisted by controller async job).
 *   2) Call Ephemeris API with X-API-KEY (+ optional Basic).
 *   3) Post consolidated payload (request + ephemeris + meta) to **n8n webhook**.
 *   4) Record execution footprint into product_jobs (idempotent).
 *
 * Hardenings:
 *  - Accept DATE as string 'YYYY-MM-DD' **or** JavaScript Date (UTC) when building payload.
 *  - Strict numeric coercion and range checks (lat/lng/tz).
 *  - Timezone normalized as number with up to 3 decimals (serializes as -3 if integer).
 *  - Detailed logs for invalid payload (types + values).
 *  - Retries with backoff (429/502/503/504) and strict Ephemeris response validation.
 */

const baseLogger = require('../../utils/logger').child('birthchart.handler');
const httpClient = require('../../utils/httpClient');
const orchestrator = require('../../payments/orchestrator');
const repo = require('./repository');

// Env
// NOTE: replaced MAKE_WEBHOOK_URL_PAID -> WEBHOOK_URL_PAID (full n8n Production URL)
const WEBHOOK_URL_PAID = process.env.WEBHOOK_URL_PAID;
const EPHEMERIS_API_URL =
  process.env.EPHEMERIS_API_URL || 'https://ephemeris-api-production.up.railway.app/api/v1/ephemeris';
const EPHEMERIS_API_KEY = process.env.EPHEMERIS_API_KEY;

// Optional Basic Auth for Ephemeris
const EPHEMERIS_BASIC_USER = process.env.EPHEMERIS_BASIC_USER || process.env.EPHEMERIS_USER;
const EPHEMERIS_BASIC_PASS = process.env.EPHEMERIS_BASIC_PASS || process.env.EPHEMERIS_PASSWORD;

// Timeouts
const EPHEMERIS_HTTP_TIMEOUT_MS = Number(process.env.EPHEMERIS_HTTP_TIMEOUT_MS || 12000);
const N8N_HTTP_TIMEOUT_MS = Number(process.env.N8N_HTTP_TIMEOUT_MS || 10000); // renamed from MAKE_HTTP_TIMEOUT_MS

// Retry knobs (transient errors)
const EPHEMERIS_RETRY_ATTEMPTS = Math.max(0, Number(process.env.EPHEMERIS_RETRY_ATTEMPTS || 2));
const EPHEMERIS_RETRY_BASE_MS = Math.max(100, Number(process.env.EPHEMERIS_RETRY_BASE_MS || 400));

// Defensive constants
const PRODUCT_TYPE = 'birth_chart';
const TRIGGER_APPROVED = 'APPROVED';

/** Build Basic Authorization header value if creds are present. */
function buildBasicAuthHeader() {
  if (!EPHEMERIS_BASIC_USER || !EPHEMERIS_BASIC_PASS) return null;
  const token = Buffer.from(`${EPHEMERIS_BASIC_USER}:${EPHEMERIS_BASIC_PASS}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

/* ------------------------------ Coercion utils ----------------------------- */

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function int(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function round3(n) { return Math.round(n * 1000) / 1000; }

/** Normalize time to strict HH:MM (24h). Returns null if cannot parse. */
function toHHMM(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?/); // accepts HH:MM or HH:MM:SS
  if (!m) return null;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mi = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** Extract Y-M-D in UTC from string 'YYYY-MM-DD' or Date. */
function extractYMDUTC(birth_date) {
  if (birth_date instanceof Date && !isNaN(birth_date)) {
    return {
      y: birth_date.getUTCFullYear(),
      m: birth_date.getUTCMonth() + 1,
      d: birth_date.getUTCDate(),
    };
  }
  const s = String(birth_date || '').trim();
  // Strict YYYY-MM-DD
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { y: null, m: null, d: null };
  return { y: int(m[1]), m: int(m[2]), d: int(m[3]) };
}

/** Convert birth_date (+ possibly Date) + birth_time into parts expected by Ephemeris. */
function toDateParts(birth_date, birth_time) {
  const { y, m, d } = extractYMDUTC(birth_date);
  const hhmm = toHHMM(birth_time) || '12:00';
  const [hStr, mStr] = hhmm.split(':');
  const h = int(hStr);
  const mi = int(mStr);

  if (y == null || m == null || d == null || h == null || mi == null) {
    const e = new Error('invalid_date_or_time_parts');
    e.detail = {
      birth_date_value: birth_date,
      birth_date_type: birth_date instanceof Date ? 'Date' : typeof birth_date,
      birth_time_value: birth_time,
      birth_time_type: typeof birth_time,
      parsed: { y, m, d, h, mi },
    };
    throw e;
  }
  return {
    year: y,
    month: clamp(m, 1, 12),
    date: clamp(d, 1, 31),
    hours: clamp(h, 0, 23),
    minutes: clamp(mi, 0, 59),
  };
}

/** Derive timezone hours from DB row with strict numeric normalization. */
function deriveTimezoneHours(row) {
  const offMin = row && row.birth_utc_offset_min != null ? Number(row.birth_utc_offset_min) : null;
  if (Number.isFinite(offMin)) {
    const tz = round3(offMin / 60);
    if (tz >= -14 && tz <= 14) return tz;
  }
  const offHours = row && row.birth_utc_offset_hours != null ? Number(row.birth_utc_offset_hours) : null;
  if (Number.isFinite(offHours)) {
    const tz = round3(offHours);
    if (tz >= -14 && tz <= 14) return tz;
  }
  return null;
}

/** Build Ephemeris POST body from request row and timezone (hours). */
function buildEphemerisPayload(row, timezoneHours) {
  const { year, month, date, hours, minutes } = toDateParts(row.birth_date, row.birth_time);

  const lat = num(row.birth_place_lat);
  const lng = num(row.birth_place_lng);
  const tz  = num(timezoneHours);

  if (lat == null || lng == null || tz == null) {
    const e = new Error('invalid_coordinates_or_timezone');
    e.detail = {
      lat: row.birth_place_lat, latType: typeof row.birth_place_lat,
      lng: row.birth_place_lng, lngType: typeof row.birth_place_lng,
      timezoneHours, tzType: typeof timezoneHours,
    };
    throw e;
  }

  const body = {
    year,
    month,
    date,
    hours,
    minutes,
    seconds: 0,
    latitude: clamp(lat, -90, 90),
    longitude: clamp(lng, -180, 180),
    timezone: round3(tz), // e.g. -3, -3.5, -3.75
    config: {
      language: 'pt',
    },
  };

  if (body.timezone < -14 || body.timezone > 14) {
    const e = new Error('invalid_timezone_range');
    e.detail = { timezone: body.timezone };
    throw e;
  }
  return body;
}

/**
 * Build the **n8n** webhook payload (PAID).
 * (kept shape for downstream compatibility)
 */
function buildN8nPayload({ requestRow, ephemeris, job, providerMeta, ephemerisStatus }) {
  return {
    request: {
      request_id: requestRow.request_id,
      product_type: requestRow.product_type,
      name: requestRow.name,
      social_name: requestRow.social_name || null,
      gender_identity: requestRow.gender_identity,
      email: requestRow.email,
      birth_date: requestRow.birth_date,
      birth_time: requestRow.birth_time,
      birth_place: requestRow.birth_place,
      birth_place_lat: requestRow.birth_place_lat,
      birth_place_lng: requestRow.birth_place_lng,
      timezone:
        requestRow.birth_utc_offset_min != null ? Number(requestRow.birth_utc_offset_min) / 60 : null,
      created_at: requestRow.created_at,
      updated_at: requestRow.updated_at,
      payment: {
        provider: requestRow.payment_provider,
        status: requestRow.payment_status,
        status_detail: requestRow.payment_status_detail,
        amount_cents: requestRow.payment_amount_cents,
        currency: requestRow.payment_currency,
        checkout_id: requestRow.payment_checkout_id,
        payment_id: requestRow.payment_payment_id,
        link: requestRow.payment_link,
        authorized_at: requestRow.payment_authorized_at,
        updated_at: requestRow.payment_updated_at,
      },
    },
    ephemeris, // full validated response from Ephemeris API
    meta: {
      job_id: job?.job_id || null,
      trigger_status: providerMeta.trigger_status,
      source: 'birthchart/handler',
      provider: providerMeta.provider,
      ephemeris_status_code: ephemerisStatus ?? null,
      timestamp: new Date().toISOString(),
    },
  };
}

/* ----------------------- Ephemeris client helpers -------------------------- */

function sanitizeForLogHeaders(h) {
  if (!h) return undefined;
  const copy = { ...h };
  delete copy['X-API-KEY'];
  delete copy['x-api-key'];
  delete copy['Authorization'];
  delete copy['authorization'];
  return copy;
}
function isTransientStatus(s) { return s === 429 || s === 502 || s === 503 || s === 504; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Normalize ephemeris JSON and require { statusCode: 200 }. */
function normalizeEphemerisData(raw) {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : (raw && typeof raw === 'object' ? raw : null);
  if (!obj || typeof obj !== 'object') { const e = new Error('invalid_ephemeris_payload'); e.detail='Response is not a JSON object'; throw e; }
  if (typeof obj.statusCode !== 'number') { const e = new Error('invalid_ephemeris_statusCode'); e.detail='Missing statusCode'; throw e; }
  if (obj.statusCode !== 200) { const e = new Error('ephemeris_non_200'); e.statusCode=obj.statusCode; e.detail=obj.message||'Ephemeris returned non-200'; e.body=obj; throw e; }
  return obj;
}

/** POST to Ephemeris with retries on transient failures. */
async function callEphemerisWithRetry(url, body, headers, log) {
  let attempt = 0;
  let lastErr = null;

  while (attempt <= EPHEMERIS_RETRY_ATTEMPTS) {
    const t0 = Date.now();
    try {
      log.info(
        { url, attempt, preview: { ...body, config: body?.config }, types: Object.fromEntries(Object.entries(body).map(([k,v])=>[k, typeof v])) },
        'ephemeris request preview'
      );
      const res = await httpClient.post(url, body, {
        headers,
        timeout: EPHEMERIS_HTTP_TIMEOUT_MS,
        retries: 0,
      });
      const dur = Date.now() - t0;
      const status = res?.status || 0;
      const normalized = normalizeEphemerisData(res?.data);

      log.info({ url, status, durMs: dur, attempt }, 'ephemeris call succeeded');
      return { status, data: normalized, dur };
    } catch (e) {
      const status = e?.response?.status || e?.status || 0;
      const errBody = e?.response?.data || e?.errBody;
      const safeErrBody = typeof errBody === 'string' ? errBody.slice(0, 800) : errBody;
      const dur = Date.now() - t0;
      const non200 = e && e.message === 'ephemeris_non_200';

      log.warn(
        {
          url, status, durMs: dur, attempt,
          transient: isTransientStatus(status), non200,
          errDetail: e?.detail, errBody: non200 ? e.body : safeErrBody,
          reqHeaders: sanitizeForLogHeaders(headers),
          reqBody: body,
        },
        'ephemeris call failed'
      );

      lastErr = Object.assign(new Error('ephemeris_call_failed'), { status, errBody: safeErrBody, url });
      if (!isTransientStatus(status) || attempt === EPHEMERIS_RETRY_ATTEMPTS) break;

      const backoff = Math.round(EPHEMERIS_RETRY_BASE_MS * Math.pow(2, attempt) * (1 + Math.random() * 0.3));
      await sleep(backoff);
      attempt += 1;
      continue;
    }
  }
  throw lastErr || new Error('ephemeris_call_failed');
}

/* -------------------------------------------------------------------------- */
/* Main Worker                                                                */
/* -------------------------------------------------------------------------- */

async function onApprovedEvent(evt) {
  const log = baseLogger.child('approved', { requestId: evt.requestId, provider: evt.provider });

  try {
    // 0) Guards
    if (!evt?.requestId || evt.productType !== PRODUCT_TYPE) return;
    if (evt.normalizedStatus !== TRIGGER_APPROVED) return;
    if (!WEBHOOK_URL_PAID) { log.warn('WEBHOOK_URL_PAID not configured; skipping'); return; }
    if (!EPHEMERIS_API_KEY) { log.warn('EPHEMERIS_API_KEY not configured; skipping'); return; }

    // 1) Idempotency
    const already = await repo.findSucceededJob(evt.requestId, PRODUCT_TYPE, TRIGGER_APPROVED);
    if (already) { log.info({ jobId: already.job_id }, 'job already completed; skipping'); return; }

    // 2) Start job
    const job = await repo.markJobStart(evt.requestId, PRODUCT_TYPE, TRIGGER_APPROVED);

    // 3) Load request
    const request = await repo.findByRequestId(evt.requestId);
    if (!request) {
      await repo.markJobFailed(job.job_id, 'request_not_found');
      log.warn('request not found');
      return;
    }

    // 4) Expect timezone already computed
    const tzHours = deriveTimezoneHours(request);
    if (!Number.isFinite(tzHours)) {
      await repo.markJobFailed(job.job_id, 'timezone_missing');
      log.warn({ rawMin: request.birth_utc_offset_min, rawHours: request.birth_utc_offset_hours }, 'timezone missing on request; aborting handler flow');
      return;
    }

    // 5) Build Ephemeris payload (strict)
    let ephBody;
    try {
      ephBody = buildEphemerisPayload(request, tzHours);
    } catch (e) {
      const detail = e?.detail ? JSON.stringify(e.detail) : undefined;
      await repo.markJobFailed(job.job_id, `${e?.message || 'ephemeris_payload_error'}${detail ? `:${detail}` : ''}`);
      log.warn({ err: e?.message, detail: e?.detail }, 'invalid ephemeris payload; aborting');
      return;
    }

    // 6) Call Ephemeris (with X-API-KEY and optional Basic)
    const ephHeaders = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-API-KEY': EPHEMERIS_API_KEY,
      'User-Agent': 'ZodikaBackend/1.0',
    };
    const basic = buildBasicAuthHeader();
    if (basic) ephHeaders.Authorization = basic;

    let ephemerisData = null;
    let ephStatus = 0;
    let ephDur = 0;

    try {
      const res = await callEphemerisWithRetry(EPHEMERIS_API_URL, ephBody, ephHeaders, log);
      ephemerisData = res.data;   // validated object
      ephStatus = res.status;
      ephDur = res.dur;
    } catch (e) {
      const ephStatusErr = e?.status || 0;
      await repo.markJobFailed(job.job_id, `ephemeris_error:${ephStatusErr}`);
      log.warn({ ephStatus: ephStatusErr, url: e?.url || EPHEMERIS_API_URL, errBody: e?.errBody }, 'ephemeris request failed (final)');
      return;
    }

    // 7) Post to **n8n** (PAID)
    const n8nPayload = buildN8nPayload({
      requestRow: { ...request, birth_utc_offset_min: request.birth_utc_offset_min },
      ephemeris: ephemerisData,
      job,
      providerMeta: { provider: evt.provider, trigger_status: evt.normalizedStatus },
      ephemerisStatus: ephStatus,
    });

    let n8nStatus = 0;
    let n8nDur = 0;

    try {
      const t = Date.now();
      const n8nRes = await httpClient.post(WEBHOOK_URL_PAID, n8nPayload, {
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        timeout: N8N_HTTP_TIMEOUT_MS,
        retries: 0,
      });
      n8nDur = Date.now() - t;
      n8nStatus = n8nRes?.status || 0;
    } catch (e) {
      n8nStatus = e?.response?.status || 0;
      await repo.markJobFailed(job.job_id, `n8n_webhook_error:${n8nStatus}`);
      log.warn({ n8nStatus }, 'n8n webhook failed');
      return;
    }

    // 8) Finish job
    await repo.markJobSucceeded(job.job_id, {
      ephemeris_http_status: ephStatus,
      webhook_http_status: n8nStatus,
      ephemeris_duration_ms: ephDur,
      webhook_duration_ms: n8nDur,
    });

    log.info({ jobId: job.job_id, ephStatus, n8nStatus }, 'birthchart flow completed');
  } catch (err) {
    baseLogger.error({ msg: err?.message }, 'birthchart handler failed');
  }
}

// ---- Subscription ----
orchestrator.events.on('payments:status-changed', (evt) => {
  if (evt?.normalizedStatus === TRIGGER_APPROVED && evt?.productType === PRODUCT_TYPE) {
    onApprovedEvent(evt);
  }
});


module.exports = { onApprovedEvent };
