const express = require('express');
const cors = require('./middlewares/cors');
const mapanatalRouter = require('./routes/mapanatal.route');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors);
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Rote birth-chart
app.use('/birth-chartendpoint', mapanatalRouter);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
