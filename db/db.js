// db/db.js
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

module.exports = db;

