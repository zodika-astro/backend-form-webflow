// modules/birthchart/handler.js
'use strict';

/**
 * Birthchart Handler (post-payment, product-specific)
 * --------------------------------------------------
 * Listens to payment status changes (emitted by payments/orchestrator) and,
 * for APPROVED on product_type = 'birth_chart':
 *   1) Ensures historical timezone on the request (if missing).
 *   2) Calls Ephemeris API with X-API-KEY (and optional Basic Auth).
 *   3) Posts a consolidated payload (request + ephemeris + meta) to Make.
 *   4) Records an execution footprint into product_jobs (idempotent).
 *
 * Single responsibility: post-payment product workflow.
 * It does NOT mutate payment states and does NOT own payment logic.
 */

const baseLogger = require('../../utils/logger').child('birthchart.handler');
const httpClient = require('../../utils/httpClient');
const orchestrator = require('../../payments/orchestrator'); // singleton emitter/logic
const repo = require('./repository');
const { getTimezoneAtMoment } = require('../../utils/timezone');

// Env
const MAKE_WEBHOOK_URL_PAID = process.env.MAKE_WEBHOOK_URL_PAID;
const EPHEMERIS_API_URL =
  process.env.EPHEMERIS_API_URL || 'https://ephemeris-api-production.up.railway.app/api/v1/ephemeris';
const EPHEMERIS_API_KEY = process.env.EPHEMERIS_API_KEY;

// Optional Basic Auth for Ephemeris
const EPHEMERIS_BASIC_USER = process.env.EPHEMERIS_BASIC_USER || process.env.EPHEMERIS_USER;
const EPHEMERIS_BASIC_PASS = process.env.EPHEMERIS_BASIC_PASS || process.env.EPHEMERIS_PASSWORD;

// Optional Google fallback for timezone resolution
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || null;

// Timeouts
const EPHEMERIS_HTTP_TIMEOUT_MS = Number(process.env.EPHEMERIS_HTTP_TIMEOUT_MS || 12000);
const MAKE_HTTP_TIMEOUT_MS = Number(process.env.MAKE_HTTP_TIMEOUT_MS || 10000);

// Defensive constants
const PRODUCT_TYPE = 'birth_chart';
const TRIGGER_APPROVED = 'APPROVED';

