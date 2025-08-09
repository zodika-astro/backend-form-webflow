// caminho: /postgresedit.js (raiz do projeto)
const db = require('./db/db'); // caminho ajustado
const express = require('express');
const router = express.Router();

// GET provisório para executar via navegador
router.get('/postgresedit', async (req, res) => {
  try {
    /** =======================
     * Renomear tabelas
     * ======================= */
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mp_request') THEN
          ALTER TABLE public.mp_request RENAME TO pagseguro_request;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mp_payments') THEN
          ALTER TABLE public.mp_payments RENAME TO pagseguro_payments;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_events') THEN
          ALTER TABLE public.payment_events RENAME TO pagseguro_events;
        END IF;
      END$$;
    `);

    res.json({ message: 'Tabelas renomeadas com sucesso ✅' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao renomear tabelas', details: err.message });
  }
});

module.exports = router;

