// utils/timezone.js
'use strict';

const { fetch } = require('undici');

/**
 * Historical timezone resolution via Google Time Zone API only
 * -----------------------------------------------------------
 * - Computes historical offset using the given birth date/time as the API timestamp.
 * - Requires GOOGLE_MAPS_API_KEY (or explicit apiKey param).
 * - Returns:
 *    { tzId: string|null, offsetMin: number|null, offsetHours: number|null }
 *
 * Notes:
 * - Uses Date.UTC to build a stable timestamp (in seconds).
 * - Sums `rawOffset` + `dstOffset` from Google to get total UTC offset at that moment.
 * - Caches results per (lat,lng,date,time) for performance.
 * - Optional static fallback (TZ_FALLBACK_ID + TZ_FALLBACK_OFFSET_MIN) is used only if Google fails.
 */

const DEFAULT_PROVIDER_TIMEOUT_MS = toInt(process.env.TZ_PROVIDER_TIMEOUT_MS, 6000);
const FALLBACK_TZ  = orNull(process.env.TZ_FALLBACK_ID);
const FALLBACK_OFF = toInt(process.env.TZ_FALLBACK_OFFSET_MIN, null);

const CACHE = new Map();
const CACHE_TTL_MS = toInt(process.env.TZ_CACHE_TTL_MS, 12 * 60 * 60 * 1000); // 12h
const CACHE_MAX_ENTRIES = toInt(process.env.TZ_CACHE_MAX_ENTRIES, 500);

/* ---------------------------------- Cache ---------------------------------- */

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

/* ---------------------------------- API ------------------------------------ */

/**
 * Resolve historical timezone for a given lat/lng and birth date/time using Google Time Zone API.
 * @param {Object} params
 * @param {number|string} params.lat
 * @param {number|string} params.lng
 * @param {string|Date} params.birthDate - "YYYY-MM-DD" or Date
 * @param {string} params.birthTime - "HH:MM" (optional; defaults 00:00)
 * @param {string} [params.apiKey] - Overrides GOOGLE_MAPS_API_KEY if provided
 */
async function getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey }) {
  const dateStr = toIsoDateString(birthDate);
  const latNum = toNum(lat), lngNum = toNum(lng);

  if (!isFiniteNum(latNum) || !isFiniteNum(lngNum) || !isIsoDate(dateStr) || !isValidTime(birthTime)) {
    return staticFallbackOrNull();
  }

  const normalizedTime = normalizeTime(birthTime);
  const cacheKey = `${latNum},${lngNum},${dateStr},${normalizedTime}`;
  const cached = getCache(cacheKey);
  if (cached !== null) return cached;

  const key = orNull(apiKey) || orNull(process.env.GOOGLE_MAPS_API_KEY);
  if (!key) {
    console.warn('Google Time Zone API key not configured (GOOGLE_MAPS_API_KEY).');
    const fb = staticFallbackOrNull();
    setCache(cacheKey, fb);
    return fb;
  }

  let result = null;

  try {
    const tsSec = toUnixTimestampSec(dateStr, normalizedTime);
    result = await googleTzLookup({
      lat: latNum, lng: lngNum, timestampSec: tsSec, apiKey: key,
      timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    });
  } catch (error) {
    console.warn('Google Time Zone lookup failed:', error?.message || String(error));
  }

  if (!result) result = staticFallbackOrNull();

  setCache(cacheKey, result);
  return result;
}

/* ------------------------------- Provider ---------------------------------- */

async function googleTzLookup({ lat, lng, timestampSec, apiKey, timeoutMs }) {
  const qs = new URLSearchParams({
    location: `${lat},${lng}`,
    timestamp: String(timestampSec),
    key: apiKey,
  });
  const url = `https://maps.googleapis.com/maps/api/timezone/json?${qs.toString()}`;

  const data = await fetchJson(url, { timeoutMs });
  if (!data || data.status !== 'OK') {
    if (data && data.status) {
      console.warn(`Google Time Zone API responded with status: ${data.status}${data.errorMessage ? ` - ${data.errorMessage}` : ''}`);
    }
    return null;
  }

  const tzId = orNull(data.timeZoneId);
  const rawSec = toNum(data.rawOffset, NaN);
  const dstSec = toNum(data.dstOffset, NaN);

  // Total offset seconds from UTC at the given historical instant
  const totalOffsetSec =
    (Number.isFinite(rawSec) ? rawSec : 0) + (Number.isFinite(dstSec) ? dstSec : 0);

  if (!Number.isFinite(totalOffsetSec)) return null;

  const offsetMin = Math.round(totalOffsetSec / 60);
  return { tzId: tzId || null, offsetMin, offsetHours: toHours(offsetMin) };
}

/* ------------------------------- Utilities --------------------------------- */

/** Returns a static fallback only if explicitly configured; never computes alternative offsets. */
function staticFallbackOrNull() {
  if (FALLBACK_TZ && Number.isFinite(toNum(FALLBACK_OFF))) {
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

    if (!resp.ok) {
      console.warn(`HTTP ${resp.status} for ${url}`);
      return null;
    }

    const ct = resp.headers.get('content-type') || '';
    const isJson = ct.includes('application/json');
    const data = isJson ? await resp.json().catch(() => null) : null;
    return data || null;
  } catch (error) {
    console.warn('Fetch error:', error?.message || String(error));
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Build UTC timestamp seconds for a given local date+time. */
function toUnixTimestampSec(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split('-').map((n) => parseInt(n, 10));
  const [hh, mm] = normalizeTime(timeStr).split(':').map((n) => parseInt(n, 10));
  // Use Date.UTC for stability across runtimes
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm, 0) / 1000);
}

/** Normalize to HH:MM — accepts H:M and HH:MM[:SS], returns zero-padded. */
function normalizeTime(timeStr) {
  const str = String(timeStr || '').trim();
  if (!str) return '00:00';

  const clean = str.replace(/[^0-9:]/g, '');
  const parts = clean.split(':');

  // Support "0705" -> "07:05"
  if (parts.length === 1 && parts[0].length === 4) {
    return `${parts[0].substring(0, 2)}:${parts[0].substring(2)}`;
  }

  if (parts.length >= 2) {
    const hours = Math.max(0, Math.min(23, parseInt(parts[0], 10) || 0));
    const minutes = Math.max(0, Math.min(59, parseInt(parts[1], 10) || 0));
    return `${pad2(hours)}:${pad2(minutes)}`;
  }

  return '00:00';
}

/** Valid if normalization yields HH:MM. Empty input is considered valid (00:00). */
function isValidTime(timeStr) {
  const normalized = normalizeTime(timeStr);
  return /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(normalized);
}

function toHours(offsetMin) {
  if (offsetMin === null || typeof offsetMin === 'undefined') return null;
  const n = Number(offsetMin);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / 60) * 1000) / 1000;
}

/* ----------------------------- Type helpers -------------------------------- */

function pad2(n) { return n.toString().padStart(2, '0'); }

function isIsoDate(v) {
  if (v instanceof Date && !isNaN(v)) return true;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function toIsoDateString(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  return String(v || '');
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

function orNull(v) { const s = (v ?? '').toString().trim(); return s ? s : null; }

module.exports = { getTimezoneAtMoment, toHours };
