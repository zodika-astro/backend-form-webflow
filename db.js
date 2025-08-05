const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // configure no Railway
  ssl: {
    rejectUnauthorized: false
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params)
};
