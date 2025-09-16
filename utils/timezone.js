'use strict';

/**
 * Historical timezone resolution (Astrology-grade)
 * -----------------------------------------------
 * Strategy:
 *  1) Prefer GeoNames (historical offsets by date).
 *  2) Fallback to Google Time Zone API (if key is provided).
 *  3) Final fallback: static env values TZ_FALLBACK_ID + TZ_FALLBACK_OFFSET_MIN.
 *
 * Returns:
 *  { tzId, offsetMin, offsetHours }
 *    - offsetMin: integer minutes (canonical for DB)
 *    - offsetHours: decimal hours (for Ephemeris/Make/UI)
 *
 * Design:
 *  - Per-request in-memory cache with TTL.
 *  - Each provider has its own timeout guard.
 *  - Never throws; falls back to {tzId:null, offsetMin:null, offsetHours:null}.
 */

const DEFAULT_PROVIDER_TIMEOUT_MS = toInt(process.env.TZ_PROVIDER_TIMEOUT_MS, 6000);

// Final static fallback (optional)
const FALLBACK_TZ  = orNull(process.env.TZ_FALLBACK_ID);
const FALLBACK_OFF = toInt(process.env.TZ_FALLBACK_OFFSET_MIN, null); // minutes

// GeoNames (preferred for historical offsets)
const GEONAMES_USERNAME = orNull(process.env.GEONAMES_USERNAME);

/* ----------------------------- In-memory cache ----------------------------- */

/**
 * Simple LRU-ish cache with TTL.
 * Key: `${lat},${lng},${birthDate},${birthTime}`
 */
const CACHE = new Map();
const CACHE_TTL_MS = toInt(process.env.TZ_CACHE_TTL_MS, 12 * 60 * 60 * 1000); // 12h default
const CACHE_MAX_ENTRIES = toInt(process.env.TZ_CACHE_MAX_ENTRIES, 500);

function getCache(key) {
  const rec = CACHE.get(key);
  if (!rec) return null;
  if (Date.now() > rec.expireAt) {
    CACHE.delete(key);
    return null;
  }
  return rec.value;
}
function setCache(key, value) {
  if (CACHE.size >= CACHE_MAX_ENTRIES) {
    const firstKey = CACHE.keys().next().value;
    if (firstKey) CACHE.delete(firstKey);
  }
  CACHE.set(key, { value, expireAt: Date.now() + CACHE_TTL_MS });
}

/* -------------------------------- Public API ------------------------------- */

/**
 * Resolve the timezone at a given birth moment (historical).
 *
 * @param {Object} args
 * @param {number|string} args.lat
 * @param {number|string} args.lng
 * @param {string} args.birthDate   - 'YYYY-MM-DD'
 * @param {string} args.birthTime   - 'HH:MM'
 * @param {string} [args.apiKey]    - Google Time Zone API key (fallback)
 * @returns {Promise<{tzId: string|null, offsetMin: number|null, offsetHours: number|null}>}
 */
