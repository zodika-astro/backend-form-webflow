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

module.exports = {
  createBirthchartRequest,
};
