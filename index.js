const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS – origens permitidas
const allowedOrigins = ['https://zodika.com.br', 'https://www.zodika.com.br'];

// body
const { z } = require('zod');

// (req.body)
const natalSchema = z.object({
    name: z.string().min(3, 'name must have 3 caractheres.'),
    social_name: z.string().optional(), 
    email: z.string().email('email format not valid.'),
    birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date format not valid. use YYYY-MM-DD.'),
    birth_time: z.string().regex(/^\d{2}:\d{2}$/, 'time format not valid. use HH:MM'),
    birth_place: z.string().min(2, 'city must have 2 caractheres')
});

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'CORS policy does not allow access from origin ' + origin;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// main end-point

app.post('/create-preference', async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
    if (!accessToken) {
      console.error('Mercado Pago Access Token not configured');
      return res.status(500).json({ error: 'Mercado Pago token not configured' });
    }

    const dataValidated = natalSchema.parse(req.body);

    const paymentPreference = {
      items: [{
        title: 'mapa natal zodika',
        quantity: 1,
        unit_price: 35.00,
        currency_id: 'BRL',
      }],
      payer: {
        name: dataValidated.name,
        email: dataValidated.email,
      },
      back_urls: {
        success: 'https://www.zodika.com.br/payment-success',
        failure: 'https://www.zodika.com.br/payment-fail',
      },
      auto_return: 'approved',
      notification_url: 'https://hook.eu2.make.com/msvmg0kmbwrtqopcgm9k5utu6xdqqg2o',
    };

    console.log('Sending preference to Mercado Pago...');

    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}` // 
      },
      body: JSON.stringify(paymentPreference),
      signal: controller.signal
    });

    clearTimeout(timeout);
    const mpData = await mpResponse.json();

    if (!mpResponse.ok) {
      throw new Error(`Error in Mercado Pago: ${mpData.message || JSON.stringify(mpData)}`);
    }

    const checkoutUrl = mpData.init_point || mpData.sandbox_init_point;
    if (!checkoutUrl) {
      throw new Error('Payment URL not found in response');
    }

    console.log('Preference created successfully:', mpData.id);

    // Sends redirect URL to frontend
    res.json({ url: checkoutUrl });

  } 
  
  catch (error) {
    clearTimeout(timeout);
    if (error instanceof z.ZodError) {
      console.error('erro de validação:', error.issues);
      return res.status(400).json({
          error: 'os dados do formulário são inválidos. entre em contato com: contato@zodika.com.br',
          detalhes: error.issues
      });
     }  
    console.error('Errors:', error);
    res.status(500).json({
      error: 'Error creating payment',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
  }
});

// start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
