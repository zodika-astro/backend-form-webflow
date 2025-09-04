// utils/appError.js
'use strict';

/**
 * AppError
 * --------
 * Error de domínio com:
 *  - code  (obrigatório, p/ métricas & alertas)
 *  - status (HTTP)
 *  - details (payload seguro p/ cliente)
 *  - cause  (erro original p/ logs internos)
 */
class AppError extends Error {
  constructor(code, message, { status = 400, details, cause } = {}) {
    super(message || String(code || 'Error'));
    this.name = 'AppError';
    this.code = code || 'unknown';
    this.status = status;
    if (details !== undefined) this.details = details;
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.details && typeof this.details === 'object') out.details = this.details;
    return out;
  }
}

/** Fábrica simples. */
function err(code, message, opts) {
  return new AppError(code, message, opts);
}

/** Assertivo: lança AppError quando `cond` é falso. */
function assert(cond, code, message, opts) {
  if (!cond) throw err(code, message, opts);
}

/** Converte/encapsula qualquer erro em AppError padronizado. */
function from(code, e, { status = 500, message, details } = {}) {
  return new AppError(code, message || e?.message || 'Internal error', {
    status,
    details,
    cause: e,
  });
}

module.exports = { AppError, err, assert, from };
