// controllers/birthchart.controller.js
const fetch = require('node-fetch');
const { birthchartSchema } = require('../schemas/birthchartSchema');
const db = require('../db/db');
const { birthchartcreatePreference } = require('../services/birthchartmercadopago');

const BirthChartRequest = async (req, res) => {
  try {
    // 1) Validação
    const dataValidated = birthchartSchema.parse(req.body);

    // 2) Salva dados do formulário
    const formInsert = await db.query(
      `INSERT INTO birthchart_request (type, name, social_name, email, birth_date, birth_time, birth_place)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        'birth_chart',
        dataValidated.name,
        dataValidated.social_name || null,
        dataValidated.email,
        dataValidated.birth_date,
        dataValidated.birth_time,
        dataValidated.birth_place
      ]
    );

    const requestId = formInsert.rows[0].id;

    // 3) Cria preferência no Mercado Pago (passando requestId)
    const mpData = await birthchartcreatePreference(dataValidated, { requestId });
    const initPoint = mpData.init_point || mpData.sandbox_init_point;

    if (!mpData?.id || !initPoint) {
      throw new Error('Mercado Pago não retornou preference_id ou init_point.');
    }

    // 4) (Opcional) GET da preferência p/ enriquecer dados
    let fullPreferenceData = mpData;
    try {
      const accessToken = process.env.BIRTHMAP_ACCESS_TOKEN;
      if (!accessToken) {
        console.warn('BIRTHMAP_ACCESS_TOKEN ausente — usando mpData sem GET de preferência.');
      } else {
        const prefResp = await fetch(
          `https://api.mercadopago.com/checkout/preferences/${mpData.id}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        // Se o GET falhar, seguimos com mpData mesmo
        if (prefResp.ok) {
          fullPreferenceData = await prefResp.json();
        } else {
          console.warn('GET /checkout/preferences falhou; usando mpData original.');
        }
      }
    } catch (e) {
      console.warn('Falha ao enriquecer preferência (GET):', e.message);
    }

    // 5) Salva a preferência (AGORA em mp_preferences, não mais em birthchart_request)
    await db.query(
      `INSERT INTO mp_preferences (
         birthchart_request_id,
         mp_preference_id,
         mp_init_point,
         mp_full_response
       ) VALUES ($1, $2, $3, $4)`,
      [
        requestId,
        mpData.id,
        initPoint,
        fullPreferenceData
      ]
    );

    // 6) Responde com a URL de checkout
    res.json({ url: initPoint });

  } catch (error) {
    if (error.name === 'ZodError') {
      console.error('Validation error:', error.issues);
      return res.status(400).json({
        error: 'Invalid form data.',
        details: error.issues
      });
    }

    console.error('Unexpected error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
};

module.exports = { BirthChartRequest };
