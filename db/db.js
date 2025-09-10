'use strict';

/**
 * Secure PostgreSQL Pool initialization (with pluggable secret provider)
 * ---------------------------------------------------------------------
 * - Uses DATABASE_URL via secret provider (never read secret directly from env).
 * - TLS/SSL hardened by default in production (configurable).
 * - Sensible timeouts and pool sizing for API workloads.
 * - Session-level guardrails (statement/lock/idle-in-tx timeouts).
 * - Lazy singleton: same facade (query/getClient/end) and eager init (configurable).
 *
 * Env toggles (non-secrets; safe to read directly):
 *   INIT_DB_ON_STARTUP            = true|false (default: true in prod, true here unless set to 'false')
 *   DB_POOL_MAX                   = max pooled clients (default: 10; tune via WEB_CONCURRENCY if present)
 *   DB_POOL_IDLE_TIMEOUT_MS       = idle client timeout (default: 30000)
 *   DB_CONNECT_TIMEOUT_MS         = initial TCP connect timeout (default: 5000)
 *   DB_QUERY_TIMEOUT_MS           = client-side query timeout (default: 25000)
 *   DB_POOL_MAX_USES              = recycle connection after N uses (default: 0 = disabled)
 *   PGSSLMODE                     = disable | require | no-verify  (default: auto)
 *   DB_SSL_REJECT_UNAUTHORIZED    = true|false (overrides when PGSSLMODE not set; default: false on prod hosts)
 *   DB_APP_NAME                   = application_name for PG (default: 'zodika-backend')
 *
 * Notes:
 * - Many managed PG (Railway/Render/etc.) require SSL but without CA chain; for broad compatibility
 *   we default to `rejectUnauthorized:false` in production when no explicit PGSSLMODE is provided.
 * - Prefer setting PGSSLMODE=require + CA bundle when you control the certs.
 */

const { Pool } = require('pg');
const { get: getSecret } = require('../config/secretProvider');
const logger = require('../utils/logger').child('db');

// ------------------------------ helpers ------------------------------

const NODE_ENV = (process.env.NODE_ENV || 'development').toLowerCase();
const isProd = NODE_ENV === 'production';

function toInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function toBool(v, d) {
  if (v == null) return d;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return d;
}

/** Escape value as a safe SQL string literal (single quotes doubled). */
function sqlStringLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Resolve SSL config from env with safe defaults for common managed PG. */
function resolveSslConfig() {
  const mode = (process.env.PGSSLMODE || '').toLowerCase().trim();

  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: true };
  if (mode === 'no-verify' || mode === 'allow' || mode === 'prefer') {
    // 'allow'/'prefer' aren't native here; treat as "encrypt but don't verify"
    return { rejectUnauthorized: false };
  }

  // If not specified: default to secure in prod, but compatible with managed PG (no CA)
  const rejectUnauth = toBool(process.env.DB_SSL_REJECT_UNAUTHORIZED, false);
  return isProd ? { rejectUnauthorized: rejectUnauth } : false;
}

// Derive pool sizing (fallback to WEB_CONCURRENCY heuristic)
function resolvePoolMax() {
  const fromEnv = toInt(process.env.DB_POOL_MAX, NaN);
  if (Number.isFinite(fromEnv)) return fromEnv;
  const wc = toInt(process.env.WEB_CONCURRENCY, NaN);
  // Typical API: 5–10 per dyno; keep conservative default of 10 if nothing set
  if (Number.isFinite(wc) && wc > 0) return Math.min(10 * wc, 50);
  return 10;
}

// --------------------------- Lazy Pool singleton ---------------------------

/** @type {Promise<import('pg').Pool> | null} */
let poolPromise = null;

async function initPool() {
  if (poolPromise) return poolPromise;

  poolPromise = (async () => {
    const connectionString = await getSecret('DATABASE_URL'); // required in prod (secret provider validates)

    // Base pool options
    const pool = new Pool({
      connectionString,
      ssl: resolveSslConfig(),
      max: resolvePoolMax(),
      idleTimeoutMillis: toInt(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30_000),
      connectionTimeoutMillis: toInt(process.env.DB_CONNECT_TIMEOUT_MS, 5_000),
      // client-side timer per query (ms). pg will abort & reject promise.
      query_timeout: toInt(process.env.DB_QUERY_TIMEOUT_MS, 25_000),
      // pg >= 8.11: recycle a client after N uses to avoid long-lived issues (disabled by default)
      maxUses: toInt(process.env.DB_POOL_MAX_USES, 0) || undefined,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      application_name: process.env.DB_APP_NAME || 'zodika-backend',
    });

    // Apply session guardrails on connect (server-side timeouts)
    pool.on('connect', (client) => {
      // These settings are per-connection. Keep values conservative for API workloads.
      const stmTimeoutMs = Math.max(0, toInt(process.env.DB_STATEMENT_TIMEOUT_MS, 20_000)); // server kills long queries
      const lockTimeoutMs = Math.max(0, toInt(process.env.DB_LOCK_TIMEOUT_MS, 10_000));     // wait for locks at most N ms
      const idleTxTimeoutMs = Math.max(0, toInt(process.env.DB_IDLE_IN_TX_TIMEOUT_MS, 15_000)); // kill idle-in-tx sessions
      const appName = process.env.DB_APP_NAME || 'zodika-backend';

      // IMPORTANT: PostgreSQL does not support $-placeholders in SET commands.
      // Use safe literal interpolation for strings and plain numeric literals for timeouts.
      const setSql =
        `SET application_name = ${sqlStringLiteral(appName)}; ` +
        `SET statement_timeout = ${stmTimeoutMs}; ` +
        `SET lock_timeout = ${lockTimeoutMs}; ` +
        `SET idle_in_transaction_session_timeout = ${idleTxTimeoutMs};`;

      client.query(setSql).catch((e) => {
        logger.warn({ msg: 'failed to set session timeouts', err: e.message });
      });
    });

    // Pool-level error handler (idle client errors)
    pool.on('error', (err) => {
      logger.error({ msg: 'unexpected error on idle client', err: err && err.message });
    });

    // Smoke test when we eagerly init (see bottom of file). Keep short timeout to fail fast.
    try {
      const { rows } = await pool.query('SELECT 1 AS ok');
      if (!rows || rows[0]?.ok !== 1) {
        logger.warn('unexpected DB ping result');
      } else {
        logger.info({ max: pool.options?.max }, 'db pool ready');
      }
    } catch (e) {
      logger.error({ msg: 'db ping failed', err: e && e.message });
      throw e;
    }

    return pool;
  })();

  return poolPromise;
}

/**
 * Facade methods (Pool-like)
 * - query(text, params)
 * - getClient() -> PoolClient (remember to release)
 * - end()
 */
async function query(text, params) {
  const pool = await initPool();
  return pool.query(text, params);
}

async function getClient() {
  const pool = await initPool();
  return pool.connect();
}

async function end() {
  const pool = await initPool();
  return pool.end();
}

// Eager init unless explicitly disabled (fail-fast in production)
const eager = process.env.INIT_DB_ON_STARTUP !== 'false';
if (eager) {
  initPool().catch((err) => {
    logger.error({ msg: 'failed to initialize PostgreSQL pool', err: err && err.message });
    if (isProd) process.exit(1);
  });
}

module.exports = {
  query,
  getClient,
  end,
  // Advanced: access the Pool (promise) if you really need it
  _unsafe_getPool: initPool,
};
