'use strict';
/*
 * Authentication helpers.
 *  - Passwords: scrypt (memory-hard, built into Node) with a per-user random salt.
 *  - Sessions: signed JWT stored in an HttpOnly, SameSite=Lax cookie, so JavaScript
 *    (and therefore any XSS) can never read the token.
 */
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const COOKIE = 'taskflow_session';
const SESSION_DAYS = 7;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(actual, expected);
}

function createAuth({ secret, secureCookies }) {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  };

  function parseCookies(header) {
    const out = {};
    String(header || '')
      .split(';')
      .forEach((part) => {
        const i = part.indexOf('=');
        if (i > 0) {
          try {
            out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
          } catch (e) {
            /* ignore malformed cookie */
          }
        }
      });
    return out;
  }

  return {
    issue(res, userId) {
      const token = jwt.sign({ sub: String(userId) }, secret, { expiresIn: SESSION_DAYS + 'd' });
      res.cookie(COOKIE, token, cookieOptions);
    },
    clear(res) {
      res.clearCookie(COOKIE, Object.assign({}, cookieOptions, { maxAge: undefined }));
    },
    /** Express middleware: attaches req.userId or responds 401. */
    require(req, res, next) {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (!token) return res.status(401).json({ error: 'Not signed in.' });
      try {
        const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
        req.userId = Number(payload.sub);
        return next();
      } catch (e) {
        return res.status(401).json({ error: 'Session expired. Please sign in again.' });
      }
    }
  };
}

module.exports = { hashPassword, verifyPassword, createAuth, COOKIE };
