//index.js

const express = require('express');
const cors = require('./middlewares/cors');
const birthchartRouter = require('./routes/birthchart.route');
const mpWebhookRouter = require('./routes/webhook/mercadopago');

const db = require('../db'); // seu arquivo de conexão com o Postgres

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




//__________________________________________________________________//
//==================================================================//
// routes/postgresedit.js


router.post('/postgresedit', async (req, res) => {
  try {
    // 1. Renomear coluna "created_at " (com espaço) para "created_at"
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name='birthchart_requests' AND column_name='created_at '
        ) THEN
          ALTER TABLE public.birthchart_requests RENAME COLUMN "created_at " TO created_at;
        END IF;
      END$$;
    `);

    // 2. Ajustar tipo da coluna birth_time para TIME
    await db.query(`
      ALTER TABLE public.birthchart_requests
      ALTER COLUMN birth_time TYPE TIME USING birth_time::TIME;
    `);

    

    // 3. Garantir que created_at seja TIMESTAMPTZ DEFAULT now()
    await db.query(`
      ALTER TABLE public.birthchart_requests
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
      ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN created_at SET NOT NULL;
    `);

    // 4. Adicionar updated_at se não existir
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name='birthchart_requests' AND column_name='updated_at'
        ) THEN
          ALTER TABLE public.birthchart_requests ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now() NOT NULL;
        END IF;
      END$$;
    `);

    // 5. Garantir default do product_type
    await db.query(`
      ALTER TABLE public.birthchart_requests
      ALTER COLUMN product_type SET DEFAULT 'birth_chart';
    `);

    // 6. Ajustar sequência para iniciar em 1000
    await db.query(`
      ALTER SEQUENCE birthchart_requests_request_id_seq1 RESTART WITH 1000;
    `);


    res.json({ message: 'Alterações aplicadas com sucesso na tabela birthchart_requests ✅' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao aplicar alterações no banco', details: err.message });
  }
});

module.exports = router;




//===================================================================//
//__________________________________________________________________//






app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
