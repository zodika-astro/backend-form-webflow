//index.js

const express = require('express');
const cors = require('./middlewares/cors');
const birthchartRouter = require('./routes/birthchart.route');
const mpWebhookRouter = require('./routes/webhook/mercadopago');

// Acesse: GET /dev/migrate-mp-payments-uniq
const db = require('./db/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors);
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Rote birth-chart
app.use('/birth-chartendpoint', birthchartRouter);

// Webhook Mercado Pago
app.use('/webhook', mpWebhookRouter);



// 🔧 MIGRATION DEV: garantir UNIQUE em mp_payments(payment_id)


app.get('/dev/migrate-mp-payments-uniq', async (req, res) => {
  try {
    // 1) Verifica duplicatas que impediriam a UNIQUE
    const dups = await db.query(`
      SELECT payment_id, COUNT(*) AS qty
      FROM mp_payments
      GROUP BY payment_id
      HAVING COUNT(*) > 1
      ORDER BY qty DESC, payment_id
      LIMIT 20
    `);

    if (dups.rows.length > 0) {
      return res.status(409).json({
        error: 'Existem duplicatas em mp_payments.payment_id — remova/ajuste antes de criar UNIQUE.',
        duplicates_example: dups.rows
      });
    }

    // 2) Cria UNIQUE se não existir (pode ser constraint ou index único; qualquer um serve para ON CONFLICT)
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'mp_payments'::regclass
            AND conname = 'uq_mp_payments_payment_id'
        ) THEN
          ALTER TABLE mp_payments
            ADD CONSTRAINT uq_mp_payments_payment_id UNIQUE (payment_id);
        END IF;
      END$$;
    `);

    // 3) Lista índices para conferência
    const idx = await db.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'mp_payments'
      ORDER BY indexname
    `);

    res.json({
      message: 'UNIQUE em mp_payments(payment_id) garantida ✅',
      indexes: idx.rows
    });
  } catch (e) {
    console.error('Migration error:', e);
    res.status(500).json({ error: e.message });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
