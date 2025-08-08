// routes/postgresedit.js
const db = require('./db/db'); // conexão com Postgres
const express = require('express');
const router = express.Router();

router.post('/postgresedit', async (req, res) => {
  try {
    /** =======================
     * birthchart_requests
     * ======================= */
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

    await db.query(`
      ALTER TABLE public.birthchart_requests
      ALTER COLUMN birth_time TYPE TIME USING birth_time::TIME;
    `);

    await db.query(`
      ALTER TABLE public.birthchart_requests
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
      ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN created_at SET NOT NULL;
    `);

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

    await db.query(`
      ALTER TABLE public.birthchart_requests
      ALTER COLUMN product_type SET DEFAULT 'birth_chart';
    `);

    await db.query(`
      ALTER SEQUENCE birthchart_requests_request_id_seq1 RESTART WITH 1000;
    `);

    /** =======================
     * mp_request
     * ======================= */
    await db.query(`
      ALTER TABLE public.mp_request
      ALTER COLUMN mp_request_id TYPE TEXT,
      ALTER COLUMN mp_request_id DROP DEFAULT;
    `);

    await db.query(`
      DROP SEQUENCE IF EXISTS mp_request_mp_request_id_seq;
    `);

    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_name='mp_request' AND constraint_type='PRIMARY KEY'
        ) THEN
          ALTER TABLE public.mp_request ADD CONSTRAINT mp_request_pk PRIMARY KEY (mp_request_id);
        END IF;
      END$$;
    `);

    await db.query(`
      ALTER TABLE public.mp_request
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
      ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN created_at SET NOT NULL;
    `);

    /** =======================
     * mp_payments
     * ======================= */
    await db.query(`
      ALTER TABLE public.mp_payments
      ALTER COLUMN payment_id TYPE TEXT,
      ALTER COLUMN payment_id DROP DEFAULT;
    `);

    await db.query(`
      DROP SEQUENCE IF EXISTS mp_payments_payment_id_seq;
    `);

    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_name='mp_payments' AND constraint_type='PRIMARY KEY'
        ) THEN
          ALTER TABLE public.mp_payments ADD CONSTRAINT mp_payments_pk PRIMARY KEY (payment_id);
        END IF;
      END$$;
    `);

    await db.query(`
      ALTER TABLE public.mp_payments
      ALTER COLUMN transaction_amount TYPE NUMERIC(10,2) USING transaction_amount::NUMERIC,
      ALTER COLUMN date_created TYPE TIMESTAMPTZ USING date_created::timestamptz,
      ALTER COLUMN date_approved TYPE TIMESTAMPTZ USING date_approved::timestamptz,
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz,
      ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN created_at SET NOT NULL,
      ALTER COLUMN updated_at SET DEFAULT now(),
      ALTER COLUMN updated_at SET NOT NULL;
    `);

    res.json({ message: 'Alterações aplicadas com sucesso em todas as tabelas ✅' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao aplicar alterações no banco', details: err.message });
  }
});

module.exports = router;
