// utils/timezone.js

const fetch = require('node-fetch');

async function getTimezoneAtMoment({ lat, lng, birthDate, birthTime, apiKey }) {
  if (!lat || !lng || !birthDate || !birthTime || !apiKey) return { tzId: null, offsetMin: null };

  const dt = new Date(`${birthDate}T${birthTime}:00`); // "YYYY-MM-DDTHH:MM:00"
  const timestamp = Math.floor(dt.getTime() / 1000);

  const url = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${timestamp}&key=${apiKey}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Timezone API HTTP ${resp.status}`);
  const data = await resp.json();

  if (data.status !== 'OK') {
    return { tzId: null, offsetMin: null };
  }

  const totalOffsetSec = (data.rawOffset || 0) + (data.dstOffset || 0);
  const offsetMin = Math.round(totalOffsetSec / 60);

  return { tzId: data.timeZoneId || null, offsetMin };
}

module.exports = { getTimezoneAtMoment };
