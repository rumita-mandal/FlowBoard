'use strict';
const crypto = require('node:crypto');
const { openDatabase } = require('./db');
const { createApp } = require('./app');

const isProduction = process.env.NODE_ENV === 'production';

function loadConfig() {
  let jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    if (isProduction) {
      console.error('FATAL: JWT_SECRET must be set in production (use a long random string).');
      process.exit(1);
    }
    jwtSecret = crypto.randomBytes(32).toString('hex');
    console.warn('JWT_SECRET not set - using a random one. Sessions will reset on restart.');
  }
  return {
    port: Number(process.env.PORT) || 3000,
    dbPath: process.env.DB_PATH || './data/taskflow.db',
    jwtSecret,
    isProduction,
    secureCookies: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction,
    // Render/Railway/Fly all terminate TLS at a proxy; 1 hop is correct for them.
    trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : isProduction ? 1 : 0,
    authRateLimit: Number(process.env.AUTH_RATE_LIMIT) || 30,
    guestRateLimit: Number(process.env.GUEST_RATE_LIMIT) || 20
  };
}

function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const app = createApp({ db, config });

  const purge = () => {
    const removed = db.purgeGuestsOlderThan(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    if (removed) console.log('Purged ' + removed + ' expired guest account(s).');
  };
  purge();
  const timer = setInterval(purge, 60 * 60 * 1000);
  timer.unref();

  const server = app.listen(config.port, () => {
    console.log('TaskFlow listening on http://localhost:' + config.port + ' (' + (isProduction ? 'production' : 'development') + ')');
  });

  function shutdown(signal) {
    console.log(signal + ' received, shutting down.');
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main();

module.exports = { loadConfig };
