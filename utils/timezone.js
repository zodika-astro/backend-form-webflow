// utils/timezone.js

const FALLBACK_TZ = process.env.TZ_FALLBACK_ID || null;
const FALLBACK_OFF = Number.isFinite(Number(process.env.TZ_FALLBACK_OFFSET_MIN))
  ? Number(process.env.TZ_FALLBACK_OFFSET_MIN)
  : null;

async function getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey }) {
  const canCall =
    apiKey &&
    lat !== undefined && lat !== null && !Number.isNaN(Number(lat)) &&
    lng !== undefined && lng !== null && !Number.isNaN(Number(lng)) &&
    birthDate && birthTime;

  if (!canCall) {
    if (FALLBACK_TZ && FALLBACK_OFF !== null) {
      return { tzId: FALLBACK_TZ, offsetMin: FALLBACK_OFF };
    }
    return { tzId: null, offsetMin: null };
  }
  const dt = new Date(`${birthDate}T${birthTime}:00`);
  const timestamp = Math.floor(dt.getTime() / 1000);

  const url =
    `https://maps.googleapis.com/maps/api/timezone/json` +
    `?location=${Number(lat)},${Number(lng)}` +
    `&timestamp=${timestamp}` +
    `&key=${encodeURIComponent(apiKey)}`;

  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok || data.status !== 'OK') {
      console.error('[TZ][ERR]', {
        http: resp.status,
        status: data.status,
        message: data.errorMessage || data.message,
      });

      if (FALLBACK_TZ && FALLBACK_OFF !== null) {
        return { tzId: FALLBACK_TZ, offsetMin: FALLBACK_OFF };
      }
      return { tzId: null, offsetMin: null };
    }

    const totalOffsetSec = (data.rawOffset || 0) + (data.dstOffset || 0);
    const offsetMin = Math.round(totalOffsetSec / 60);
    return { tzId: data.timeZoneId || null, offsetMin };
  } catch (e) {
    console.error('[TZ][NET-ERR]', e?.message || e);
    if (FALLBACK_TZ && FALLBACK_OFF !== null) {
      return { tzId: FALLBACK_TZ, offsetMin: FALLBACK_OFF };
    }
    return { tzId: null, offsetMin: null };
  }
}

module.exports = { getTimezoneAtMoment };
