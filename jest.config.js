// jest.config.js
'use strict';

/**
 * Jest config — minimal and production-friendly.
 * - Test runner: Node (no JSDOM).
 * - Discovers tests under /tests.
 * - Collects coverage from core code (excludes routers/repos by default).
 */
module.exports = {
  testEnvironment: 'node',
  verbose: true,
  roots: ['<rootDir>/tests'],
  collectCoverageFrom: [
    'modules/**/*.js',
    'payments/**/*.js',
    'utils/**/*.js',
    'middlewares/**/*.js',
    '!**/router*.js',
    '!**/repository.js',
  ],
  coverageDirectory: 'coverage',
};
