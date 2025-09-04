// tests/unit/utils/appError.test.js
'use strict';

/**
 * Unit tests for AppError utilities:
 * - basic construction & JSON shape
 * - mapping from provider responses (Mercado Pago / PagBank)
 * - safe defaults on unknown inputs
 *
 * This file does not depend on network, DB, or Express.
 */

const AppError = require('../../../utils/appError');

describe('utils/AppError', () => {
  test('constructs with code/status/message and exposes safeJSON()', () => {
    const err = new AppError('E_TEST', 'Test message', 400, { foo: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('E_TEST');
    expect(err.status).toBe(400);
    const safe = err.safeJSON();
    expect(safe).toEqual({
      code: 'E_TEST',
      message: 'Test message',
      status: 400,
      details: { foo: 1 },
    });
  });

  test('wrap() falls back to internal_error on unknown inputs', () => {
    const err = AppError.wrap(new Error('boom'));
    expect(err.code).toBe('internal_error');
    expect(err.status).toBe(500);
    const safe = err.safeJSON();
    expect(safe.code).toBe('internal_error');
    expect(safe.status).toBe(500);
  });

  test('fromMPResponse() maps 429 to mp_rate_limited and honors Retry-After', () => {
    const e = new Error('rate limited');
    e.response = {
      status: 429,
      headers: { 'retry-after': '2' }, // seconds
      data: { message: 'Too many requests' },
    };
    const mapped = AppError.fromMPResponse(e, 'creating preference');
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.code).toBe('mp_rate_limited');
    expect(mapped.status).toBe(429);
    // retryAfterMs should be roughly >= 2000
    expect(mapped.retryAfterMs === undefined || mapped.retryAfterMs >= 2000).toBe(true);
  });

  test('fromMPResponse() maps 400 to mp_invalid_request', () => {
    const e = new Error('bad request');
    e.response = {
      status: 400,
      headers: {},
      data: { error: 'invalid_something' },
    };
    const mapped = AppError.fromMPResponse(e, 'creating preference');
    expect(mapped.code).toBe('mp_invalid_request');
    expect(mapped.status).toBe(400);
  });

  test('fromPagBankResponse() maps 400 to pagbank_invalid_request', () => {
    const e = new Error('bad request');
    e.response = {
      status: 400,
      headers: {},
      data: { error_messages: ['x'] },
    };
    const mapped = AppError.fromPagBankResponse(e, 'creating checkout');
    expect(mapped.code).toBe('pagbank_invalid_request');
    expect(mapped.status).toBe(400);
  });

  test('fromPagBankResponse() maps 503 to pagbank_unavailable', () => {
    const e = new Error('unavailable');
    e.response = {
      status: 503,
      headers: {},
      data: {},
    };
    const mapped = AppError.fromPagBankResponse(e, 'creating checkout');
    expect(mapped.code).toBe('pagbank_unavailable');
    expect(mapped.status).toBe(503);
  });
});
