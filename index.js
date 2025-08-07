// index.js
const express = require('express');
const cors = require('./middlewares/cors');
const birthchartRouter = require('./routes/birthchart.route');
const db = require('./db/db'); // <-- precisa importar pra rodar os SQLs

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors);
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Rota birth-chart (seu endpoint de produção)
app.use('/birth-chartendpoint', birthchartRouter);

/**
 * 🔧 ENDPOINT TEMPORÁRIO:
 * Cria do zero as três tabelas na estrutura nova (e apaga as antigas relacionadas).
 * Acesse: https://SEU_BACKEND/dev/create-birthchart-tables
 * ⚠️ APAGUE ESTE BLOCO DEPOIS QUE EXECUTAR COM SUCESSO!
 */
app.get('/dev/create-birthchart-tables', async (req, res) => {
  try {
    // Apaga em ordem (filhas primeiro, por FK)
    await db.query(`DROP TABLE IF EXISTS mp_payments CASCADE;`);
    await db.query(`DROP TABLE IF EXISTS mp_preferences CASCADE;`);
    await db.query(`DROP TABLE IF EXISTS birthchart_request CASCADE;`);

    // birthchart_request (dados do formulário)
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // mp_preferences (1:1 com request)
    await db.query(`
      CREATE TABLE mp_preferences (
        id SERIAL PRIMARY KEY,
        birthchart_request_id INTEGER NOT NULL REFERENCES birthchart_request(id) ON DELETE CASCADE,
        mp_preference_id TEXT NOT NULL,
        mp_init_point TEXT NOT NULL,
        mp_full_response JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // mp_payments (1:N por request)
    await db.query(`
      CREATE TABLE mp_payments (
        id SERIAL PRIMARY KEY,
        birthchart_request_id INTEGER NOT NULL REFERENCES birthchart_request(id) ON DELETE CASCADE,
        payment_id TEXT NOT NULL,
        status TEXT,
        status_detail TEXT,
        transaction_amount NUMERIC(10,2),
        payment_method_id TEXT,
        payment_type_id TEXT,
        installment INTEGER,
        full_webhook_payload JSONB,
        received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    res.send('✅ Tabelas recriadas com sucesso!');
  } catch (error) {
    console.error('Erro ao criar tabelas:', error);
    res.status(500).send('Erro ao criar tabelas: ' + error.message);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