/** Build Basic Authorization header value if creds are present. */
function buildBasicAuthHeader() {
  if (!EPHEMERIS_BASIC_USER || !EPHEMERIS_BASIC_PASS) return null;
  const token = Buffer.from(`${EPHEMERIS_BASIC_USER}:${EPHEMERIS_BASIC_PASS}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

/** Convert "YYYY-MM-DD" + "HH:MM[:SS]" into components expected by Ephemeris. */
function toDateParts(birth_date, birth_time) {
  const [year, month, date] = String(birth_date).split('-').map((n) => parseInt(n, 10));
  const [hStr, mStr] = String(birth_time).split(':');
  const hours = parseInt(hStr, 10);
  const minutes = parseInt(mStr, 10);
  return { year, month, date, hours, minutes };
}

/** Build Ephemeris POST body from request row and timezone info (hours). */
function buildEphemerisPayload(row, timezoneHours) {
  const { year, month, date, hours, minutes } = toDateParts(row.birth_date, row.birth_time);
  return {
    year,
    month,
    date,
    hours,
    minutes,
    seconds: 0,
    latitude: Number(row.birth_place_lat),
    longitude: Number(row.birth_place_lng),
    timezone: timezoneHours, // decimal hours (e.g., -3)
    config: {
      observation_point: 'topocentric',
      ayanamsha: 'tropical',
      language: 'pt',
    },
  };
}

/**
 * Build the Make webhook payload (PAID).
 * Includes "timezone" (hours). Does NOT include birth_timezone_id or *_offset_min.
 */
function buildMakePayload({ requestRow, ephemeris, job, providerMeta }) {
  return {
    request: {
      request_id: requestRow.request_id,
      product_type: requestRow.product_type,
      name: requestRow.name,
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
    ephemeris, // full response from Ephemeris API
    meta: {
      job_id: job?.job_id || null,
      trigger_status: providerMeta.trigger_status,
      source: 'birthchart/handler',
      provider: providerMeta.provider,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Main worker for APPROVED events on birth_chart.
 * Idempotent via product_jobs: one SUCCEEDED per (request_id, product, trigger).
 */
async function onApprovedEvent(evt) {
  const log = baseLogger.child('approved', { requestId: evt.requestId, provider: evt.provider });

  try {
    // 0) Guards
    if (!evt?.requestId || evt.productType !== PRODUCT_TYPE) return;
    if (evt.normalizedStatus !== TRIGGER_APPROVED) return;
    if (!MAKE_WEBHOOK_URL_PAID) {
      log.warn('MAKE_WEBHOOK_URL_PAID not configured; skipping');
      return;
    }
    if (!EPHEMERIS_API_KEY) {
      log.warn('EPHEMERIS_API_KEY not configured; skipping');
      return;
    }

    // 1) Idempotency
    const already = await repo.findSucceededJob(evt.requestId, PRODUCT_TYPE, TRIGGER_APPROVED);
    if (already) {
      log.info({ jobId: already.job_id }, 'job already completed; skipping');
      return;
    }

    // 2) Start job
    const job = await repo.markJobStart(evt.requestId, PRODUCT_TYPE, TRIGGER_APPROVED);

    // 3) Load request
    const request = await repo.findByRequestId(evt.requestId);
    if (!request) {
      await repo.markJobFailed(job.job_id, 'request not found');
      log.warn('request not found');
      return;
    }

    // 4) Ensure timezone (minutes) in DB
    let tzId = request.birth_timezone_id || null;
    let offsetMin =
      request.birth_utc_offset_min != null ? Number(request.birth_utc_offset_min) : null;

    if (!tzId || !Number.isFinite(offsetMin)) {
        const res = await getTimezoneAtMoment({
        lat: request.birth_place_lat,
        lng: request.birth_place_lng,
        birthDate: request.birth_date,
        birthTime: String(request.birth_time).slice(0, 5),
        apiKey: GOOGLE_MAPS_API_KEY || undefined, // fallback Google
      });


      tzId = res?.tzId ?? tzId ?? null;
      offsetMin = Number.isFinite(res?.offsetMin) ? res.offsetMin : offsetMin;

      if (tzId && Number.isFinite(offsetMin)) {
        await repo.updateTimezoneIfMissing(evt.requestId, { tzId, offsetMin });
      }
    }

    const timezoneHours = Number.isFinite(offsetMin) ? offsetMin / 60 : null;
    if (!Number.isFinite(timezoneHours)) {
      await repo.markJobFailed(job.job_id, 'timezone_unresolved');
      log.warn('timezone unresolved; aborting');
      return;
    }

    // 5) Call Ephemeris (with X-API-KEY and optional Basic)
    const ephBody = buildEphemerisPayload(request, timezoneHours);
    const ephHeaders = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-API-KEY': EPHEMERIS_API_KEY,
    };
    const basic = buildBasicAuthHeader();
    if (basic) ephHeaders.Authorization = basic;

    let ephStatus = 0;
    let ephDur = 0;
    let ephemerisData = null;

    try {
      const tEph = Date.now();
      const ephRes = await httpClient.post(EPHEMERIS_API_URL, ephBody, {
        headers: ephHeaders,
        timeout: EPHEMERIS_HTTP_TIMEOUT_MS,
        retries: 0,
      });
      ephDur = Date.now() - tEph;
      ephStatus = ephRes?.status || 0;
      ephemerisData = ephRes?.data || null;
    } catch (e) {
      ephStatus = e?.response?.status || 0;
      await repo.markJobFailed(job.job_id, `ephemeris_error:${ephStatus}`);
      log.warn({ ephStatus }, 'ephemeris request failed');
      return;
    }

    if (!ephemerisData) {
      await repo.markJobFailed(job.job_id, `ephemeris empty response (status ${ephStatus})`);
      log.warn({ ephStatus }, 'ephemeris returned empty body');
      return;
    }

    // 6) Post to Make (PAID)
    const makePayload = buildMakePayload({
      requestRow: { ...request, birth_utc_offset_min: offsetMin },
      ephemeris: ephemerisData,
      job,
      providerMeta: { provider: evt.provider, trigger_status: evt.normalizedStatus },
    });

    let makeStatus = 0;
    let makeDur = 0;

    try {
      const tMake = Date.now();
      const makeRes = await httpClient.post(MAKE_WEBHOOK_URL_PAID, makePayload, {
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        timeout: MAKE_HTTP_TIMEOUT_MS,
        retries: 0,
      });
      makeDur = Date.now() - tMake;
      makeStatus = makeRes?.status || 0;
    } catch (e) {
      makeStatus = e?.response?.status || 0;
      await repo.markJobFailed(job.job_id, `make_webhook_error:${makeStatus}`);
      log.warn({ makeStatus }, 'make webhook failed');
      return;
    }

    // 7) Finish job
    await repo.markJobSucceeded(job.job_id, {
      ephemeris_http_status: ephStatus,
      webhook_http_status: makeStatus,
      ephemeris_duration_ms: ephDur,
      webhook_duration_ms: makeDur,
    });

    log.info({ jobId: job.job_id, ephStatus, makeStatus }, 'birthchart flow completed');
  } catch (err) {
    baseLogger.error({ msg: err?.message }, 'birthchart handler failed');
  }
}

// ---- Subscription ----
// Importing this file wires the listener.
orchestrator.events.on('payments:status-changed', (evt) => {
  // evt shape:
  // { requestId, productType, provider, normalizedStatus, statusDetail,
  //   amountCents, currency, checkoutId, paymentId, authorizedAt, link }
  if (evt?.normalizedStatus === TRIGGER_APPROVED && evt?.productType === PRODUCT_TYPE) {
    onApprovedEvent(evt);
  }
});

module.exports = { onApprovedEvent };
