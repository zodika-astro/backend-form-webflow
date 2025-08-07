// services/birthchartmercadopago.js
const fetch = require('node-fetch');

const birthchartcreatePreference = async (data) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const accessToken = process.env.BIRTHMAP_ACCESS_TOKEN;
    if (!accessToken) throw new Error('Mercado Pago Access Token not configured');

    const preference = {
      items: [{
        title: 'mapa natal zodika',
        quantity: 1,
        unit_price: 35.00,
        currency_id: 'BRL',
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
      notification_url: 'https://hook.eu2.make.com/msvmg0kmbwrtqopcgm9k5utu6xdqqg2o',
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
    if (!response.ok) throw new Error(result.message || 'Error creating payment preference');

    return result;

  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
};

module.exports = { birthchartcreatePreference };
