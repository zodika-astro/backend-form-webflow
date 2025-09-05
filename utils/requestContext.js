// utils/requestContext.js
'use strict';

/**
 * Request-scoped context using AsyncLocalStorage
 * ----------------------------------------------
 * Purpose
 *  - Keep per-request metadata (e.g., reqId/method/path/ip) available across
 *    async boundaries without threading arguments through every call.
 *
 * How it’s wired
 *  - A small Express middleware (handled separately) will wrap each request with
 *    `runWith({ reqId, method, path, ip }, () => next())`.
 *  - Anywhere in your code, call `get('reqId')` or `getAll()` and include these
 *    fields in your logs/metrics.
 *
 * Design notes
 *  - Zero external deps; works on Node.js >= 16.
 *  - `runWith` inherits the current context by default, so nested calls augment
 *    rather than replace (configurable via { inherit: false }).
 *  - Includes helpers to `bind` callbacks to the current context (useful for
 *    timers/event handlers) and `merge` multiple keys at once.
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/**
 * Run a function within a context.
 * By default, merges with any existing parent context (inherit = true).
 *
 * @param {object} ctx - key/value map to inject (e.g., { reqId })
 * @param {Function} fn - function to execute inside this context
 * @param {object} [opts]
 * @param {boolean} [opts.inherit=true] - if false, do not merge with parent
 * @returns {*} return value of fn
 */
function runWith(ctx, fn, opts = {}) {
  const inherit = opts.inherit !== false;
  const parent = als.getStore();
  const base = inherit && parent ? { ...parent, ...(ctx || {}) } : (ctx || {});
  return als.run(base, fn);
}

/**
 * Set a single key/value on the current context (noop if there is no context).
 * @param {string} key
 * @param {*} value
 */
function set(key, value) {
  const s = als.getStore();
  if (s && key) s[key] = value;
}

/**
 * Merge multiple keys into the current context (noop if none).
 * @param {object} patch - key/value entries to merge
 */
function merge(patch) {
  const s = als.getStore();
  if (s && patch && typeof patch === 'object') Object.assign(s, patch);
}

/**
 * Get a single value from the current context.
 * @param {string} key
 * @returns {*} value or undefined
 */
function get(key) {
  const s = als.getStore();
  return s ? s[key] : undefined;
}

/**
 * Get all context values (returns a frozen empty object when not inside a context).
 * @returns {object}
 */
function getAll() {
  return als.getStore() || {};
}

/**
 * Bind a function to the current context, so when it runs later (e.g., timers,
 * event handlers) it still "sees" the same request context.
 * @param {Function} fn - function to bind
 * @returns {Function} bound function
 */
function bind(fn) {
  const ctx = als.getStore();
  if (!ctx || typeof fn !== 'function') return fn;
  return function boundContextFn(...args) {
    return als.run(ctx, () => fn.apply(this, args));
  };
}

/**
 * (Testing/advanced) Replace the current context within the same tick.
 * Prefer `runWith` in application code. This is handy in unit tests.
 * @param {object} newCtx
 */
function reset(newCtx = {}) {
  // enterWith sets the store for the current synchronous execution context
  if (typeof als.enterWith === 'function') als.enterWith(newCtx || {});
}

module.exports = {
  runWith,
  set,
  merge,
  get,
  getAll,
  bind,
  reset, // primarily for tests
};
