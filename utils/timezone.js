// utils/timezone.js
'use strict';

/**
 * Historical timezone resolution (Astrology-grade)
 * -----------------------------------------------
 * Strategy:
 *  1) Prefer GeoNames (historical offsets by date).
 *  2) Fallback to Google Time Zone API (if key is provided).
 *  3) Final fallback: static env values TZ_FALLBACK_ID + TZ_FALLBACK_OFFSET_MIN.
 *
 * Features:
 *  - Per-request caching (in-memory) with TTL to avoid repeated lookups.
 *  - Each provider call has its own timeout guard.
 *  - Always returns { tzId, offsetMin } — never throws.
 */

const DEFAULT_PROVIDER_TIMEOUT_MS = toInt(process.env.TZ_PROVIDER_TIMEOUT_MS, 6000);

// Final static fallback (optional)
const FALLBACK_TZ = orNull(process.env.TZ_FALLBACK_ID);
const FALLBACK_OFF = toInt(process.env.TZ_FALLBACK_OFFSET_MIN, null);

// GeoNames (preferred source for historical offsets)
const GEONAMES_USERNAME = orNull(process.env.GEONAMES_USERNAME);

// ----------------------------- In-memory cache ------------------------------

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
    // evict oldest (FIFO)
    const firstKey = CACHE.keys().next().value;
    if (firstKey) CACHE.delete(firstKey);
  }
  CACHE.set(key, { value, expireAt: Date.now() + CACHE_TTL_MS });
}

// ----------------------------- Public API ------------------------------

/**
 * Resolve the timezone at a given birth moment (historical).
 * Falls back gracefully across providers and static envs.
 *
 * @returns {Promise<{tzId: string|null, offsetMin: number|null}>}
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

  // Provider #1: GeoNames
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

module.exports = { getTimezoneAtMoment };

// ----------------------------- Providers ------------------------------

/**
 * GeoNames historical timezone.
 * API: https://secure.geonames.org/timezoneJSON?lat=..&lng=..&date=YYYY-MM-DD&username=...
 */
async function geonamesLookup({ lat, lng, date, username, timeoutMs }) {
  const qs = new URLSearchParams({ lat: String(lat), lng: String(lng), date, username });
  const url = `https://secure.geonames.org/timezoneJSON?${qs.toString()}`;

  const data = await fetchJson(url, { timeoutMs });
  if (!data) return null;

  if (data.status && data.status.message) return null; // GeoNames error

  const tzId = orNull(data.timezoneId);
  const baseOffsetHours = isFiniteNum(data.gmtOffset)
    ? data.gmtOffset
    : data.rawOffset;
  let finalHours = isFiniteNum(baseOffsetHours) ? baseOffsetHours : null;

  // Prefer dstOffset if present (DST active)
  if (isFiniteNum(data.dstOffset) && isFiniteNum(baseOffsetHours) && data.dstOffset !== data.gmtOffset) {
    finalHours = data.dstOffset;
  }

  if (!tzId || !isFiniteNum(finalHours)) return null;
  const offsetMin = Math.round(Number(finalHours) * 60);
  return { tzId, offsetMin };
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
  if (!tzId || !isFiniteNum(totalOffsetSec)) return null;

  const offsetMin = Math.round(totalOffsetSec / 60);
  return { tzId, offsetMin };
}

// ----------------------------- Utilities ------------------------------

function staticFallbackOrNull() {
  if (FALLBACK_TZ && isFiniteNum(FALLBACK_OFF)) {
    return { tzId: FALLBACK_TZ, offsetMin: Number(FALLBACK_OFF) };
  }
  return { tzId: null, offsetMin: null };
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
