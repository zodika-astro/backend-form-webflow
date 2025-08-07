// controllers/birthchart.controller.js
const { birthchartSchema } = require('../schemas/birthchartSchema');
const db = require('../db/db');
const { birthchartcreatePreference } = require('../services/mercadopago.service');

const BirthChartRequest = async (req, res) => {
  try {
    // data validation
    const dataValidated = birthchartSchema.parse(req.body);

    // create form
    const formInsert = await db.query(
      `INSERT INTO pedidos (type, name, social_name, email, birth_date, birth_time, birth_place)
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

    const pedidoId = formInsert.rows[0].id;

    // preferense payments
    const mpData = await createPreference(dataValidated);

    // save answer mercado pago
    await db.query(
      `UPDATE pedidos
       SET mp_preference_id = $1,
           mp_init_point = $2,
           mp_full_response = $3
       WHERE id = $4`,
      [mpData.id, mpData.init_point || mpData.sandbox_init_point, mpData, pedidoId]
    );

    res.json({ url: mpData.init_point || mpData.sandbox_init_point });

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
