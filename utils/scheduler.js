// utils/scheduler.js
'use strict';

/**
 * Lightweight DB-backed scheduler for delayed payment follow-ups.
 *
 * Responsibilities
 *  - Poll due rows from `public.scheduled_triggers`.
 *  - Revalidate current payment status from `public.zodika_requests`.
 *  - If still PENDING, fire slim webhook (no Ephemeris) and record job in `public.product_jobs`.
 *  - Mark schedule as 'fired' or 'canceled' accordingly (idempotent).
 *
 * Notes
 *  - Uses hard-coded defaults: POLL_MS=120_000 and BATCH_LIMIT=50.
 *  - Adds small jitter to avoid synchronized spikes across instances.
 *  - Does not retry HTTP to n8n; failures are marked in product_jobs (FAILED) and schedule is 'fired' to avoid loops.
 */

const baseLogger = require('./logger').child('utils.scheduler');
const httpClient = require('./httpClient');

// Reuse repository to access DB-layer functions.
const repo = require('../modules/birthchart/repository');

// Constants
const PRODUCT_TYPE = 'birth_chart';
const TRIGGER_PENDING_10M = 'PENDING_10M';
const TRIGGER_PENDING_24H = 'PENDING_24H';

// Hard defaults (as requested)
const POLL_MS_DEFAULT = 120_000; // 120s
const BATCH_LIMIT_DEFAULT = 50;

// Optional autostart toggle (defaults to true). Keeps flexibility without changing behavior.
const AUTO_START = String(process.env.SCHEDULER_AUTO_START || 'true').toLowerCase() !== 'false';

// Webhooks (must be configured in env; handler already uses same names)
const WEBHOOK_URL_PENDING_10M = process.env.WEBHOOK_URL_PENDING_10M;
const WEBHOOK_URL_PENDING_24H = process.env.WEBHOOK_URL_PENDING_24H;

// HTTP timeout for n8n calls (reuse same knob used by handler)
const N8N_HTTP_TIMEOUT_MS = Number(process.env.N8N_HTTP_TIMEOUT_MS || 10_000);

// Internal state
let _timer = null;
let _stopped = true;

/* --------------------------------- Helpers --------------------------------- */

/** Return URL by scheduled trigger kind. */
function urlForKind(kind) {
  if (kind === TRIGGER_PENDING_10M) return WEBHOOK_URL_PENDING_10M;
  if (kind === TRIGGER_PENDING_24H) return WEBHOOK_URL_PENDING_24H;
  return null;
}

/** Small jitter (±10%) around a base interval to avoid thundering herd. */
function withJitter(baseMs) {
  const jitter = 0.10; // 10%
  const factor = 1 + (Math.random() * 2 * jitter - jitter);
  return Math.max(1_000, Math.round(baseMs * factor));
}

/** Build a minimal n8n payload (no Ephemeris), aligned with handler's slim shape. */
function buildSlimPayload({ requestRow, jobs, jobId, triggerStatus, provider }) {
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
    jobs: Array.isArray(jobs) ? jobs : [],
    meta: {
      job_id: jobId || null,
      trigger_status: triggerStatus,
      source: 'scheduler',
      provider: provider || requestRow.payment_provider || 'unknown',
      ephemeris_status_code: null,
      timestamp: new Date().toISOString(),
    },
  };
}

/** Decide if the stored payment_status still represents a "pending" state. */
function isStillPending(statusRaw) {
  const s = String(statusRaw || '').toLowerCase().trim();
  if (!s) return false;
  // Keep conservative: only fire if explicitly pending-like.
  return s === 'pending' || s.startsWith('pending_') || s === 'in_process';
}

/* --------------------------------- Core loop -------------------------------- */

