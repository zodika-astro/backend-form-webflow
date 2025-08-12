// modules/birthchart/repository.js

const db = require('../../db/db');

async function createBirthchartRequest(requestData) {
  const {
    name,
    social_name,
    email,
    birth_date,
    birth_time,
    birth_place,
    product_type
  } = requestData;

  const query = `
    INSERT INTO zodika_requests (name, social_name, email, birth_date, birth_time, birth_place, product_type)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *;
  `;
  const values = [name, social_name, email, birth_date, birth_time, birth_place, product_type];

  try {
    const { rows } = await db.query(query, values);
    return rows[0];
  } catch (error) {
    console.error('Error creating request in database:', error);
    throw new Error('Database Error: Could not create birthchart request.');
  }
}

/**
 * Busca uma request pelo request_id e retorna também o product_type
 * @param {string} requestId - ID único da request
 * @returns {Promise<{request_id: string, product_type: string} | null>}
 */
async function findByRequestId(requestId) {
  const query = `
    SELECT request_id, product_type
    FROM zodika_requests
    WHERE request_id = $1
    LIMIT 1;
  `;
  try {
    const { rows } = await db.query(query, [requestId]);
    return rows[0] || null;
  } catch (error) {
    console.error('Error fetching request by request_id from database:', error);
    throw new Error('Database Error: Could not fetch request by request_id.');
  }
}

module.exports = {
  createBirthchartRequest,
  findByRequestId,
};
