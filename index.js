const express = require('express');
const cors = require('./middlewares/cors');
const birthchartRouter = require('./routes/birthchart.route');
const db = require('./db/db'); // Importa a conexão com o banco

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors);
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Birth chart form route
app.use('/birth-chartendpoint', birthchartRouter);

/**
 * 🔧 Endpoint temporário para criar a nova tabela e excluir a antiga
 * Acesse: https://SEU_BACKEND_URL/dev/create-birthchart-table
 * ⚠️ REMOVER ESSE BLOCO APÓS USO
 */
app.get('/dev/create-birthchart-table', async (req, res) => {
  try {
    // Deleta tabela antiga com nome problemático (precisa de aspas)
    await db.query(`DROP TABLE IF EXISTS "form-mapa-natal"`);

    // Cria nova tabela estruturada
    await db.query(`
      CREATE TABLE birthchart_request (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        social_name TEXT,
        email TEXT NOT NULL,
        birth_date TEXT NOT NULL,
        birth_time TEXT NOT NULL,
        birth_place TEXT NOT NULL,
        mp_preference_id TEXT,
        mp_init_point TEXT,
        mp_full_response JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    res.send('✅ Tabela "form-mapa-natal" deletada e "birthchart_request" criada com sucesso.');
  } catch (error) {
    console.error('Erro ao criar tabela:', error);
    res.status(500).send('Erro ao criar tabela: ' + error.message);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

