'use strict';

/**
 * Historical timezone resolution (Astrology-grade)
 * -----------------------------------------------
 * Strategy:
 *  1) Prefer GeoNames (historical offsets by date) using "timezoneJSON".
 *  2) Fallback to Google Time Zone API (timestamp-based), if a valid API key was provided.
 *  3) Final fallback: static env values TZ_FALLBACK_ID + TZ_FALLBACK_OFFSET_MIN (minutes).
 *
 * Input:
 *  - lat, lng: numbers (or coercible) — REQUIRED for external lookups
 *  - birthDate: 'YYYY-MM-DD' — REQUIRED for historical resolution
 *  - birthTime: 'HH:MM'      — REQUIRED to build a mid-exact timestamp
 *  - apiKey: Google Maps Time Zone API key (optional; used in fallback)
 *
 * Output:
 *  { tzId: string|null, offsetMin: number|null }
 *
 * Notes:
 *  - Each provider call has its own short timeout (default 6s) to avoid request pile-ups.
 *  - Offsets are returned in minutes (integer), including DST where applicable.
 */

const DEFAULT_PROVIDER_TIMEOUT_MS = toInt(process.env.TZ_PROVIDER_TIMEOUT_MS, 6000);

// Final static fallback (optional)
const FALLBACK_TZ = orNull(process.env.TZ_FALLBACK_ID);
const FALLBACK_OFF = toInt(process.env.TZ_FALLBACK_OFFSET_MIN, null);

// GeoNames (preferred source for historical offsets)
const GEONAMES_USERNAME = orNull(process.env.GEONAMES_USERNAME);

// ----------------------------- Public API ------------------------------

/**
 * Resolve the timezone at a given birth moment (historical).
 * Falls back gracefully across providers and static envs.
 */
async function getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey }) {
  // Basic guards: we need coordinates and a date+time to do any real lookup
  const latNum = toNum(lat);
  const lngNum = toNum(lng);
  if (!isFiniteNum(latNum) || !isFiniteNum(lngNum) || !isIsoDate(birthDate) || !isHHmm(birthTime)) {
    return staticFallbackOrNull();
  }

  // Provider #1: GeoNames
  if (GEONAMES_USERNAME) {
    const g = await geonamesLookup({
      lat: latNum,
      lng: lngNum,
      date: birthDate,
      username: GEONAMES_USERNAME,
      timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    });
    if (g) return g;
  }

  // Provider #2: Google Time Zone API
  if (apiKey) {
    const tsSec = toUnixTimestampSec(birthDate, birthTime);
    const gg = await googleTzLookup({
      lat: latNum,
      lng: lngNum,
      timestampSec: tsSec,
      apiKey,
      timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    });
    if (gg) return gg;
  }

  // Final fallback (static), or nulls to signal failure
  return staticFallbackOrNull();
}

module.exports = { getTimezoneAtMoment };

// ----------------------------- Providers ------------------------------

/**
 * GeoNames historical timezone.
 * API: http://api.geonames.org/timezoneJSON?lat=..&lng=..&date=YYYY-MM-DD&username=...
 * Relevant fields (example):
 *   - time: "2025-08-04 10:31"
 *   - dstOffset: -3   (hours)
 *   - gmtOffset: -3   (hours)
 *   - rawOffset: -3   (hours)
 *   - timezoneId: "America/Sao_Paulo"
 *
 * We prefer computing offset = rawOffset (+ DST if present). In practice:
 *   If dstOffset differs from gmtOffset, daylight saving may be active.
 */
async function geonamesLookup({ lat, lng, date, username, timeoutMs }) {
  const qs = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    date, // YYYY-MM-DD
    username,
  });

  const url = `http://api.geonames.org/timezoneJSON?${qs.toString()}`;

  const data = await fetchJson(url, { timeoutMs });
  if (!data) return null;

  if (data.status && data.status.message) {
    // Known GeoNames error shape
    return null;
  }

  const tzId = orNull(data.timezoneId);
  // GeoNames returns offsets in HOURS (number). Use dstOffset when present, else gmtOffset.
  // Documentation: dstOffset is “offset to GMT during Daylight Saving Time”, gmtOffset is “offset to GMT”.
  const hasDstOffset = isFiniteNum(data.dstOffset);
  const baseOffsetHours = isFiniteNum(data.gmtOffset) ? data.gmtOffset : data.rawOffset; // hours
  let finalHours = isFiniteNum(baseOffsetHours) ? baseOffsetHours : null;

  // Some responses provide both gmtOffset and dstOffset; if different, prefer dstOffset (DST active).
  if (hasDstOffset && isFiniteNum(baseOffsetHours) && data.dstOffset !== data.gmtOffset) {
    finalHours = data.dstOffset;
  }

  if (!tzId || !isFiniteNum(finalHours)) return null;

  const offsetMin = Math.round(Number(finalHours) * 60);
  return { tzId, offsetMin };
}

/**
 * Google Time Zone API (fallback).
 * API: https://maps.googleapis.com/maps/api/timezone/json?location=LAT,LNG&timestamp=UNIX&key=API_KEY
 * Returns:
 *  - timeZoneId
 *  - rawOffset (seconds)
 *  - dstOffset (seconds)
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

/** Static fallback or null if not configured. */
function staticFallbackOrNull() {
  if (FALLBACK_TZ && isFiniteNum(FALLBACK_OFF)) {
    return { tzId: FALLBACK_TZ, offsetMin: Number(FALLBACK_OFF) };
  }
  return { tzId: null, offsetMin: null };
}

/** Fetch JSON with a hard timeout (AbortController). Returns parsed object or null on any failure. */
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
    const ctOk = resp.headers.get('content-type')?.includes('application/json');
    const data = ctOk ? await resp.json().catch(() => null) : null;
    if (!resp.ok) return null;
    return data || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Convert ISO date + HH:MM to UNIX seconds (UTC-safe). */
function toUnixTimestampSec(yyyyMMdd, hhmm) {
  // Build a local naive date; timezone API will interpret timestamp as UTC reference.
  const [h, m] = String(hhmm).split(':').map((n) => parseInt(n, 10));
  const d = new Date(`${yyyyMMdd}T${pad2(h)}:${pad2(m)}:00Z`); // use Z to avoid local TZ skew
  return Math.floor(d.getTime() / 1000);
}

function pad2(n) {
  const s = String(n);
  return s.length === 1 ? `0${s}` : s;
}

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

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
function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function orNull(v) {
  const s = (v ?? '').toString().trim();
  return s ? s : null;
}
