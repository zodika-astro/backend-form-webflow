// config/secretProvider.js
'use strict';

/**
 * Pluggable Secret Provider with in-memory cache
 * ----------------------------------------------
 * Default: read from environment variables (and Docker-style *_FILE).
 * Optional adapters (lazy): GCP Secret Manager, AWS Secrets Manager, HashiCorp Vault.
 *
 * Design goals:
 * - Never log secret values.
 * - Safe-by-default in production (required=true, cache with TTL).
 * - Extensible via SECRET_PROVIDER=env|file|gcp|aws|vault|doppler (doppler is a stub).
 * - Prevent thundering herd with in-flight de-duplication.
 *
 * Usage (async):
 *   const { get, getJSON } = require('./secretProvider');
 *   const mpSecret = await get('MP_WEBHOOK_SECRET');     // string
 *   const oauthCfg = await getJSON('OAUTH_CLIENT_JSON'); // parsed object
 */

const fs = require('fs');
const path = require('path');
const { env, isProd } = require('./env');

// Provider selection and knobs (validated in config/env.js)
const PROVIDER = String(env.SECRET_PROVIDER || 'env').toLowerCase();
const DEFAULT_TTL_MS = clampTtl(Number(env.SECRET_CACHE_TTL_MS ?? 5 * 60 * 1000)); // default 5 min
const FILE_DIR = process.env.SECRETS_DIR || '/var/run/secrets';

// In-memory cache: name -> { value, expiresAt }
const cache = new Map();
// In-flight de-dup: name -> Promise<string|undefined|null>
const pending = new Map();
// One-time warnings (avoid log spam)
const warned = new Set();

/* --------------------------------- Utilities -------------------------------- */

function nowMs() { return Date.now(); }

/** Clamp TTL to [0, 24h] to avoid pathological values. */
function clampTtl(v) {
  if (!Number.isFinite(v)) return 5 * 60 * 1000;
  if (v < 0) return 0;
  const DAY = 24 * 60 * 60 * 1000;
  return Math.min(v, DAY);
}

function warnOnce(key, msg, err) {
  if (warned.has(key)) return;
  warned.add(key);
  // NOTE: do not include secret values in logs; only provider/key names.
  // eslint-disable-next-line no-console
  console.warn(`[secretProvider] ${msg}${err ? ` (${err.message || err})` : ''}`);
}

/* ----------------------------------- API ----------------------------------- */

/**
 * Get a secret value as a string.
 * - Cached with TTL.
 * - In production, missing secrets throw by default.
 * - Uses provider resolution with safe fallbacks.
 */
async function get(name, { cacheTtlMs = DEFAULT_TTL_MS, required = isProd } = {}) {
  const ttl = clampTtl(cacheTtlMs);

  // Fresh cache hit
  const hit = cache.get(name);
  const t = nowMs();
  if (hit && hit.expiresAt > t) return hit.value;

  // De-duplicate concurrent lookups
  if (pending.has(name)) {
    return pending.get(name);
  }

  const p = (async () => {
    const value = await resolveSecret(name);

    if ((value == null || value === '') && required) {
      // Keep message generic; do not leak actual values (only key name).
      throw new Error(`Missing required secret: ${name}`);
    }

    cache.set(name, { value, expiresAt: t + ttl });
    return value;
  })();

  pending.set(name, p);

  try {
    const v = await p;
    return v;
  } finally {
    pending.delete(name);
  }
}

/**
 * Get and parse a JSON secret.
 * Returns null for empty/undefined; throws on invalid JSON.
 */
async function getJSON(name, opts) {
  const s = await get(name, opts);
  if (s == null || s === '') return null;
  try {
    return JSON.parse(s);
  } catch {
    throw new Error(`Secret ${name} is not valid JSON`);
  }
}

/** Clear all cached secrets (useful for tests or forced refresh). */
function clearCache() {
  cache.clear();
  pending.clear();
}

/** Warm-up selected secrets (ignore failures). */
async function preloadSecrets(names = []) {
  await Promise.all(names.map((n) => get(n).catch(() => undefined)));
}

/* ------------------------------ Provider switch ----------------------------- */

