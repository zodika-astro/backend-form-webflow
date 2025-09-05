// utils/logger.js
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
 *  - Proper STDERR for warn/error; STDOUT for info/debug (helps log routing on PaaS).
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

// ----------------------------- Levels & filtering -----------------------------
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const levelFromEnv = (process.env.LOG_LEVEL || (isProd ? 'info' : 'debug')).toLowerCase();
const MIN_LEVEL = LEVELS[levelFromEnv] != null ? LEVELS[levelFromEnv] : LEVELS.info;

// ----------------------------- Format selection ------------------------------
const formatFromEnv = (process.env.LOG_FORMAT || (isProd ? 'json' : 'pretty')).toLowerCase();
const USE_JSON = formatFromEnv === 'json';

// ----------------------------- Redaction rules -------------------------------
/**
 * Shallow set of keys to redact (case-insensitive match by object key).
 * NOTE: Keep in sync with middleware sanitizers to avoid leaking secrets.
 */
const REDACT_KEYS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-access-token', 'x-client-secret',
  'access_token', 'refresh_token', 'id_token', 'token', 'secret', 'client_secret', 'api_key', 'apikey',
  'password', 'pwd', 'signature', 'hmac', 'security_code', 'cvv', 'cvc', 'card_number', 'pan', 'card',
  'x-signature', 'x-authenticity-token',
]);

/** Deep redact with recursion guard (keeps structure but replaces sensitive values). */
function redact(value, seen = new WeakSet(), depth = 0) {
  if (value == null) return value;
  if (depth > 8) return '[TRUNCATED_DEPTH]';

  const t = typeof value;

  if (t === 'string') {
    // Heuristic: redact obvious bearer/basic credentials
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
    out[k] = REDACT_KEYS.has(keyLc) ? '[REDACTED]' : redact(v, seen, depth + 1);
  }
  return out;
}

// ----------------------------- Error serialization ---------------------------
/**
 * Safe error serializer:
 *  - Includes name, message, (code/status when present).
 *  - Includes stack only in non-production.
 *  - Serializes HTTP client responses (status/headers/data) with redaction.
 */
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

    // HTTP client style: { response: { status, headers, data } }
    if (err.response) {
      base.response = {
        status: err.response.status,
        headers: redact(err.response.headers),
        data: redact(err.response.data),
      };
    }
    return base;
  }

  // Non-Error thrown values are still redacted
  return redact(err);
}

// ----------------------------- Core fields & stringify ------------------------
/** Build standard fields (timestamp, env, service, hostname, request context). */
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

/** Safe JSON.stringify (handles BigInt & cycles defensively). */
function safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[CYCLE]';
      seen.add(value);
    }
    return value;
  });
}

// ----------------------------- Args normalization ----------------------------
/**
 * Normalize variadic args into { msg, extra }:
 *  - Concatenate string/number/boolean parts into a single message.
 *  - Merge objects into `extra` (after deep redaction).
 *  - Errors go into `extra.err` (serialized).
 */
function normalizeArgs(args) {
  if (!args || args.length === 0) return { msg: '', extra: {} };

  const parts = [];
  const extra = {};

  for (const a of args) {
    if (a == null) continue;

    if (a instanceof Error) {
      parts.push(a.message || String(a));
      extra.err = serializeError(a);
      continue;
    }

    const t = typeof a;
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') {
      parts.push(String(a));
    } else if (t === 'object') {
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

// ----------------------------- Emitters (stdout/stderr) ----------------------
function streamFor(level) {
  if (level === 'error') return console.error;
  if (level === 'warn') return console.warn;
  return console.log; // info/debug
}

function emitJson(level, record) {
  const out = safeStringify(record);
  const outFn = streamFor(level);
  outFn(out);
}

function emitPretty(level, record) {
  const { ts, level: lvl, msg, ...rest } = record;
  const head = `[${String(lvl).toUpperCase()}] ${ts} ${msg || ''}`.trim();
  const outFn = streamFor(level);
  outFn(head);

  // Hide empty/undefined context lines
  const ctx = { ...rest };
  Object.keys(ctx).forEach((k) => (ctx[k] == null || ctx[k] === '') && delete ctx[k]);

  if (Object.keys(ctx).length) {
    outFn(safeStringify(ctx));
  }
}

// ----------------------------- Base logger -----------------------------------
function baseLog(ns /* namespace or null */, level, ...args) {
  if (!shouldLog(level)) return;

  const { msg, extra } = normalizeArgs(args);
  const record = {
    ...coreFields(level),
    ...(ns ? { ns } : {}),
    msg,
    ...extra, // redacted user data
  };

  if (USE_JSON) emitJson(level, record);
  else emitPretty(level, record);
}

// ----------------------------- Public API ------------------------------------
const logger = {
  debug: (...args) => baseLog(null, 'debug', ...args),
  info:  (...args) => baseLog(null, 'info',  ...args),
  warn:  (...args) => baseLog(null, 'warn',  ...args),
  error: (...args) => baseLog(null, 'error', ...args),

  /**
   * child(namespace: string)
   * Returns a namespaced logger that prefixes records with `ns`.
   * Example:
   *   const log = logger.child('payments.mp');
   *   log.info('created preference', { id });
   */
  child(ns) {
    const _ns = String(ns || '').trim() || null;
    const childLogger = {
      debug: (...args) => baseLog(_ns, 'debug', ...args),
      info:  (...args) => baseLog(_ns, 'info',  ...args),
      warn:  (...args) => baseLog(_ns, 'warn',  ...args),
      error: (...args) => baseLog(_ns, 'error', ...args),
      logError(err, extra) {
        const e = serializeError(err);
        if (e) baseLog(_ns, 'error', extra ? { ...redact(extra), err: e } : { err: e });
        else baseLog(_ns, 'error', extra || {});
      },
      // Allow chaining (child('a').child('b') → "a.b")
      child(subNs) {
        const joined = _ns && String(subNs || '').trim()
          ? `${_ns}.${String(subNs).trim()}`
          : (String(subNs || '').trim() || _ns);
        return logger.child(joined);
      },
    };
    return childLogger;
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
