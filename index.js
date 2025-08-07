//index.js

const express = require('express');
const cors = require('./middlewares/cors');
const birthchartRouter = require('./routes/birthchart.route');
const db = require('./db/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors);
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Rote birth-chart
app.use('/birth-chartendpoint', birthchartRouter);

// Descobre a sequência do id da tabela e reinicia em 1001
app.get('/dev/set-sequence-birthchart', async (req, res) => {
  try {
    // Descobre o nome da sequência associada a birthchart_request.id
    const seqResult = await db.query(
      `SELECT pg_get_serial_sequence('birthchart_request', 'id') AS seq`
    );

    const seqName = seqResult.rows[0]?.seq;
    if (!seqName) {
      return res.status(400).send("Não foi possível localizar a sequência de 'birthchart_request.id'.");
    }

    // Reinicia a sequência para 1001 (próximo INSERT vira 1001)
    await db.query(`ALTER SEQUENCE ${seqName} RESTART WITH 1001;`);

    res.send(`Sequência ${seqName} atualizada para começar do 1001 ✅`);
  } catch (error) {
    console.error('Erro ao atualizar sequência:', error);
    res.status(500).send('Erro ao atualizar sequência: ' + error.message);
  }
});



app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
