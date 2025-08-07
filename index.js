//index.js

const express = require('express');
const cors = require('./middlewares/cors');
const birthchartRouter = require('./routes/birthchart.route');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors);
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Rote birth-chart
app.use('/birth-chartendpoint', birthchartRouter);

// index.js (provisório)
app.get('/dev/set-sequence-birthchart', async (req, res) => {
  try {
    await db.query(`
      ALTER SEQUENCE birthchart_request_id_seq RESTART WITH 1001;
    `);
    res.send('Sequência do ID atualizada para começar do 1001');
  } catch (error) {
    console.error('Erro ao atualizar sequência:', error);
    res.status(500).send('Erro ao atualizar sequência: ' + error.message);
  }
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
