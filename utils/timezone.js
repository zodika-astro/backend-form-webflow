'use strict';

/**
 * Historical Timezone Resolution
 * ------------------------------
 * Business rule:
 *   Astrology requires the timezone/offset that applied at the *birth moment*,
 *   not the current offset for the location.
 *
 * Strategy (prefer → fallback):
 *   1) GeoNames timezoneJSON (supports historical offsets by date).
 *      - URL: https://api.geonames.org/timezoneJSON
 *      - Params: lat, lng, date=YYYY-MM-DD, username=GEONAMES_USERNAME
 *      - Output: { timezoneId, gmtOffset, dstOffset, rawOffset, ... }
 *      - We use gmtOffset (hours) on the given date → offsetMin.
 *   2) Google Time Zone API (compatible with existing code) when GeoNames
 *      username is not provided:
 *      - URL: https://maps.googleapis.com/maps/api/timezone/json
 *      - Params: location, timestamp=UnixSeconds, key=GOOGLE_MAPS_API_KEY
 *      - Output: rawOffset + dstOffset (seconds) → offsetMin.
 *
 * Design goals:
 *   - Keep the exported signature unchanged: getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey })
 *   - Be resilient: strict timeouts, safe parsing, and clean fallbacks.
 *   - Never throw here; return { tzId:null, offsetMin:null } on failure (controller handles errors).
 */

const DEFAULT_TIMEOUT_MS = Number.isFinite(Number(process.env.TZ_HTTP_TIMEOUT_MS))
  ? Number(process.env.TZ_HTTP_TIMEOUT_MS)
  : 6000; // 6s hard timeout for external lookups

const GEONAMES_USERNAME = (process.env.GEONAMES_USERNAME || '').trim() || null;
const GEONAMES_HOST = (process.env.GEONAMES_HOST || 'https://api.geonames.org').replace(/\/+$/, '');

const FALLBACK_TZ = process.env.TZ_FALLBACK_ID || null;
const FALLBACK_OFF = Number.isFinite(Number(process.env.TZ_FALLBACK_OFFSET_MIN))
  ? Number(process.env.TZ_FALLBACK_OFFSET_MIN)
  : null;

/** Abortable fetch with a hard timeout. */
async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
    return resp;
  } finally {
    clearTimeout(to);
  }
}

/** Round to nearest integer minute safely. */
function toMinutes(valueInHours) {
  const n = Number(valueInHours);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 60);
}

