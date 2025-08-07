// services/birthchartmercadopago.js
const fetch = require('node-fetch');

const birthchartcreatePreference = async (data, { requestId } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const accessToken = process.env.BIRTHMAP_ACCESS_TOKEN;
    if (!accessToken) throw new Error('Mercado Pago Access Token not configured');

    // (opcional) expiração em 24h
    const expiresInMs = 24 * 60 * 60 * 1000;
    const dateOfExpiration = new Date(Date.now() + expiresInMs).toISOString();

    const preference = {
      items: [{
        title: 'mapa natal zodika',
        quantity: 1,
        unit_price: 35.00,
        currency_id: 'BRL',
        // opcional: imagem do produto no checkout
        picture_url: 'https://www.zodika.com.br/assets/mapa-natal.png',
        description: 'Mapa Natal Zodika'
      }],
      payer: {
        name: data.name,
        email: data.email,
      },
      back_urls: {
        success: 'https://www.zodika.com.br/payment-success',
        failure: 'https://www.zodika.com.br/payment-fail',
      },
      auto_return: 'approved',

      // você disse que vai orquestrar no Make por enquanto — mantido
      notification_url: 'https://hook.eu2.make.com/msvmg0kmbwrtqopcgm9k5utu6xdqqg2o',

      // 🔗 vínculo forte com o seu pedido no banco
      external_reference: requestId ? String(requestId) : undefined,

      // dados livres pra relatórios/integrações
      metadata: {
        product: 'birth_chart',
        request_id: requestId ?? null,
        email: data.email,
        source: 'webflow'
      },

      // (opcional) expiração
      expires: true,
      date_of_expiration: dateOfExpiration
    };

    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(preference),
      signal: controller.signal
    });

    clearTimeout(timeout);

    const result = await response.json();
    if (!response.ok) {
      // tenta trazer mais contexto de erro
      const msg = result?.message || result?.error || JSON.stringify(result);
      throw new Error(`Error creating payment preference: ${msg}`);
    }

    return result;

  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
};

module.exports = { birthchartcreatePreference };

