'use strict';

/**
 * AppError
 * ========
 * A lightweight error class for API applications.
 *
 * Goals:
 * - Carry a stable `code` (for dashboards/alerts) and an HTTP `status`.
 * - Optionally attach a `details` object that is SAFE to return to clients.
 * - Provide helpers for common HTTP families and upstream/provider failures.
 *
 * Usage:
 *   throw new AppError(codes.INVALID_ARGUMENT, 'Bad input', 400, { field: 'email' })
 *   throw AppError.badRequest(codes.VALIDATION_FAILED, 'Validation Error', { fieldErrors })
 *   throw AppError.fromUpstream({ provider: 'mercadopago', operation: 'create_preference', upstreamStatus: 503 })
 */

const codes = require('./errorCodes');

/** Clamp arbitrary numbers into a valid HTTP error range. */
function normalizeHttpStatus(n, fallback = 500) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 400) return fallback;
  if (x > 599) return fallback;
  return Math.trunc(x);
}

class AppError extends Error {
  /**
   * @param {string} code - Stable, machine-readable error code.
   * @param {string} message - Human-readable message (safe to show to clients).
   * @param {number} status - HTTP status (4xx/5xx).
   * @param {object} [details] - Optional JSON-safe details for clients/logs.
   */
  constructor(code, message, status = 500, details) {
    super(message || 'Application error');
    this.name = 'AppError';
    this.code = code || codes.INTERNAL_ERROR;
    this.status = normalizeHttpStatus(status, 500);
    if (details && typeof details === 'object') this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  /* --------------- Convenience constructors (HTTP families) --------------- */

  static badRequest(code = codes.INVALID_ARGUMENT, message = 'Bad request', details) {
    return new AppError(code, message, 400, details);
  }

  static unauthorized(code = codes.UNAUTHORIZED, message = 'Unauthorized', details) {
    return new AppError(code, message, 401, details);
  }

  static forbidden(code = codes.FORBIDDEN, message = 'Forbidden', details) {
    return new AppError(code, message, 403, details);
  }

  static notFound(code = codes.NOT_FOUND, message = 'Not found', details) {
    return new AppError(code, message, 404, details);
  }

  static conflict(code = codes.CONFLICT, message = 'Conflict', details) {
    return new AppError(code, message, 409, details);
  }

  static tooManyRequests(code = codes.TOO_MANY_REQUESTS, message = 'Too many requests', details) {
    return new AppError(code, message, 429, details);
  }

  static unprocessableEntity(code = codes.VALIDATION_FAILED, message = 'Unprocessable entity', details) {
    return new AppError(code, message, 422, details);
  }

  static internal(message = 'Internal server error', details) {
    return new AppError(codes.INTERNAL_ERROR, message, 500, details);
  }

  static badGateway(message = 'Bad gateway', details) {
    return new AppError(codes.BAD_GATEWAY, message, 502, details);
  }

  static serviceUnavailable(message = 'Service unavailable', details) {
    return new AppError(codes.SERVICE_UNAVAILABLE, message, 503, details);
  }

  static gatewayTimeout(message = 'Gateway timeout', details) {
    return new AppError(codes.TIMEOUT, message, 504, details);
  }

  /* ------------------- Helpers for common application cases ------------------- */

  /**
   * Wrap validation errors (e.g., Zod/Joi) into a consistent 400 response.
   * @param {object} details - Typically { fieldErrors, formErrors } or similar.
   */
  static fromValidation(details) {
    return AppError.badRequest(codes.VALIDATION_FAILED, 'Validation Error', details);
  }

  /**
   * Build an AppError from an upstream/third-party failure (PSPs, HTTP APIs, etc.).
   * We map upstream 4xx → 400, 5xx → 502 (Bad Gateway). Missing/unknown → 502.
   *
   * @param {object} opts
   * @param {'mercadopago'|'pagbank'|string} opts.provider
   * @param {string} opts.operation - Short operation id (e.g., 'create_preference').
   * @param {number} [opts.upstreamStatus] - HTTP status from the provider (if any).
   * @param {string} [opts.message] - Optional message override.
   * @param {object} [opts.details] - Extra safe details for diagnostics.
   */
  static fromUpstream({ provider, operation, upstreamStatus, message, details }) {
    // Select a specific code when we recognize provider + operation; fall back to generic.
    const pickCode = () => {
      const p = String(provider || '').toLowerCase();
      const op = String(operation || '').toLowerCase();
      if (p === 'mercadopago' && op === 'create_preference') return codes.MP_CREATE_PREFERENCE_FAILED;
      if (p === 'mercadopago' && op === 'get_payment') return codes.MP_FETCH_PAYMENT_FAILED;
      if (p === 'pagbank' && op === 'create_checkout') return codes.PB_CREATE_CHECKOUT_FAILED;
      return codes.UPSTREAM_ERROR;
    };

    // Map upstream status into a client-facing status.
    // - 5xx from provider → 502
    // - 4xx from provider → 400
    // - Missing/invalid → 502
    let status = 502;
    if (Number.isInteger(upstreamStatus)) {
      status = upstreamStatus >= 500 ? 502 : 400;
    }

    return new AppError(
      pickCode(),
      message || 'Upstream provider error',
      status,
      {
        provider: provider || null,
        operation: operation || null,
        upstream_status: upstreamStatus ?? null,
        ...(details && typeof details === 'object' ? details : {}),
      }
    );
  }

  /**
   * Type guard: check if an unknown error looks like an AppError.
   * Useful in catch blocks when mixed error types are possible.
   */
  static isAppError(err) {
    return !!(err && typeof err === 'object' && 'code' in err && 'status' in err);
  }
}

/* Export both the class and the code catalog for convenience. */
module.exports = { AppError, codes };
