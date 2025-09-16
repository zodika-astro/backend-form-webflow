'use strict';


/**
* Birthchart Handler (post-payment, product-specific)
* --------------------------------------------------
* Listens to payment status changes (emitted by payments/orchestrator) and,
* for APPROVED on product_type = 'birth_chart':
* 1) Ensures historical timezone on the request (if missing).
* 2) Calls Ephemeris API with X-API-KEY (and optional Basic Auth).
* 3) Posts a consolidated payload (request + ephemeris + meta) to Make.
* 4) Records an execution footprint into product_jobs (idempotent).
*
* Production hardening in this revision:
* - Removes an out-of-scope duplicate error block that could throw ReferenceError after catch.
* - Robust HH:MM normalization for birth_time (+ safe fallback to '12:00' when malformed).
* - Timezone DB update when either tzId OR offsetMin is present (not strictly both).
* - Detailed diagnostic logs when timezone remains unresolved.
* - No functional changes to unrelated parts of the workflow.
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


/** Normalize time to strict HH:MM (24h). Returns null if cannot parse. */
function toHHMM(raw) {
const s = String(raw ?? '').trim();
const m = s.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?/); // accepts HH:M or HH:MM[:SS]
if (!m) return null;
const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
const mi = Math.min(59, Math.max(0, parseInt(m[2], 10)));
return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}


/** Convert "YYYY-MM-DD" + "HH:MM" into components expected by Ephemeris. */
function toDateParts(birth_date, birth_time) {
const [year, month, date] = String(birth_date).split('-').map((n) => parseInt(n, 10));
const hhmm = toHHMM(birth_time) || '12:00'; // safe default already logged earlier if malformed
const [hStr, mStr] = hhmm.split(':');
module.exports = { onApprovedEvent };
