// db/db.js
'use strict';

/**
 * Secure PostgreSQL Pool initialization
 *
 * This module centralizes the connection to PostgreSQL with a security-first SSL setup.
 * It removes the insecure `rejectUnauthorized: false` default and makes TLS behavior
 * explicitly configurable via environment variables.
 *
 * ENVIRONMENT VARIABLES (recommended):
 * - DATABASE_URL          : Full Postgres connection string.
 * - NODE_ENV              : 'production' | 'development' | 'test'
 *
 * - DB_SSL_MODE           : One of:
 *     - 'disable'    -> No TLS (ONLY for local dev against a local DB).
 *     - 'no-verify'  -> TLS without server cert verification (NOT recommended; NEVER in prod).
 *     - 'verify-ca'  -> TLS with server cert verification (recommended).
 *     - 'verify-full'-> TLS with verification (same as verify-ca for node-postgres).
 *   If not set, defaults to:
 *     - 'verify-full' in production
 *     - 'disable'     in non-production
 *
 * - PGSSL_ROOTCERT       : Absolute path to a PEM-encoded CA bundle (optional but recommended if your provider uses a custom CA).
 * - PGSSL_CA_BASE64      : Base64-encoded CA bundle (alternative to PGSSL_ROOTCERT).
 * - PGSSL_CERT           : Absolute path to client certificate (optional; mutual TLS scenarios).
 * - PGSSL_KEY            : Absolute path to client private key (optional; mutual TLS scenarios).
 *
 * Notes:
 * - Using 'no-verify' weakens TLS and exposes you to MITM risks. Avoid it in production.
 * - If your provider uses a publicly trusted CA, verification works without providing a custom CA.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/** @returns {false | import('tls').ConnectionOptions} */
function buildSslConfig() {
  const isProd = process.env.NODE_ENV === 'production';
  const rawMode = (process.env.DB_SSL_MODE || (isProd ? 'verify-full' : 'disable')).toLowerCase();

  // Normalize some common synonyms to our internal set
  const mode = ({
    require: 'verify-full',   // people sometimes set "require" expecting TLS with verification
    verified: 'verify-full',
    'verify': 'verify-full',
    'verify_ca': 'verify-ca',
    'verify-full': 'verify-full',
    'verify-ca': 'verify-ca',
    'no-verify': 'no-verify',
    'disable': 'disable',
  })[rawMode] || rawMode;

  if (mode === 'disable') {
    if (isProd) {
      // Hard warning in production; prefer to fail fast rather than silently downgrade security
      // If you truly need to disable TLS in prod (not recommended), set DB_SSL_MODE=disable intentionally.
      // eslint-disable-next-line no-console
      console.warn('[DB][WARN] DB_SSL_MODE=disable in production. This is strongly discouraged.');
    }
    return false; // No TLS
  }

  if (mode === 'no-verify') {
    if (isProd) {
      // eslint-disable-next-line no-console
      console.warn('[DB][WARN] DB_SSL_MODE=no-verify in production. This weakens TLS (rejectUnauthorized=false) and is NOT recommended.');
    }
    // TLS without server certificate verification (NOT recommended)
    return { rejectUnauthorized: false };
  }

  // Secure modes: verify-ca / verify-full
  /** @type {import('tls').ConnectionOptions} */
  const ssl = { rejectUnauthorized: true };

  // Optional CA injection via file path or base64
  const caPath = process.env.PGSSL_ROOTCERT;
  const caB64 = process.env.PGSSL_CA_BASE64;

  if (caPath) {
    try {
      const absolute = path.isAbsolute(caPath) ? caPath : path.join(process.cwd(), caPath);
      ssl.ca = fs.readFileSync(absolute, 'utf8');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[DB][WARN] Failed to read PGSSL_ROOTCERT at "${caPath}": ${err.message}`);
    }
  } else if (caB64) {
    try {
      ssl.ca = Buffer.from(caB64, 'base64').toString('utf8');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[DB][WARN] Failed to decode PGSSL_CA_BASE64:', err.message);
    }
  }

  // Optional mutual TLS (rare for Postgres; left here for completeness)
  const clientCertPath = process.env.PGSSL_CERT;
  const clientKeyPath = process.env.PGSSL_KEY;

  if (clientCertPath && clientKeyPath) {
    try {
      const certAbs = path.isAbsolute(clientCertPath) ? clientCertPath : path.join(process.cwd(), clientCertPath);
      const keyAbs = path.isAbsolute(clientKeyPath) ? clientKeyPath : path.join(process.cwd(), clientKeyPath);
      ssl.cert = fs.readFileSync(certAbs, 'utf8');
      ssl.key = fs.readFileSync(keyAbs, 'utf8');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[DB][WARN] Failed to read client cert/key for mutual TLS:', err.message);
    }
  }

  return ssl;
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // In secure modes this is an object with rejectUnauthorized=true (and optional CA);
  // in local development it can be set to false (no TLS) by DB_SSL_MODE=disable.
  ssl: buildSslConfig(),
  // Optional: identify this application to the DB (helps in logs/monitoring)
  application_name: process.env.PG_APP_NAME || 'backend-form-webflow',
  // Optional safety: keep statements from hanging forever (tune to your infra)
  statement_timeout: process.env.PG_STATEMENT_TIMEOUT ? Number(process.env.PG_STATEMENT_TIMEOUT) : undefined,
  query_timeout: process.env.PG_QUERY_TIMEOUT ? Number(process.env.PG_QUERY_TIMEOUT) : undefined,
});

module.exports = db;
