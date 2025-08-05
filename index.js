const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Use CORS to allow Webflow requisitions 
const allowedOrigins = ['https://zodika.com.br', 'https://www.zodika.com.br'];

app.use(cors({
  origin: function (origin, callback) {
    // Permite requisições sem origem (como de clientes REST)
    if (!origin) return callback(null, true);
    // Verifica se a origem está na lista de origens permitidas
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'A política de CORS para este site não permite acesso da origem ' + origin;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));

app.use(express.json());

// API to Create acess
app.post('/create-preference', async (req, res) => {
    try {
        const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
        if (!accessToken) {
            return res.status(500).send('Mercado Pago Access Token not configured.');
        }

        // form data
        const formData = req.body;

        // URL make.com webhook
        const makeWebhookUrl = 'https://hook.eu2.make.com/msvmg0kmbwrtqopcgm9k5utu6xdqqg2o';

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
                success: 'https://www.zodika.com/payment-success', 
                failure: 'https://www.zodika.com/payment-fail', 
            },
            notification_url: `${makeWebhookUrl}?form_data=${encodeURIComponent(JSON.stringify(formData))}`,
            auto_return: 'approved',
        };

        const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(paymentPreference)
        });

        const mpData = await mpResponse.json();

        // Retorna a URL de checkout para o frontend
        if (mpData.init_point) {
            res.json({ url: mpData.init_point });
        } else {
            throw new Error('URL de checkout não encontrada na resposta do Mercado Pago.');
        }

    } catch (error) {
        console.error('Erro na criação da preferência de pagamento:', error);
        res.status(500).send('Erro ao criar preferência de pagamento.');
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
