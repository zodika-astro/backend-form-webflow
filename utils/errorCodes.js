// utils/errorCodes.js
'use strict';

/**
 * Canonical error codes (stable, kebab/dot case).
 * Regra: domínio.subdomínio.motivo
 * - Curto, estável, sem IDs sensíveis.
 * - Usado para métricas, alertas e dashboards.
 */
const codes = Object.freeze({
  // Form & validações
  form: {
    birthchart: {
      validation_failed: 'form.birthchart.validation_failed',
    },
  },

  // Pagamentos
  payments: {
    mp: {
      checkout_failed: 'payments.mp.checkout_failed',
      payment_fetch_failed: 'payments.mp.payment_fetch_failed',
      webhook_process_failed: 'payments.mp.webhook_process_failed',
    },
    pagbank: {
      checkout_failed: 'payments.pagbank.checkout_failed',
      webhook_process_failed: 'payments.pagbank.webhook_process_failed',
    },
  },

  // Webhooks (comum)
  webhook: {
    invalid_signature: 'webhook.invalid_signature',
    invalid_ts: 'webhook.invalid_ts',
    stale_or_future_ts: 'webhook.stale_or_future_ts',
    duplicate_request_id: 'webhook.duplicate_request_id',
    bad_signature_format: 'webhook.bad_signature_format',
    middleware_exception: 'webhook.middleware_exception',
  },

  // Autorização básica
  auth: {
    referer_forbidden: 'auth.referer_forbidden',
    origin_forbidden: 'auth.origin_forbidden',
  },

  // Infraestrutura
  infra: {
    http_timeout: 'infra.http.timeout',
    http_error: 'infra.http.error',
    db_error: 'infra.db.error',
    db_conflict: 'infra.db.conflict',
  },

  // Observabilidade
  observability: {
    healthcheck_failed: 'observability.healthcheck_failed',
  },

  // Fallback
  unknown: 'unknown',
});

module.exports = { codes };
