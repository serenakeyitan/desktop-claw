/**
 * Logger — suppresses console output in production builds.
 *
 * Usage:  const log = require('./logger');
 *         log('hello');        // like console.log
 *         log.warn('uh oh');   // like console.warn
 *         log.error('bad');    // console.error — ALWAYS printed (even in prod)
 */

let _isDev = null;

function isDev() {
  if (_isDev !== null) return _isDev;
  if (process.env.ELECTRON_IS_DEV || process.env.NODE_ENV === 'development') {
    _isDev = true;
    return true;
  }
  try {
    _isDev = !require('electron').app.isPackaged;
  } catch {
    _isDev = true; // fallback: assume dev if electron isn't ready yet
  }
  return _isDev;
}

function log(...args) {
  if (isDev()) console.log(...args);
}

log.warn = function (...args) {
  if (isDev()) console.warn(...args);
};

// Errors always print — needed for crash diagnostics
log.error = function (...args) {
  console.error(...args);
};

module.exports = log;
