// modules/birthchart/repository.js

const db = require('../../db/db');

async function createBirthchartRequest(requestData) {
  const {
    name, social_name, email, birth_date, birth_time, birth_place, product_type,
    birth_place_place_id, birth_place_full, birth_place_country, birth_place_admin1,
    birth_place_admin2, birth_place_lat, birth_place_lng, birth_place_json,
    birth_timezone_id, birth_utc_offset_min
  } = requestData;

 
  const lat = (birth_place_lat !== undefined && birth_place_lat !== null && String(birth_place_lat).trim() !== '')
    ? Number(birth_place_lat) : null;
  
  const lng = (birth_place_lng !== undefined && birth_place_lng !== null && String(birth_place_lng).trim() !== '')
    ? Number(birth_place_lng) : null;
  
  const rawJson = (birth_place_json && String(birth_place_json).trim() !== '')
    ? JSON.parse(birth_place_json) : null;

  
  const query = `
    INSERT INTO zodika_requests (
      name,                 -- 1
      social_name,          -- 2
      email,                -- 3
      birth_date,           -- 4
      birth_time,           -- 5
      birth_place,          -- 6
      product_type,         -- 7
      birth_place_place_id, -- 8
      birth_place_full,     -- 9
      birth_place_country,  -- 10
      birth_place_admin1,   -- 11
      birth_place_admin2,   -- 12
      birth_place_lat,      -- 13
      birth_place_lng,      -- 14
      birth_place_json,     -- 15
      birth_timezone_id,    -- 16
      birth_utc_offset_min  -- 17
    ) VALUES (
      $1,                   -- name
      $2,                   -- social_name
      $3,                   -- email
      $4::date,             -- birth_date
      $5::time,             -- birth_time
      $6,                   -- birth_place
      $7,                   -- product_type
      $8,                   -- birth_place_place_id
      $9,                   -- birth_place_full
      $10,                  -- birth_place_country
      $11,                  -- birth_place_admin1
      $12,                  -- birth_place_admin2
      $13::float8,          -- birth_place_lat
      $14::float8,          -- birth_place_lng
      $15::jsonb,           -- birth_place_json
      $16,                  -- birth_timezone_id
      $17::int              -- birth_utc_offset_min
    )
    RETURNING *;
  `;

  const values = [
    name,
    social_name || null,
    email,
    birth_date,
    birth_time,
    birth_place,
    product_type,
    birth_place_place_id,
    birth_place_full || null,
    birth_place_country || null,
    birth_place_admin1 || null,
    birth_place_admin2 || null,
    lat,
    lng,
    rawJson,
    birth_timezone_id || null,
    (birth_utc_offset_min !== undefined && birth_utc_offset_min !== null && String(birth_utc_offset_min).trim() !== '')
      ? Number(birth_utc_offset_min)
      : null
  ];

  try {
    const { rows } = await db.query(query, values);
    return rows[0];
  } catch (error) {
    console.error('Error creating request in database:', error);
    throw new Error('Database Error: Could not create birthchart request.');
  }
}

module.exports = { createBirthchartRequest };