/** Builds a UNIX timestamp (seconds) from birth date/time (local naive input). */
function toUnixSeconds(birthDate, birthTime) {
  try {
    const dt = new Date(`${birthDate}T${birthTime}:00`);
    const ts = Math.floor(dt.getTime() / 1000);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

/** Minimal validation that we have lat/lng and a birth moment. */
function canLookup({ lat, lng, birthDate, birthTime }) {
  const okLat = lat !== undefined && lat !== null && !Number.isNaN(Number(lat));
  const okLng = lng !== undefined && lng !== null && !Number.isNaN(Number(lng));
  return !!(okLat && okLng && birthDate && birthTime);
}

/** Returns the configured fallback (or an empty result). */
function fallbackResult() {
  if (FALLBACK_TZ && FALLBACK_OFF !== null) {
    return { tzId: FALLBACK_TZ, offsetMin: FALLBACK_OFF };
  }
  return { tzId: null, offsetMin: null };
}

/* -------------------------------------------------------------------------- */
/* GeoNames lookup (historical by date)                                       */
/* -------------------------------------------------------------------------- */

async function resolveViaGeoNames({ lat, lng, birthDate, timeoutMs }) {
  if (!GEONAMES_USERNAME) return null;

  // GeoNames uses "date" = YYYY-MM-DD; it returns gmtOffset for that day.
  const url =
    `${GEONAMES_HOST}/timezoneJSON?` +
    `lat=${encodeURIComponent(Number(lat))}` +
    `&lng=${encodeURIComponent(Number(lng))}` +
    `&date=${encodeURIComponent(birthDate)}` +
    `&username=${encodeURIComponent(GEONAMES_USERNAME)}`;

  try {
    const resp = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, timeoutMs);
    let data = {};
    try { data = await resp.json(); } catch { data = {}; }

    // GeoNames returns HTTP 200 even on some errors; check for "status" field.
    if (!resp.ok || data.status || (!data.timezoneId && data.gmtOffset == null)) {
      // Log only high-level info; avoid leaking coordinates on failure logs in verbose environments.
      console.error('[TZ][GeoNames][ERR]', {
        http: resp.status,
        geonamesStatus: data.status?.message || data.status || 'invalid_payload',
      });
      return null;
    }

    const tzId = (data.timezoneId && String(data.timezoneId)) || null;

    // Prefer gmtOffset (hours) for the *date* provided. Falls back to rawOffset/dstOffset if needed.
    let offsetMin = null;

    if (data.gmtOffset != null) {
      offsetMin = toMinutes(data.gmtOffset);
    } else if (data.rawOffset != null || data.dstOffset != null) {
      const rawH = Number(data.rawOffset) || 0;
      const dstH = Number(data.dstOffset) || 0;
      offsetMin = toMinutes(rawH + dstH);
    }

    if (tzId && Number.isFinite(offsetMin)) {
      return { tzId, offsetMin };
    }
    return null;
  } catch (e) {
    console.error('[TZ][GeoNames][NET]', e?.message || e);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Google Time Zone API (fallback when GeoNames is not configured)            */
/* -------------------------------------------------------------------------- */

async function resolveViaGoogle({ lat, lng, birthDate, birthTime, apiKey, timeoutMs }) {
  if (!apiKey) return null;

  const ts = toUnixSeconds(birthDate, birthTime);
  if (!Number.isFinite(ts)) return null;

  const url =
    'https://maps.googleapis.com/maps/api/timezone/json' +
    `?location=${encodeURIComponent(Number(lat))},${encodeURIComponent(Number(lng))}` +
    `&timestamp=${encodeURIComponent(ts)}` +
    `&key=${encodeURIComponent(apiKey)}`;

  try {
    const resp = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, timeoutMs);
    let data = {};
    try { data = await resp.json(); } catch { data = {}; }

    if (!resp.ok || data.status !== 'OK') {
      console.error('[TZ][Google][ERR]', {
        http: resp.status,
        status: data.status,
        message: data.errorMessage || data.message,
      });
      return null;
    }

    const totalOffsetSec = (Number(data.rawOffset) || 0) + (Number(data.dstOffset) || 0);
    const offsetMin = Math.round(totalOffsetSec / 60);
    const tzId = (data.timeZoneId && String(data.timeZoneId)) || null;

    if (tzId && Number.isFinite(offsetMin)) {
      return { tzId, offsetMin };
    }
    return null;
  } catch (e) {
    console.error('[TZ][Google][NET]', e?.message || e);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey })
 * - Returns { tzId, offsetMin } or a fallback/nulls when not resolvable.
 * - apiKey is used only for the Google fallback; GeoNames uses GEONAMES_USERNAME.
 */
async function getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey }) {
  if (!canLookup({ lat, lng, birthDate, birthTime })) {
    return fallbackResult();
  }

  // 1) Prefer GeoNames (historical by date)
  const gn = await resolveViaGeoNames({ lat, lng, birthDate, timeoutMs: DEFAULT_TIMEOUT_MS });
  if (gn) return gn;

  // 2) Fallback to Google Time Zone API (requires apiKey)
  const gg = await resolveViaGoogle({ lat, lng, birthDate, birthTime, apiKey, timeoutMs: DEFAULT_TIMEOUT_MS });
  if (gg) return gg;

  // 3) Final fallback (configured static default or nulls)
  return fallbackResult();
}

module.exports = { getTimezoneAtMoment };