async function processBatch(limit) {
  const log = baseLogger.child('tick');

  // 1) Fetch due schedules
  let due = [];
  try {
    due = await repo.pickDueSchedules(limit);
  } catch (e) {
    log.error({ err: e?.message }, 'pickDueSchedules failed');
    return;
  }
  if (!Array.isArray(due) || due.length === 0) {
    log.debug('no due schedules');
    return;
  }

  // 2) Process each schedule independently
  for (const sched of due) {
    const { sched_id, request_id, product_type, kind, provider } = sched;
    const kindStr = String(kind || '').trim();
    const reqId = request_id;

    const ctx = { schedId: sched_id, requestId: reqId, kind: kindStr };
    const slog = baseLogger.child('exec', ctx);

    try {
      // Guard: product type
      if (product_type !== PRODUCT_TYPE) {
        slog.warn({ product_type }, 'unexpected product_type; canceling schedule');
        await repo.markScheduleCanceled(sched_id);
        continue;
      }

      // Guard: webhook configured for this kind
      const targetUrl = urlForKind(kindStr);
      if (!targetUrl) {
        slog.warn('target webhook URL not configured; canceling schedule');
        await repo.markScheduleCanceled(sched_id);
        continue;
      }

      // Load request snapshot
      const request = await repo.findByRequestId(reqId);
      if (!request) {
        slog.warn('request not found; canceling schedule');
        await repo.markScheduleCanceled(sched_id);
        continue;
      }

      // Revalidate payment still pending
      if (!isStillPending(request.payment_status)) {
        slog.info({ payment_status: request.payment_status }, 'payment no longer pending; canceling schedule');
        await repo.markScheduleCanceled(sched_id);
        continue;
      }

      // Idempotency check: has this kind already succeeded?
      const already = await repo.findSucceededJob(reqId, PRODUCT_TYPE, kindStr);
      if (already) {
        slog.info({ jobId: already.job_id }, 'job already succeeded for this trigger; marking schedule fired');
        await repo.markScheduleFired(sched_id);
        continue;
      }

      // Start job
      const job = await repo.markJobStart(reqId, PRODUCT_TYPE, kindStr);

      // Jobs snapshot for payload
      let jobs = [];
      try {
        jobs = await repo.listJobsForRequest(reqId, PRODUCT_TYPE);
      } catch (e) {
        slog.warn({ err: e?.message }, 'listJobsForRequest failed');
        jobs = [];
      }

      // Build slim payload
      const payload = buildSlimPayload({
        requestRow: request,
        jobs,
        jobId: job?.job_id,
        triggerStatus: kindStr,
        provider,
      });

      // Fire webhook
      const t0 = Date.now();
      let webhookStatus = 0;

      try {
        const res = await httpClient.post(targetUrl, payload, {
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          timeout: N8N_HTTP_TIMEOUT_MS,
          retries: 0,
        });
        webhookStatus = res?.status || 0;
      } catch (e) {
        webhookStatus = e?.response?.status || 0;
        await repo.markJobFailed(job.job_id, `n8n_webhook_error:${webhookStatus}`);
        // Mark as fired to avoid infinite retry loops; failure is preserved in product_jobs.
        await repo.markScheduleFired(sched_id);
        slog.warn({ webhookStatus }, 'webhook failed; schedule marked fired, job FAILED');
        continue;
      }

      const dur = Date.now() - t0;

      // Success path
      await repo.markJobSucceeded(job.job_id, {
        ephemeris_http_status: null,
        webhook_http_status: webhookStatus,
        ephemeris_duration_ms: null,
        webhook_duration_ms: dur,
      });
      await repo.markScheduleFired(sched_id);

      slog.info({ jobId: job.job_id, webhookStatus, durMs: dur }, 'scheduled trigger completed');
    } catch (e) {
      // Defensive: on unexpected errors, cancel this schedule to avoid hot loops.
      await repo.markScheduleCanceled(sched_id).catch(() => {});
      slog.error({ err: e?.message }, 'unexpected error; schedule canceled defensively');
    }
  }
}

/* --------------------------------- Runner ---------------------------------- */

function scheduleNextTick(baseMs) {
  const ms = withJitter(baseMs);
  _timer = setTimeout(async () => {
    if (_stopped) return;
    try {
      await processBatch(BATCH_LIMIT_DEFAULT);
    } catch (e) {
      baseLogger.error({ err: e?.message }, 'processBatch crashed');
    } finally {
      if (!_stopped) scheduleNextTick(baseMs);
    }
  }, ms);
}

function startScheduler() {
  if (!_stopped) return;
  _stopped = false;
  baseLogger.info({ pollMs: POLL_MS_DEFAULT, batchLimit: BATCH_LIMIT_DEFAULT }, 'scheduler starting');
  scheduleNextTick(POLL_MS_DEFAULT);
}

function stopScheduler() {
  _stopped = true;
  if (_timer) clearTimeout(_timer);
  _timer = null;
  baseLogger.info('scheduler stopped');
}

// Autostart by default (can be disabled with SCHEDULER_AUTO_START=false)
if (AUTO_START) {
  // Defer a bit to allow app/bootstrap to finish
  setTimeout(() => {
    try { startScheduler(); } catch (e) { baseLogger.error({ err: e?.message }, 'autostart failed'); }
  }, 2_000);
}

module.exports = {
  startScheduler,
  stopScheduler,
};
