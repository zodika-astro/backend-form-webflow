// modules/pagbank/repository.js
const db = require('../../../db/db');

async function createPagbankRequest(pagbankResponse) {
  const {
    id,
    reference_id,
    customer,
    charges,
    links
  } = pagbankResponse;

  const link = links.find(l => l.rel === 'PAY')?.href || '';

  const query = `
    INSERT INTO pagbank_request (pagBank_id, request_id, customer, charges, link)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *;
  `;
  const values = [
    id,
    reference_id,
    customer, 
    charges,
    link
  ];

  try {
    const { rows } = await db.query(query, values);
    return rows[0];
  } catch (error) {
    console.error('Database Error: Could not save PagBank request:', error);
    throw new Error('Database Error: Could not save PagBank request.');
  }
}

async function findBirthchartRequestById(requestId) {
  const query = 'SELECT * FROM birthchart_requests WHERE request_id = $1';
  const values = [requestId];

  try {
    const { rows } = await db.query(query, values);
    return rows[0];
  } catch (error) {
    console.error('Database Error: Could not find birthchart request.', error);
    throw new Error('Database Error: Could not find birthchart request.');
  }
}

module.exports = {
  findBirthchartRequestById,
  createPagbankRequest,
};
