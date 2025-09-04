'use strict';

/**
 * Structured logger with request correlation
 * -----------------------------------------
 * Features:
 *  - JSON logs in production; pretty logs in development.
 *  - Automatic correlation fields from AsyncLocalStorage (reqId, method, path, ip, durationMs).
 *  - Redaction of sensitive fields (tokens, passwords, signatures, cookies, cards).
 *  - Backwards-compatible API: info/warn/error/debug(...args).
 *  - Namespaced loggers via logger.child('namespace').
 *  - Safe error serialization via logger.logError(err, extra).
 *
 * Environment (optional):
 *  - LOG_LEVEL:  debug | info | warn | error      (default: debug in dev, info in prod)
 *  - LOG_FORMAT: json  | pretty                   (default: json in prod, pretty in dev)
 *  - SERVICE_NAME: string to tag service          (default: 'backend')
 */

const os = require('os');
const { getAll } = require('./requestContext');

const NODE_ENV = (process.env.NODE_ENV || 'development').toLowerCase();
const SERVICE_NAME = process.env.SERVICE_NAME || 'backend';
const isProd = NODE_ENV === 'production';

// Levels & filtering
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const levelFromEnv = (process.env.LOG_LEVEL || (isProd ? 'info' : 'debug')).toLowerCase();
const MIN_LEVEL = LEVELS[levelFromEnv] != null ? LEVELS[levelFromEnv] : LEVELS.info;

// Format
const formatFromEnv = (process.env.LOG_FORMAT || (isProd ? 'json' : 'pretty')).toLowerCase();
const USE_JSON = formatFromEnv === 'json';

// Shallow set of keys to redact (case-insensitive match by path segment)
const REDACT_KEYS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-access-token', 'x-client-secret',
  'access_token', 'refresh_token', 'id_token', 'token', 'secret', 'client_secret', 'api_key', 'apikey',
  'password', 'pwd', 'signature', 'hmac', 'security_code', 'cvv', 'cvc', 'card_number', 'pan', 'card',
  'x-signature',
]);

// Redact helper (deep) with recursion guard
function redact(value, seen = new WeakSet(), depth = 0) {
  if (value == null) return value;
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  const t = typeof value;

  if (t === 'string') {
    // Heuristic: redact obvious bearer/api tokens
    if (/^(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]+$/i.test(value)) return '[REDACTED]';
    return value;
  }
  if (t !== 'object') return value;

  if (seen.has(value)) return '[CYCLE]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(v => redact(v, seen, depth + 1));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const keyLc = String(k).toLowerCase();
    if (REDACT_KEYS.has(keyLc)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v, seen, depth + 1);
    }
  }
  return out;
}

// Error serializer (no stack in prod, stack in dev)
function serializeError(err) {
  if (!err) return null;
  if (err instanceof Error) {
    const base = {
      name: err.name,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.status ? { status: err.status } : {}),
    };
    if (!isProd && err.stack) base.stack = err.stack;
    // Include response info if present (HTTP clients)
    if (err.response) {
      base.response = {
        status: err.response.status,
        headers: redact(err.response.headers),
        data: redact(err.response.data),
      };
    }
    return base;
  }
  // Non-Error thrown
  return redact(err);
}

// Build core fields (timestamp, env, service, hostname, request context)
function coreFields(level) {
  const ctx = getAll() || {};
  return {
    ts: new Date().toISOString(),
    level,
    env: NODE_ENV,
    service: SERVICE_NAME,
    hostname: os.hostname(),
    // Correlation (from AsyncLocalStorage)
    reqId: ctx.reqId,
    method: ctx.method,
    path: ctx.path,
    ip: ctx.ip,
    durationMs: ctx.durationMs,
  };
}

// Normalize variadic args into { msg, extra }
function normalizeArgs(args) {
  if (!args || args.length === 0) return { msg: '', extra: {} };

  // Join all string-like pieces into one message, and merge objects into extra
  const parts = [];
  const extra = {};

  for (const a of args) {
    if (a == null) continue;

    if (a instanceof Error) {
      // Put error summary in msg and full under extra.err
      parts.push(a.message || String(a));
      extra.err = serializeError(a);
      continue;
    }

    const t = typeof a;
    if (t === 'string') {
      parts.push(a);
    } else if (t === 'number' || t === 'boolean') {
      parts.push(String(a));
    } else if (t === 'object') {
      // Merge object fields (redacted copy)
      Object.assign(extra, redact(a));
    } else {
      parts.push(String(a));
    }
  }

  return { msg: parts.join(' ').trim(), extra };
}

function shouldLog(level) {
  const lv = LEVELS[level] ?? LEVELS.info;
  return lv >= MIN_LEVEL;
}

// Emitters
function emitJson(record) {
  try {
    // Avoid circular structures after redact
    // (redact already guards cycles; this is just an extra safety)
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(record));
  } catch {
    // eslint-disable-next-line no-console
    console.log('{"ts":"%s","level":"error","message":"Logger JSON stringify failed"}', new Date().toISOString());
  }
}

function emitPretty(record) {
  const { ts, level, msg, ...rest } = record;
  const head = `[${level.toUpperCase()}] ${ts} ${msg || ''}`.trim();
  // eslint-disable-next-line no-console
  console.log(head);
  const ctx = { ...rest };
  // Hide empty/undefined context lines
  Object.keys(ctx).forEach((k) => (ctx[k] == null || ctx[k] === '') && delete ctx[k]);
  if (Object.keys(ctx).length) {
    // eslint-disable-next-line no-console
    console.log(ctx);
  }
}

function baseLog(ns /* namespace or null */, level, ...args) {
  if (!shouldLog(level)) return;

  const { msg, extra } = normalizeArgs(args);
  const record = {
    ...coreFields(level),
    ...(ns ? { ns } : {}),
    msg,
    ...extra, // user data (already redacted)
  };

  if (USE_JSON) emitJson(record);
  else emitPretty(record);
}

// Public logger
const logger = {
  debug: (...args) => baseLog(null, 'debug', ...args),
  info:  (...args) => baseLog(null, 'info',  ...args),
  warn:  (...args) => baseLog(null, 'warn',  ...args),
  error: (...args) => baseLog(null, 'error', ...args),

  /**
   * child(namespace: string)
   * Returns a namespaced logger that prefixes records with `ns`.
   * Example: const log = logger.child('payments.mp'); log.info('created preference', { id });
   */
  child(ns) {
    const _ns = String(ns || '').trim() || null;
    return {
      debug: (...args) => baseLog(_ns, 'debug', ...args),
      info:  (...args) => baseLog(_ns, 'info',  ...args),
      warn:  (...args) => baseLog(_ns, 'warn',  ...args),
      error: (...args) => baseLog(_ns, 'error', ...args),
      logError(err, extra) {
        const e = serializeError(err);
        if (e) baseLog(_ns, 'error', extra ? { ...redact(extra), err: e } : { err: e });
        else baseLog(_ns, 'error', extra || {});
      },
    };
  },

  /**
   * logError(err: Error, extra?: object)
   * Serializes Error and logs at error level with optional extra fields.
   */
  logError(err, extra) {
    const e = serializeError(err);
    if (e) baseLog(null, 'error', extra ? { ...redact(extra), err: e } : { err: e });
    else baseLog(null, 'error', extra || {});
  },
};

module.exports = logger;
