// ... (código anterior permanece o mesmo)

app.post('/create-preference', async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

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

    console.log('Dados recebidos:', formData);

    // Preparar metadata com todos os dados do formulário
    const metadata = {
      customer_data: {
        name: formData.nome_completo,
        "social-name": formData.nome_social,
        email: formData.email,
        "birth-date": formData.data_nascimento,
        "birth-time": formData.hora_nascimento,
        "birth-place": formData.cidade_nascimento,
        // Adicione outros campos conforme necessário
      }
    };

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
      metadata: metadata // Adiciona os metadados aqui
    };

    console.log('Enviando para Mercado Pago:', paymentPreference);

    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(paymentPreference),
      signal: controller.signal
    });

    // ... (restante do código permanece igual)