async function getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey }) {
  const latNum = toNum(lat);
  const lngNum = toNum(lng);
  if (!isFiniteNum(latNum) || !isFiniteNum(lngNum) || !isIsoDate(birthDate) || !isHHmm(birthTime)) {
    return staticFallbackOrNull();
  }

  const cacheKey = `${latNum},${lngNum},${birthDate},${birthTime}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  let result = null;

  // Provider #1: GeoNames (FREE plan uses HTTP endpoint)
  if (GEONAMES_USERNAME) {
    try {
      result = await geonamesLookup({
        lat: latNum,
        lng: lngNum,
        date: birthDate,
        username: GEONAMES_USERNAME,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      });
    } catch { /* swallow */ }
  }

  // Provider #2: Google Time Zone API
  if (!result && apiKey) {
    try {
      const tsSec = toUnixTimestampSec(birthDate, birthTime);
      result = await googleTzLookup({
        lat: latNum,
        lng: lngNum,
        timestampSec: tsSec,
        apiKey,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      });
    } catch { /* swallow */ }
  }

  // Final fallback (static), or nulls
  if (!result) result = staticFallbackOrNull();

  setCache(cacheKey, result);
  return result;
}

/** Convenience: convert minutes to decimal hours with 3-dec rounding. */
function toHours(offsetMin) {
  if (!Number.isFinite(+offsetMin)) return null;
  return Math.round((Number(offsetMin) / 60) * 1000) / 1000;
}

module.exports = { getTimezoneAtMoment, toHours };

/* -------------------------------- Providers -------------------------------- */

/**
 * GeoNames historical timezone.
 * FREE plan: use http://api.geonames.org (HTTPS requires premium).
 * API: http://api.geonames.org/timezoneJSON?lat=..&lng=..&date=YYYY-MM-DD&username=...
 */
async function geonamesLookup({ lat, lng, date, username, timeoutMs }) {
  const qs = new URLSearchParams({ lat: String(lat), lng: String(lng), date, username });
  const url = `http://api.geonames.org/timezoneJSON?${qs.toString()}`;

  const data = await fetchJson(url, { timeoutMs });
  if (!data) return null;
  if (data.status && data.status.message) return null; // GeoNames error

  const tzId = orNull(data.timezoneId);

  // Prefer dstOffset when DST active; else gmtOffset/rawOffset
  const baseHours = isFiniteNum(data.gmtOffset) ? Number(data.gmtOffset) : Number(data.rawOffset);
  let finalHours = isFiniteNum(baseHours) ? baseHours : null;
  if (isFiniteNum(data.dstOffset) && isFiniteNum(baseHours) && data.dstOffset !== data.gmtOffset) {
    finalHours = Number(data.dstOffset);
  }

  // IMPORTANT: accept valid offsets even if timezoneId is missing
  if (!isFiniteNum(finalHours)) return null;

  const offsetMin = Math.round(finalHours * 60);
  const offsetHours = toHours(offsetMin);
  return { tzId: tzId || null, offsetMin, offsetHours };
}

/**
 * Google Time Zone API (fallback).
 * API: https://maps.googleapis.com/maps/api/timezone/json?location=LAT,LNG&timestamp=UNIX&key=API_KEY
 */
async function googleTzLookup({ lat, lng, timestampSec, apiKey, timeoutMs }) {
  const qs = new URLSearchParams({
    location: `${lat},${lng}`,
    timestamp: String(timestampSec),
    key: apiKey,
  });
  const url = `https://maps.googleapis.com/maps/api/timezone/json?${qs.toString()}`;

  const data = await fetchJson(url, { timeoutMs });
  if (!data || data.status !== 'OK') return null;

  const tzId = orNull(data.timeZoneId);
  const totalOffsetSec = toNum(data.rawOffset, 0) + toNum(data.dstOffset, 0);
  if (!isFiniteNum(totalOffsetSec)) return null;

  const offsetMin = Math.round(totalOffsetSec / 60);
  const offsetHours = toHours(offsetMin);
  return { tzId: tzId || null, offsetMin, offsetHours };
}

/* -------------------------------- Utilities -------------------------------- */

function staticFallbackOrNull() {
  if (FALLBACK_TZ && isFiniteNum(FALLBACK_OFF)) {
    const offsetMin = Number(FALLBACK_OFF);
    return { tzId: FALLBACK_TZ, offsetMin, offsetHours: toHours(offsetMin) };
  }
  return { tzId: null, offsetMin: null, offsetHours: null };
}

async function fetchJson(url, { timeoutMs = 6000, method = 'GET', headers, body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(headers || {}) },
      body,
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const ctOk = resp.headers.get('content-type')?.includes('application/json');
    const data = ctOk ? await resp.json().catch(() => null) : null;
    return data || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function toUnixTimestampSec(yyyyMMdd, hhmm) {
  const [h, m] = String(hhmm).split(':').map((n) => parseInt(n, 10));
  const d = new Date(`${yyyyMMdd}T${pad2(h)}:${pad2(m)}:00Z`);
  return Math.floor(d.getTime() / 1000);
}
function pad2(n) { return n.toString().padStart(2, '0'); }
function isIsoDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isHHmm(s) {
  if (typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) return false;
  const [h, m] = s.split(':').map((n) => parseInt(n, 10));
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}
function toInt(v, def) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}
function toNum(v, def = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function orNull(v) {
  const s = (v ?? '').toString().trim();
  return s ? s : null;
}
