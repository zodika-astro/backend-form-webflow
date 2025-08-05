const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração de CORS para origens permitidas
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

// Rota de health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Rota para criar preferência de pagamento
app.post('/create-preference', async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // Timeout de 10 segundos

  try {
    // Validação do token
    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
    if (!accessToken) {
      console.error('Access Token do Mercado Pago não configurado');
      return res.status(500).json({ error: 'Token do Mercado Pago não configurado' });
    }

    // Validação dos dados do formulário
    const formData = req.body;
    if (!formData.nome_completo || !formData.email) {
      return res.status(400).json({ error: 'Nome completo e email são obrigatórios' });
    }

    console.log('Dados recebidos:', formData);

    // Configuração da preferência de pagamento
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
      notification_url: 'https://hook.eu2.make.com/msvmg0kmbwrtqopcgm9k5utu6xdqqg2o',
    };

    console.log('Enviando para Mercado Pago:', paymentPreference);

    // Requisição para a API do Mercado Pago
    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': Bearer ${accessToken}
      },
      body: JSON.stringify(paymentPreference),
      signal: controller.signal
    });

    clearTimeout(timeout);
    const mpData = await mpResponse.json();
    console.log('Resposta do Mercado Pago:', mpData);

    // Tratamento da resposta
    if (!mpResponse.ok) {
      throw new Error(Erro no Mercado Pago: ${mpData.message || JSON.stringify(mpData)});
    }

    const checkoutUrl = mpData.init_point || mpData.sandbox_init_point;
    if (!checkoutUrl) {
      throw new Error('URL de pagamento não encontrada na resposta');
    }

    await fetch('https://hook.eu2.make.com/msvmg0kmbwrtqopcgm9k5utu6xdqqg2o', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
        },
      body: JSON.stringify({
      ...formData, // Dados do formulário
      preference_id: mpData.id, // ID da preferência criada no Mercado Pago
      payment_link: checkoutUrl  // URL do checkout
  })
});

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

// Inicialização do servidor
app.listen(PORT, () => {
  console.log(Servidor rodando na porta ${PORT});
});
