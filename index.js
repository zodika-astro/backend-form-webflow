const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS – origens permitidas
const allowedOrigins = ['https://zodika.com.br', 'https://www.zodika.com.br'];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'A política de CORS não permite acesso da origem ' + origin;
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

// Endpoint principal: criação da preferência de pagamento
app.post('/create-preference', async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
    if (!accessToken) {
      console.error('Access Token do Mercado Pago não configurado');
      return res.status(500).json({ error: 'Token do Mercado Pago não configurado' });
    }

    const formData = req.body;
    if (!formData.nome_completo || !formData.email) {
      return res.status(400).json({ error: 'Nome completo e email são obrigatórios' });
    }

    console.log('Dados do formulário recebidos:', formData);

    const paymentPreference = {
      items: [{
        title: 'mapa natal zodika',
        quantity: 1,
        unit_price: 35.00,
        currency_id: 'BRL',
      }],
      payer: {
        name: formData.nome_completo,
        email: formData.email,
      },
      back_urls: {
        success: 'https://www.zodika.com.br/payment-success',
        failure: 'https://www.zodika.com.br/payment-fail',
      },
      auto_return: 'approved',
      notification_url: 'https://hook.eu2.make.com/msvmg0kmbwrtqopcgm9k5utu6xdqqg2o', // ainda necessário para segurança
    };

    console.log('Enviando preferência para o Mercado Pago...');

    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}` // <- CORRETO: template literal
      },
      body: JSON.stringify(paymentPreference),
      signal: controller.signal
    });

    clearTimeout(timeout);
    const mpData = await mpResponse.json();

    if (!mpResponse.ok) {
      throw new Error(`Erro no Mercado Pago: ${mpData.message || JSON.stringify(mpData)}`);
    }

    const checkoutUrl = mpData.init_point || mpData.sandbox_init_point;
    if (!checkoutUrl) {
      throw new Error('URL de pagamento não encontrada na resposta');
    }

    console.log('Preferência criada com sucesso:', mpData.id);

    // ✅ NOVO: Envia os dados para o Make.com em paralelo
    await fetch('https://hook.eu2.make.com/msvmg0kmbwrtqopcgm9k5utu6xdqqg2o', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...formData, // dados do formulário
        preference_id: mpData.id,
        payment_link: checkoutUrl
      })
    });

    // Envia para o front a URL de redirecionamento
    res.json({ url: checkoutUrl });

  } catch (error) {
    clearTimeout(timeout);
    console.error('Erro completo:', error);
    res.status(500).json({
      error: 'Erro ao criar pagamento',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Inicializa o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
