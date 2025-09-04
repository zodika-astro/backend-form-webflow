// tests/unit/middlewares/mpWebhookAuth.test.js
'use strict';

/**
 * Unit test for Mercado Pago webhook auth middleware:
 * - Builds a valid x-signature (HMAC-SHA256) from a minimal payment payload.
 * - Mocks the secret provider and DB (no real DB calls).
 * - Ensures req.body is parsed and req.mpSig is populated.
 * - Ensures next() is always called.
 */

const crypto = require('crypto');

// IMPORTANT: mock the same module paths the middleware uses internally
jest.mock('../../../config/secretProvider', () => ({
  get: jest.fn(async (key) => {
    if (key === 'MP_WEBHOOK_SECRET') return 'super-secret-key';
    throw new Error(`Unexpected secret key: ${key}`);
  }),
}));

jest.mock('../../../db/db', () => ({
  query: jest.fn(async () => ({ rows: [] })), // swallow failure logs
}));

const mpWebhookAuth = require('../../../middlewares/mpWebhookAuth');

function hmacSha256(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function buildReqResNext({ id, xRequestId, tsSec, payload }) {
  const secret = 'super-secret-key';
  const manifest = `id:${id};request-id:${xRequestId};ts:${tsSec};`;
  const v1 = hmacSha256(secret, manifest);

  const headers = {
    host: 'test.local',
    'x-request-id': xRequestId,
    'x-signature': `ts=${tsSec},v1=${v1}`,
    'content-type': 'application/json',
  };

  const raw = Buffer.from(JSON.stringify(payload), 'utf8');

  const req = {
    headers,
    rawBody: raw,
    body: raw, // middleware supports rawBody || body buffer
    header: (name) => headers[String(name).toLowerCase()] || headers[name],
  };

  const res = {};
  const next = jest.fn();

  return { req, res, next, v1 };
}

describe('middlewares/mpWebhookAuth', () => {
  test('accepts a valid signed webhook and populates req.mpSig', async () => {
    const nowSec = Math.floor(Date.now() / 1000);

    const paymentId = '124691940654';
    const payload = { type: 'payment', data: { id: paymentId } }; // minimal shape

    const ctx = buildReqResNext({
      id: paymentId,
      xRequestId: 'abc-123',
      tsSec: String(nowSec),
      payload,
    });

    await mpWebhookAuth(ctx.req, ctx.res, ctx.next);

    expect(ctx.next).toHaveBeenCalledTimes(1);

    // Body should be parsed as JSON
    expect(ctx.req.body).toEqual(payload);

    // Signature context should be present and valid
    expect(ctx.req.mpSig).toBeTruthy();
    expect(ctx.req.mpSig.id).toBe(paymentId);
    expect(ctx.req.mpSig.xRequestId).toBe('abc-123');
    expect(typeof ctx.req.mpSig.ts).toBe('number');
    expect(ctx.req.mpSig.v1).toHaveLength(64); // hex sha256
  });

  test('marks invalid signature as soft-fail but still calls next()', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const paymentId = '9999';
    const payload = { type: 'payment', data: { id: paymentId } };

    // Build valid headers then tamper the signature
    const ctx = buildReqResNext({
      id: paymentId,
      xRequestId: 'req-2',
      tsSec: String(nowSec),
      payload,
    });
    ctx.req.headers['x-signature'] = `ts=${nowSec},v1=deadbeef`; // wrong signature

    await mpWebhookAuth(ctx.req, ctx.res, ctx.next);

    expect(ctx.next).toHaveBeenCalledTimes(1);
    expect(ctx.req.body).toEqual(payload);
    expect(ctx.req.mpSig).toBeTruthy();
    expect(ctx.req.mpSig.verify).toBe('soft-fail');
    expect(ctx.req.mpSig.reason).toBe('invalid_signature');
  });
});
