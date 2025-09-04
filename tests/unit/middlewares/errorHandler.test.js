// tests/unit/middlewares/errorHandler.test.js
'use strict';

/**
 * Unit tests for the global error handler middleware:
 * - Honors AppError (status/code/message).
 * - Falls back to { status:500, code:'internal_error' } for generic errors.
 * - Sets X-Request-Id when available.
 * - Emits structured logs via req.log.error (we stub it).
 *
 * NOTE: NODE_ENV is typically 'test' here, so stack MAY be included;
 * we don't strictly assert on stack content to avoid flakiness.
 */

const errorHandler = require('../../../middlewares/errorHandler');
const AppError = require('../../../utils/appError');

function stubRes() {
  const out = {
    statusCode: undefined,
    headers: {},
    body: undefined,
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return out;
}

describe('middlewares/errorHandler', () => {
  test('responds with AppError details and sets X-Request-Id', () => {
    const err = new AppError('E_DEMO', 'Demo failure', 422, { hint: 'x' });

    const req = {
      method: 'POST',
      originalUrl: '/demo',
      requestId: 'rid-123',
      log: { child: () => ({ error: jest.fn() }) },
    };
    const res = stubRes();
    const next = jest.fn();

    errorHandler(err, req, res, next);

    expect(res.statusCode).toBe(422);
    expect(res.headers['X-Request-Id']).toBe('rid-123');

    expect(res.body).toBeDefined();
    expect(res.body.error).toEqual(
      expect.objectContaining({
        code: 'E_DEMO',
        message: 'Demo failure',
        request_id: 'rid-123',
      })
    );
  });

  test('falls back to internal_error (500) on generic errors', () => {
    const err = new Error('Boom');

    const req = {
      method: 'GET',
      originalUrl: '/x',
      requestId: 'rid-999',
      log: { child: () => ({ error: jest.fn() }) },
    };
    const res = stubRes();
    const next = jest.fn();

    errorHandler(err, req, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.headers['X-Request-Id']).toBe('rid-999');

    expect(res.body.error.code).toBe('internal_error');
    expect(typeof res.body.error.message).toBe('string');
    // stack may be present in non-production; do not strictly assert.
  });

  test('logs via req.log.error (stubbed)', () => {
    const innerLogger = { error: jest.fn() };
    const req = {
      method: 'GET',
      originalUrl: '/y',
      requestId: 'rid-777',
      log: { child: () => innerLogger },
    };
    const res = stubRes();
    const next = jest.fn();

    errorHandler(new Error('nope'), req, res, next);

    expect(innerLogger.error).toHaveBeenCalledTimes(1);
    const call = innerLogger.error.mock.calls[0];
    // First arg should be a structured object; second a short message string.
    expect(typeof call[0]).toBe('object');
    expect(typeof call[1]).toBe('string');
  });
});