async function resolveSecret(name) {
  switch (PROVIDER) {
    case 'env':
      return fromEnv(name);
    case 'file':
      return fromFile(name);
    case 'gcp':
      return fromGcp(name);
    case 'aws':
      return fromAws(name);
    case 'vault':
      return fromVault(name);
    case 'doppler':
      warnOnce('doppler', 'Doppler adapter not implemented; falling back to ENV');
      return fromEnv(name);
    default:
      warnOnce('provider', `Unknown SECRET_PROVIDER="${PROVIDER}", falling back to ENV`);
      return fromEnv(name);
  }
}

/* -------------------------------- Providers -------------------------------- */

/**
 * ENV provider (supports Docker/K8s secrets via *_FILE or *__FILE).
 * Reads: process.env.NAME or file pointed by NAME_FILE / NAME__FILE.
 */
function fromEnv(name) {
  let v = process.env[name];

  const fileVar = process.env[`${name}_FILE`] || process.env[`${name}__FILE`];
  if ((v == null || v === '') && fileVar) {
    try {
      v = fs.readFileSync(fileVar, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      warnOnce(`env:${name}`, `Failed reading ${name}_FILE`, err);
    }
  }
  return v;
}

/**
 * FILE provider
 * Reads from a mounted directory (default: /var/run/secrets).
 * The filename is sanitized with basename() to prevent path traversal.
 */
function fromFile(name) {
  try {
    const filename = path.basename(String(name || ''));
    const p = path.join(FILE_DIR, filename);
    return fs.readFileSync(p, 'utf8').replace(/\r?\n$/, '');
  } catch (err) {
    warnOnce(`file:${name}`, `Secret not found in ${FILE_DIR}/${name}`, err);
    return undefined;
  }
}

/**
 * GCP Secret Manager (lazy & optional)
 * Requires: @google-cloud/secret-manager and a service account.
 */
async function fromGcp(name) {
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
    const client = new SecretManagerServiceClient();
    const projectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
    const version = process.env.SECRET_VERSION || 'latest';
    if (!projectId) throw new Error('GCP_PROJECT/GCLOUD_PROJECT not set');
    const resource = `projects/${projectId}/secrets/${name}/versions/${version}`;
    const [resp] = await client.accessSecretVersion({ name: resource });
    return resp.payload.data.toString('utf8');
  } catch (err) {
    warnOnce('gcp', 'GCP Secret Manager not available, falling back to ENV', err);
    return fromEnv(name);
  }
}

/**
 * AWS Secrets Manager (lazy & optional)
 * Requires: @aws-sdk/client-secrets-manager and proper IAM permissions.
 */
async function fromAws(name) {
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({});
    const resp = await client.send(new GetSecretValueCommand({ SecretId: name }));
    if (resp.SecretString) return resp.SecretString;
    if (resp.SecretBinary) return Buffer.from(resp.SecretBinary).toString('utf8');
    return undefined;
  } catch (err) {
    warnOnce('aws', 'AWS Secrets Manager not available, falling back to ENV', err);
    return fromEnv(name);
  }
}

/**
 * HashiCorp Vault (optional; simple KV v2 read via fetch)
 * Requires: VAULT_ADDR, VAULT_TOKEN, VAULT_KV_MOUNT (default: secret)
 */
async function fromVault(name) {
  try {
    const addr = process.env.VAULT_ADDR;
    const token = process.env.VAULT_TOKEN;
    const mount = process.env.VAULT_KV_MOUNT || 'secret';
    if (!addr || !token) throw new Error('VAULT_ADDR/VAULT_TOKEN not set');

    const url = `${addr.replace(/\/$/, '')}/v1/${mount}/data/${encodeURIComponent(name)}`;

    // Use global fetch when available (Node >= 18), otherwise undici.
    const f = (typeof fetch === 'function')
      ? fetch
      // eslint-disable-next-line global-require
      : require('undici').fetch;

    const res = await f(url, {
      method: 'GET',
      headers: { 'X-Vault-Token': token, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`Vault HTTP ${res.status}`);
    const json = await res.json();
    const data = json?.data?.data;
    if (!data) return undefined;

    // Accept either { value: "..." } or { [name]: "..." } or arbitrary object (stringify)
    return typeof data.value === 'string'
      ? data.value
      : (typeof data[name] === 'string' ? data[name] : JSON.stringify(data));
  } catch (err) {
    warnOnce('vault', 'Vault not available, falling back to ENV', err);
    return fromEnv(name);
  }
}

/* ---------------------------------- Exports --------------------------------- */

module.exports = {
  get,
  getJSON,
  preloadSecrets,
  clearCache,
  provider: PROVIDER,
};
