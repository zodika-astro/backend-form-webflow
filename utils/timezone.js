// utils/timezone.js
const fetch = require('node-fetch');

/**
 * Retorna o fuso IANA e o offset (em minutos) no momento do nascimento,
 * usando Google Time Zone API. Se faltar algum dado ou der erro, retorna nulos.
 */
async function getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey }) {
  // Guardas: se qualquer dado essencial faltar, não falhe o fluxo
  if (
    !apiKey ||
    lat === undefined || lat === null || Number.isNaN(Number(lat)) ||
    lng === undefined || lng === null || Number.isNaN(Number(lng)) ||
    !birthDate ||
    !birthTime
  ) {
    return { tzId: null, offsetMin: null };
  }

  // Construir timestamp a partir de "YYYY-MM-DDTHH:MM:00"
  // (O offset local será devolvido pela API)
  const dt = new Date(`${birthDate}T${birthTime}:00`);
  const timestamp = Math.floor(dt.getTime() / 1000);

  const url =
    `https://maps.googleapis.com/maps/api/timezone/json` +
    `?location=${Number(lat)},${Number(lng)}` +
    `&timestamp=${timestamp}` +
    `&key=${encodeURIComponent(apiKey)}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) return { tzId: null, offsetMin: null };

    const data = await resp.json();
    if (data.status !== 'OK') return { tzId: null, offsetMin: null };

    // rawOffset (padrão) + dstOffset (horário de verão) em segundos
    const totalOffsetSec = (data.rawOffset || 0) + (data.dstOffset || 0);
    const offsetMin = Math.round(totalOffsetSec / 60);

    return { tzId: data.timeZoneId || null, offsetMin };
  } catch {
    // Não quebrar o fluxo se a API falhar
    return { tzId: null, offsetMin: null };
  }
}

module.exports = { getTimezoneAtMoment };
