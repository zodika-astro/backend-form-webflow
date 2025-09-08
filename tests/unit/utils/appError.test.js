// tests/unit/utils/appError.test.js
'use strict';

/**
 * Unit tests for utils/appError.js
 * - Validates constructor, safeJSON, and helper mappers for MP & PagBank.
 */

const { AppError } = require('../../../utils/appError');

describe('utils/AppError', () => {
  test('constructs with code/status/message and exposes safeJSON()', () => {
    const err = new AppError('E_TEST', 'Test message', 400, { foo: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('E_TEST');
    expect(err.status).toBe(400);
    expect(err.message).toBe('Test message');

    const safe = err.safeJSON();
    expect(safe).toEqual({
      code: 'E_TEST',
      message: 'Test message',
      status: 400,
      details: { foo: 1 },
    });
  });

  test('wrap() falls back to internal_error on unknown inputs', () => {
    const wrapped = AppError.wrap(new Error('boom'));
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.code).toBe('internal_error');
    expect(wrapped.status).toBe(500);
    const safe = wrapped.safeJSON();
    expect(safe.code).toBe('internal_error');
    expect(safe.status).toBe(500);
  });

  test('fromMPResponse() maps 429 to mp_rate_limited and honors Retry-After', () => {
    const e = {
      message: 'HTTP 429 Too Many Requests',
      response: {
        status: 429,
        headers: { 'retry-after': '5' },
        data: { message: 'Too many requests' },
      },
    };
    const mapped = AppError.fromMPResponse(e, 'creating preference');
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.code).toBe('mp_rate_limited');
    expect(mapped.status).toBe(429);
    expect(mapped.details).toHaveProperty('context', 'creating preference');
    expect(mapped.details).toHaveProperty('retryAfterMs', 5000);
  });

  test('fromMPResponse() maps 400 to mp_invalid_request', () => {
    const e = {
      message: 'HTTP 400 Bad Request',
      response: { status: 400, headers: {}, data: { error: 'invalid_something' } },
    };
    const mapped = AppError.fromMPResponse(e, 'creating preference');
    expect(mapped.code).toBe('mp_invalid_request');
    expect(mapped.status).toBe(400);
  });

  test('fromPagBankResponse() maps 400 to pagbank_invalid_request', () => {
    const e = {
      message: 'HTTP 400 Bad Request',
      response: { status: 400, headers: {}, data: { error_messages: ['x'] } },
    };
    const mapped = AppError.fromPagBankResponse(e, 'creating checkout');
    expect(mapped.code).toBe('pagbank_invalid_request');
    expect(mapped.status).toBe(400);
  });

  test('fromPagBankResponse() maps 503 to pagbank_unavailable', () => {
    const e = {
      message: 'HTTP 503 Service Unavailable',
      response: { status: 503, headers: {}, data: {} },
    };
    const mapped = AppError.fromPagBankResponse(e, 'creating checkout');
    expect(mapped.code).toBe('pagbank_unavailable');
    expect(mapped.status).toBe(503);
  });
});
