//index.js

const express = require('express');
const cors = require('./middlewares/cors');
const birthchartRouter = require('./routes/birthchart.route');
const mpWebhookRouter = require('./routes/webhook/mercadopago');

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
