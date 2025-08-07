//index.js

const express = require('express');
const cors = require('./middlewares/cors');
const birthchartRouter = require('./routes/birthchart.route');
const mpWebhookRouter = require('./routes/webhook/mercadopago');
const db = require('./db/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors);
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Rote birth-chart
app.use('/birth-chartendpoint', birthchartRouter);

// Webhook do Mercado Pago
app.use('/webhook', mpWebhookRouter);

app.get('/dev/migrate-mp-payments-uniq', async (req, res) => {
  try {
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'uq_mp_payments_payment_id'
        ) THEN
          ALTER TABLE mp_payments
            ADD CONSTRAINT uq_mp_payments_payment_id UNIQUE (payment_id);
        END IF;
      END$$;
    `);
    res.send('✅ Unique em mp_payments(payment_id) garantido');
  } catch (e) {
    res.status(500).send('Erro na migration: ' + e.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
