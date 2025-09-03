'use strict';

/**
 * Secure PostgreSQL Pool initialization (with pluggable secret provider)
 * ---------------------------------------------------------------------
 * - Creates the Pool using a DATABASE_URL fetched via `config/secretProvider`.
 * - App code never reads secrets directly from process.env.
 * - Exports a Pool-like facade with `query()`, `getClient()`, and `end()` that
 * lazily initializes the underlying Pool once (and caches it).
 *
 * Behavior on startup:
 * - We proactively initialize the Pool on module load (fail-fast in prod).
 * - You can disable eager init by setting INIT_DB_ON_STARTUP=false (it will
 * still initialize on first query).
 *
 */

const { Pool } = require('pg');
const { get: getSecret } = require('../config/secretProvider'); // <-- secrets come from the provider

// --------------------------- Lazy Pool singleton ---------------------------

/** @type {Promise<import('pg').Pool> | null} */
let poolPromise = null;

/**
 * Initialize (or reuse) the singleton Pool.
 * Reads DATABASE_URL from the secret provider (cached by the provider).
 */
async function initPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const connectionString = await getSecret('DATABASE_URL'); // REQUIRED in production
      const pool = new Pool({
        connectionString,
      });

      // Optional: surface pool errors (helps diagnosing stale DNS/TLS issues)
      pool.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error('[DB][POOL] Unexpected error on idle client:', err.message);
      });

      return pool;
    })();
  }
  return poolPromise;
}

/**
 * Facade: exposes Pool-like methods while ensuring initialization.
 * - query(text, params)
 * - getClient() -> PoolClient
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

// Eagerly initialize on startup unless explicitly disabled
if (process.env.INIT_DB_ON_STARTUP !== 'false') {
  // Fire-and-forget: fail fast in production if DATABASE_URL/SSL is invalid
  initPool().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[DB][FATAL] Failed to initialize PostgreSQL pool:', err && err.message ? err.message : err);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  });
}

module.exports = {
  // Pool-like API
  query,
  getClient,
  end,

  // Advanced (rarely needed): get the actual Pool instance
  // Usage: const pool = await db._unsafe_getPool();
  _unsafe_getPool: initPool,
};
