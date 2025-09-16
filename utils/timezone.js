// utils/timezone.js
'use strict';

/**
 * Historical timezone resolution (Astrology-grade)
 * -----------------------------------------------
 * 1) GeoNames (by date)  2) Google Time Zone (fallback)  3) Static env fallback
 * Returns { tzId, offsetMin, offsetHours }
 */

const { fetch } = require('undici'); // ensure fetch on Node 16/18/20+

const DEFAULT_PROVIDER_TIMEOUT_MS = toInt(process.env.TZ_PROVIDER_TIMEOUT_MS, 6000);

// Final static fallback (optional)
const FALLBACK_TZ  = orNull(process.env.TZ_FALLBACK_ID);
const FALLBACK_OFF = toInt(process.env.TZ_FALLBACK_OFFSET_MIN, null); // minutes

// GeoNames (preferred for historical offsets)
const GEONAMES_USERNAME = orNull(process.env.GEONAMES_USERNAME);

/* ----------------------------- Tiny LRU cache ------------------------------ */

const CACHE = new Map();
const CACHE_TTL_MS = toInt(process.env.TZ_CACHE_TTL_MS, 12 * 60 * 60 * 1000); // 12h
const CACHE_MAX_ENTRIES = toInt(process.env.TZ_CACHE_MAX_ENTRIES, 500);

function getCache(key) {
  const rec = CACHE.get(key);
  if (!rec) return null;
  if (Date.now() > rec.expireAt) { CACHE.delete(key); return null; }
  return rec.value;
}
function setCache(key, value) {
  if (CACHE.size >= CACHE_MAX_ENTRIES) {
    const first = CACHE.keys().next().value;
    if (first) CACHE.delete(first);
  }
  CACHE.set(key, { value, expireAt: Date.now() + CACHE_TTL_MS });
}

/* -------------------------------- Public API ------------------------------- */

async function getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey }) {
  const latNum = toNum(lat), lngNum = toNum(lng);
  if (!isFiniteNum(latNum) || !isFiniteNum(lngNum) || !isIsoDate(birthDate) || !isHHmm(birthTime)) {
    return staticFallbackOrNull();
  }

  const cacheKey = `${latNum},${lngNum},${birthDate},${birthTime}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  let result = null;

  // 1) GeoNames (FREE plan = HTTP endpoint)
  if (GEONAMES_USERNAME) {
    try {
      result = await geonamesLookup({
        lat: latNum, lng: lngNum, date: birthDate, username: GEONAMES_USERNAME,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      });
    } catch { /* swallow */ }
  }

  // 2) Google fallback (needs API key)
  if (!result && apiKey) {
    try {
      const tsSec = toUnixTimestampSec(birthDate, birthTime);
      result = await googleTzLookup({
        lat: latNum, lng: lngNum, timestampSec: tsSec, apiKey,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      });
    } catch { /* swallow */ }
  }

  // 3) Static fallback or nulls
  if (!result) result = staticFallbackOrNull();

  setCache(cacheKey, result);
  return result;
}

/** Convert minutes to decimal hours (rounded to 3 decimals). */
function toHours(offsetMin) {
  if (!Number.isFinite(+offsetMin)) return null;
  return Math.round((Number(offsetMin) / 60) * 1000) / 1000;
}

module.exports = { getTimezoneAtMoment, toHours };

/* -------------------------------- Providers -------------------------------- */

/**
 * GeoNames historical timezone (FREE: http).
 * API: http://api.geonames.org/timezoneJSON?lat=..&lng=..&date=YYYY-MM-DD&username=...
 */
async function geonamesLookup({ lat, lng, date, username, timeoutMs }) {
  const qs = new URLSearchParams({ lat: String(lat), lng: String(lng), date, username });
  const url = `http://api.geonames.org/timezoneJSON?${qs.toString()}`;

  const data = await fetchJson(url, { timeoutMs });
  if (!data) return null;
  if (data.status && data.status.message) return null; // e.g., user not found / limits

  // Try official fields first
  const tzId = orNull(data.timezoneId);
  const hasGmt = isFiniteNum(data.gmtOffset);
  const hasRaw = isFiniteNum(data.rawOffset);
  const hasDst = isFiniteNum(data.dstOffset);

  let finalHours = null;
  if (hasGmt) finalHours = Number(data.gmtOffset);
  if (hasDst && hasGmt && data.dstOffset !== data.gmtOffset) finalHours = Number(data.dstOffset);
  if (!hasGmt && hasRaw) finalHours = Number(data.rawOffset);

  // Last-resort: parse dates[].offsetToGmt if present
  if (!isFiniteNum(finalHours)) {
    const offStr = Array.isArray(data.dates)
      ? data.dates.find(d => typeof d?.offsetToGmt === 'string')?.offsetToGmt
      : null;
    const offNum = offStr != null ? Number.parseFloat(offStr) : NaN;
    if (Number.isFinite(offNum)) finalHours = offNum;
  }

  if (!isFiniteNum(finalHours)) return null;

  const offsetMin = Math.round(finalHours * 60);
  return { tzId: tzId || null, offsetMin, offsetHours: toHours(offsetMin) };
}

/**
 * Google Time Zone API (fallback).
 * API: https://maps.googleapis.com/maps/api/timezone/json?location=LAT,LNG&timestamp=UNIX&key=API_KEY
 */
async function googleTzLookup({ lat, lng, timestampSec, apiKey, timeoutMs }) {
  const qs = new URLSearchParams({ location: `${lat},${lng}`, timestamp: String(timestampSec), key: apiKey });
  const url = `https://maps.googleapis.com/maps/api/timezone/json?${qs.toString()}`;

  const data = await fetchJson(url, { timeoutMs });
  if (!data || data.status !== 'OK') return null;

  const tzId = orNull(data.timeZoneId);
  const totalOffsetSec = toNum(data.rawOffset, 0) + toNum(data.dstOffset, 0);
  if (!isFiniteNum(totalOffsetSec)) return null;

  const offsetMin = Math.round(totalOffsetSec / 60);
  return { tzId: tzId || null, offsetMin, offsetHours: toHours(offsetMin) };
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
    const ct = resp.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await resp.json().catch(() => null) : null;
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
function toInt(v, def) { const n = Number.parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : def; }
function toNum(v, def = NaN) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function orNull(v) { const s = (v ?? '').toString().trim(); return s ? s : null; }
