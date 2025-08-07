// routes/webhook/mercadopago.js
const express = require('express');
const fetch = require('node-fetch');
const db = require('../../db/db');

const router = express.Router();

/**
 * Mercado Pago → POST /webhook/mercadopago
 * Recebe payload pequeno: { type: "payment", data: { id } }
 * Busca detalhes do pagamento (GET /v1/payments/:id)
 * UPSERT em mp_payments e atualiza o status agregado do "request" correspondente.
 */
router.post('/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body || {};

    // Ignora qualquer coisa que não seja evento de payment
    if (type !== 'payment' || !data?.id) {
      return res.status(200).end();
    }

    const accessToken = process.env.BIRTHMAP_ACCESS_TOKEN;
    if (!accessToken) {
      console.error('[Webhook MP] BIRTHMAP_ACCESS_TOKEN ausente.');
      return res.status(200).end();
    }

    // 1) Busca dados completos do pagamento
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!r.ok) {
      console.error('[Webhook MP] GET /v1/payments falhou:', await r.text());
      return res.status(200).end(); // responde 200 pra não ter retry agressivo
    }

    const payment = await r.json();

    // 2) Identifica request (via external_reference que mandamos na preferência)
    const requestId = Number(payment.external_reference) || null;
    const product = payment?.metadata?.product || null; // 'birth_chart', etc.

    if (!requestId) {
      console.warn('[Webhook MP] Sem external_reference → requestId nulo. payment_id:', payment.id);
      return res.status(200).end();
    }

    // 3) UPSERT em mp_payments por payment_id (idempotente)
    await db.query(`
      INSERT INTO mp_payments (
        birthchart_request_id,
        payment_id,
        status,
        status_detail,
        transaction_amount,
        payment_method_id,
        payment_type_id,
        installment,
        full_webhook_payload,
        received_at,
        product
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10
      )
      ON CONFLICT (payment_id) DO UPDATE SET
        status = EXCLUDED.status,
        status_detail = EXCLUDED.status_detail,
        transaction_amount = EXCLUDED.transaction_amount,
        payment_method_id = EXCLUDED.payment_method_id,
        payment_type_id = EXCLUDED.payment_type_id,
        installment = EXCLUDED.installment,
        full_webhook_payload = EXCLUDED.full_webhook_payload,
        received_at = NOW(),
        product = EXCLUDED.product
    `, [
      requestId,
      String(payment.id),
      payment.status,
      payment.status_detail,
      payment.transaction_amount ?? null,
      payment.payment_method_id ?? null,
      payment.payment_type_id ?? null,
      payment.installments ?? null,
      payment,
      product
    ]);

    // 4) Atualiza status agregado no request (para filtros rápidos)
    if (product === 'birth_chart') {
      await db.query(
        `UPDATE birthchart_request
         SET payment_status = $1, payment_status_updated_at = NOW()
         WHERE id = $2`,
        [payment.status, requestId]
      );
    } else {
      // Aqui você pode tratar outros produtos no futuro (ex.: solar_return_request)
      // Exemplo:
      // if (product === 'solar_return') { UPDATE solar_return_request ... }
    }

    // (Opcional) 5) Disparar integrações externas: Make, e-mail, etc.

    return res.status(200).end();
  } catch (e) {
    console.error('[Webhook MP] Erro inesperado:', e);
    // Sempre 200 para evitar retries infinitos do MP;
    // nossa idempotência está garantida pelo ON CONFLICT (payment_id)
    return res.status(200).end();
  }
});

module.exports = router;
