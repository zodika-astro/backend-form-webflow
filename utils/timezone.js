// utils/timezone.js
'use strict';

const { fetch } = require('undici');

/**
 * Historical timezone resolution with layered providers
 * ----------------------------------------------------
 * Order:
 *  1) GeoNames `timezoneJSON` (date-aware; best for historical offsets).
 *  2) Google Time Zone API (timestamp-based; requires API key).
 *  3) Static fallback via env (TZ_FALLBACK_ID + TZ_FALLBACK_OFFSET_MIN), optional.
 *
 * Returns:
 *  { tzId: string|null, offsetMin: number|null, offsetHours: number|null }
 *
 * Notes:
 *  - Uses HTTPS for GeoNames to avoid HTTP egress restrictions.
 *  - Coerces numeric fields from providers defensively (strings -> numbers).
 *  - When gmtOffset is not available from GeoNames, computes rawOffset + dstOffset.
 *  - Google API `timestamp` is built with Date.UTC for stability.
 */

const DEFAULT_PROVIDER_TIMEOUT_MS = toInt(process.env.TZ_PROVIDER_TIMEOUT_MS, 6000);
const FALLBACK_TZ  = orNull(process.env.TZ_FALLBACK_ID);
const FALLBACK_OFF = toInt(process.env.TZ_FALLBACK_OFFSET_MIN, null);
const GEONAMES_USERNAME = orNull(process.env.GEONAMES_USERNAME);

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

async function getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey }) {
  // Accept either string YYYY-MM-DD or Date; normalize to YYYY-MM-DD
  const dateStr = toIsoDateString(birthDate);
  const latNum = toNum(lat), lngNum = toNum(lng);

  if (!isFiniteNum(latNum) || !isFiniteNum(lngNum) || !isIsoDate(dateStr) || !isValidTime(birthTime)) {
    return staticFallbackOrNull();
  }

  const normalizedTime = normalizeTime(birthTime);
  const cacheKey = `${latNum},${lngNum},${dateStr},${normalizedTime}`;
  const cached = getCache(cacheKey);
  if (cached !== null) return cached;

  let result = null;

  // 1) GeoNames (preferred)
  if (GEONAMES_USERNAME) {
    try {
      result = await geonamesLookup({
        lat: latNum, lng: lngNum, date: dateStr, username: GEONAMES_USERNAME,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      });
    } catch (error) {
      console.warn('GeoNames lookup failed:', error?.message || String(error));
    }
  }

  // 2) Google fallback (requires key)
  if (!result && apiKey) {
    try {
      const tsSec = toUnixTimestampSec(dateStr, normalizedTime);
      result = await googleTzLookup({
        lat: latNum, lng: lngNum, timestampSec: tsSec, apiKey,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      });
    } catch (error) {
      console.warn('Google Time Zone lookup failed:', error?.message || String(error));
    }
  }

  // 3) Static fallback (optional)
  if (!result) result = staticFallbackOrNull();

  setCache(cacheKey, result);
  return result;
}

/* ------------------------------- Providers --------------------------------- */

async function geonamesLookup({ lat, lng, date, username, timeoutMs }) {
  if (!username) {
    console.warn('GeoNames username not configured');
    return null;
  }

  // Use HTTPS to avoid egress policies blocking HTTP
  const qs = new URLSearchParams({ lat: String(lat), lng: String(lng), date, username });
  const url = `http://api.geonames.org/timezoneJSON?${qs.toString()}`;

  const data = await fetchJson(url, { timeoutMs });
  if (!data) {
    console.warn('GeoNames: No data received');
    return null;
  }
  if (data.status && data.status.message) {
    console.warn('GeoNames API error:', data.status.message);
    return null;
  }

  const tzId = orNull(data.timezoneId);

  // Defensive numeric coercion: provider may return strings
  const gmt      = toNum(data.gmtOffset);
  const raw      = toNum(data.rawOffset);
  const dst      = toNum(data.dstOffset);

  // Prefer gmtOffset (already includes DST). Otherwise compute raw + dst (treat missing as 0).
  let finalHours = Number.isFinite(gmt)
    ? gmt
    : (Number.isFinite(raw) || Number.isFinite(dst))
      ? ( (Number.isFinite(raw) ? raw : 0) + (Number.isFinite(dst) ? dst : 0) )
      : null;

  // Older payload shapes (rare): scan `.dates[].offsetToGmt`
  if (!Number.isFinite(finalHours) && Array.isArray(data.dates)) {
    const item = data.dates.find(d => d && typeof d.offsetToGmt !== 'undefined');
    const offNum = toNum(item?.offsetToGmt);
    if (Number.isFinite(offNum)) finalHours = offNum;
  }

  if (!Number.isFinite(finalHours)) {
    console.warn('GeoNames: No valid offset found');
    return null;
  }

  const offsetMin = Math.round(finalHours * 60);
  return { tzId: tzId || null, offsetMin, offsetHours: toHours(offsetMin) };
}

async function googleTzLookup({ lat, lng, timestampSec, apiKey, timeoutMs }) {
  const qs = new URLSearchParams({ location: `${lat},${lng}`, timestamp: String(timestampSec), key: apiKey });
  const url = `https://maps.googleapis.com/maps/api/timezone/json?${qs.toString()}`;

  const data = await fetchJson(url, { timeoutMs });
  if (!data || data.status !== 'OK') return null;

  const tzId = orNull(data.timeZoneId);
  const rawSec = toNum(data.rawOffset, NaN);
  const dstSec = toNum(data.dstOffset, NaN);

  // rawOffset + dstOffset -> total seconds from UTC
  const totalOffsetSec =
    (Number.isFinite(rawSec) ? rawSec : 0) + (Number.isFinite(dstSec) ? dstSec : 0);

  if (!Number.isFinite(totalOffsetSec)) return null;

  const offsetMin = Math.round(totalOffsetSec / 60);
  return { tzId: tzId || null, offsetMin, offsetHours: toHours(offsetMin) };
}

/* ------------------------------- Utilities --------------------------------- */

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

/** Build UTC timestamp seconds for a given local date+time (approximation is fine for DST rules). */
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

  // Support \"0705\" -> \"07:05\"
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
  // Guard against null/undefined: Number(null) === 0, so check explicitly
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
