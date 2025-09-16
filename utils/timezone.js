// utils/timezone.js
'use strict';

const { fetch } = require('undici');

const DEFAULT_PROVIDER_TIMEOUT_MS = toInt(process.env.TZ_PROVIDER_TIMEOUT_MS, 6000);
const FALLBACK_TZ = orNull(process.env.TZ_FALLBACK_ID);
const FALLBACK_OFF = toInt(process.env.TZ_FALLBACK_OFFSET_MIN, null);
const GEONAMES_USERNAME = orNull(process.env.GEONAMES_USERNAME);

const CACHE = new Map();
const CACHE_TTL_MS = toInt(process.env.TZ_CACHE_TTL_MS, 43200000);
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

async function getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey }) {
  const latNum = toNum(lat), lngNum = toNum(lng);
  if (!isFiniteNum(latNum) || !isFiniteNum(lngNum) || !isIsoDate(birthDate) || !isValidTime(birthTime)) {
    return staticFallbackOrNull();
  }

  const normalizedTime = normalizeTime(birthTime);
  const cacheKey = `${latNum},${lngNum},${birthDate},${normalizedTime}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  let result = null;

  if (GEONAMES_USERNAME) {
    try {
      result = await geonamesLookup({
        lat: latNum, lng: lngNum, date: birthDate, username: GEONAMES_USERNAME,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      });
    } catch (error) {
      console.warn('GeoNames lookup failed:', error.message);
    }
  }

  if (!result && apiKey) {
    try {
      const tsSec = toUnixTimestampSec(birthDate, normalizedTime);
      result = await googleTzLookup({
        lat: latNum, lng: lngNum, timestampSec: tsSec, apiKey,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      });
    } catch (error) {
      console.warn('Google Time Zone lookup failed:', error.message);
    }
  }

  if (!result) result = staticFallbackOrNull();

  setCache(cacheKey, result);
  return result;
}

function toHours(offsetMin) {
  if (!Number.isFinite(+offsetMin)) return null;
  return Math.round((Number(offsetMin) / 60) * 1000) / 1000;
}

async function geonamesLookup({ lat, lng, date, username, timeoutMs }) {
  if (!username) {
    console.warn('GeoNames username not configured');
    return null;
  }

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
  
  let finalHours = null;
  
  if (isFiniteNum(data.gmtOffset)) {
    finalHours = Number(data.gmtOffset);
  } else if (isFiniteNum(data.rawOffset)) {
    finalHours = Number(data.rawOffset);
  } else if (isFiniteNum(data.dstOffset)) {
    finalHours = Number(data.dstOffset);
  }

  if (!isFiniteNum(finalHours) && Array.isArray(data.dates)) {
    const offsetItem = data.dates.find(d => d && typeof d.offsetToGmt === 'string');
    if (offsetItem) {
      const offNum = Number.parseFloat(offsetItem.offsetToGmt);
      if (isFiniteNum(offNum)) finalHours = offNum;
    }
  }

  if (!isFiniteNum(finalHours)) {
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
  const totalOffsetSec = toNum(data.rawOffset, 0) + toNum(data.dstOffset, 0);
  if (!isFiniteNum(totalOffsetSec)) return null;

  const offsetMin = Math.round(totalOffsetSec / 60);
  return { tzId: tzId || null, offsetMin, offsetHours: toHours(offsetMin) };
}

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
    
    if (!resp.ok) {
      console.warn(`HTTP ${resp.status} for ${url}`);
      return null;
    }
    
    const ct = resp.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await resp.json().catch(() => null) : null;
    
    return data || null;
  } catch (error) {
    console.warn('Fetch error:', error.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function toUnixTimestampSec(yyyyMMdd, timeStr) {
  const normalized = normalizeTime(timeStr);
  const [h, m] = normalized.split(':').map((n) => parseInt(n, 10));
  const d = new Date(`${yyyyMMdd}T${pad2(h)}:${pad2(m)}:00Z`);
  return Math.floor(d.getTime() / 1000);
}

function normalizeTime(timeStr) {
  const str = String(timeStr || '').trim();
  if (!str) return '00:00';
  
  const clean = str.replace(/[^0-9:]/g, '');
  const parts = clean.split(':');
  
  if (parts.length === 1 && parts[0].length === 4) {
    return `${parts[0].substring(0, 2)}:${parts[0].substring(2)}`;
  }
  
  if (parts.length >= 2) {
    const hours = Math.max(0, Math.min(23, parseInt(parts[0]) || 0));
    const minutes = Math.max(0, Math.min(59, parseInt(parts[1]) || 0));
    return `${pad2(hours)}:${pad2(minutes)}`;
  }
  
  return '00:00';
}

function isValidTime(timeStr) {
  const normalized = normalizeTime(timeStr);
  return /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(normalized);
}

function pad2(n) { return n.toString().padStart(2, '0'); }
function isIsoDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function toInt(v, def) { const n = Number.parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : def; }
function toNum(v, def = NaN) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function orNull(v) { const s = (v ?? '').toString().trim(); return s ? s : null; }

module.exports = { getTimezoneAtMoment, toHours };
