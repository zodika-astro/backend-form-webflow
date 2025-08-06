const { Pool } = require('pg');

// Configuração da conexão com o banco de dados PostgreSQL do Railway
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Exporta a função de consulta para ser usada em outros arquivos
module.exports = {
  query: (text, params) => pool.query(text, params)
};
