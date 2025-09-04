'use strict';

/**
 * Stable, machine-readable error codes used across the application.
 * Keep codes lowercase with underscores. Once introduced, avoid renaming
 * to preserve dashboards, alerts, and client-side handling.
 *
 * Grouped by domain for readability. You can safely add new codes over time.
 */
module.exports = {
  /* Generic */
  INTERNAL_ERROR: 'internal_error',
  INVALID_ARGUMENT: 'invalid_argument',
  VALIDATION_FAILED: 'validation_failed',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  TOO_MANY_REQUESTS: 'too_many_requests',
  UPSTREAM_ERROR: 'upstream_error',
  TIMEOUT: 'timeout',
  BAD_GATEWAY: 'bad_gateway',
  SERVICE_UNAVAILABLE: 'service_unavailable',

  /* Webhook / Security */
  WEBHOOK_SIGNATURE_INVALID: 'webhook_signature_invalid',
  WEBHOOK_TIMESTAMP_STALE: 'webhook_timestamp_stale',
  DUPLICATE_REQUEST: 'duplicate_request',

  /* Payments - Mercado Pago */
  MP_CREATE_PREFERENCE_FAILED: 'mp_create_preference_failed',
  MP_FETCH_PAYMENT_FAILED: 'mp_fetch_payment_failed',

  /* Payments - PagBank */
  PB_CREATE_CHECKOUT_FAILED: 'pagbank_create_checkout_failed',
  PB_WEBHOOK_PROCESSING_FAILED: 'pagbank_webhook_processing_failed',
};
