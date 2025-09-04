// utils/requestContext.js
'use strict';

/**
 * Request-scoped context using AsyncLocalStorage
 * ----------------------------------------------
 * Why:
 *  - Keep a correlation-id (reqId) and other per-request metadata available
 *    across async boundaries without threading arguments manually.
 *
 * Usage:
 *  - Wrap each incoming request with `runWith({ reqId }, () => next())`
 *    (we'll do this in a dedicated middleware).
 *  - Anywhere in your code, call `get('reqId')` or `getAll()` to include it in logs.
 *
 * Notes:
 *  - This module has zero external dependencies and works on Node 16+.
 */

const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

/** Run a function within a fresh context object (e.g., { reqId }) */
function runWith(ctx, fn) {
  return store.run(ctx || {}, fn);
}

/** Set a key/value on the current request context (noop if none) */
function set(key, value) {
  const s = store.getStore();
  if (s) s[key] = value;
}

/** Get a single value from the current request context */
function get(key) {
  const s = store.getStore();
  return s ? s[key] : undefined;
}

/** Get the whole context object (returns {} when not inside a context) */
function getAll() {
  return store.getStore() || {};
}

module.exports = { runWith, set, get, getAll };
