'use strict';
/*
 * Express application factory. Takes its dependencies (db, config) as arguments so tests can
 * spin up an isolated instance with an in-memory database.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { hashPassword, verifyPassword, createAuth } = require('./auth');
// The very same validation module that runs in the browser. One source of truth for the rules.
const L = require('../public/src/store.js');

const MAX_TASKS_PER_USER = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLIENT_ID_RE = /^[a-z0-9]{6,40}$/;
const EDITABLE = ['title', 'description', 'priority', 'status', 'due', 'tags'];
// Burned once at startup so unknown-email logins cost the same as real ones (no user enumeration by timing).
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return L.todayString(d);
}

function seedTasks() {
  return [
    { title: 'Welcome to TaskFlow 👋', description: 'Drag cards between columns, or use the arrow buttons on each card.', priority: 'medium', status: 'todo', tags: 'welcome' },
    { title: 'Design database schema', description: 'Draft tables for users, projects and tasks.', priority: 'high', status: 'todo', due: addDays(2), tags: 'backend, planning' },
    { title: 'Fix login redirect bug', description: 'Users land on a blank page after OAuth callback.', priority: 'high', status: 'doing', due: addDays(-1), tags: 'bug, auth' },
    { title: 'Write unit tests for API', priority: 'medium', status: 'doing', due: addDays(5), tags: 'testing' },
    { title: 'Set up CI pipeline', description: 'Run lint and tests on every pull request.', priority: 'low', status: 'done', tags: 'devops' },
    { title: 'Create project README', priority: 'low', status: 'done', tags: 'docs' }
  ].map((s) => L.createTask(s));
}

function createApp({ db, config }) {
  const app = express();
  const auth = createAuth({ secret: config.jwtSecret, secureCookies: config.secureCookies });

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'upgrade-insecure-requests': null // would break plain-http localhost in Safari
        }
      }
    })
  );
  app.use(express.json({ limit: '1mb' }));

  /* ---------- CSRF defence in depth (cookie is already SameSite=Lax) ---------- */
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try {
        host = new URL(origin).host;
      } catch (e) {
        /* fall through to rejection */
      }
      if (host !== req.headers.host) return next(new HttpError(403, 'Cross-origin request blocked.'));
    }
    return next();
  });

  /* ---------- health ---------- */
  app.get(['/healthz', '/api/health'], (req, res) => {
    db.raw.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  /* ---------- auth ---------- */
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.authRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again in a few minutes.' }
  });
  const guestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: config.guestRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many demo sessions from this address. Please try again later.' }
  });

  function readCredentials(body) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    return { email, password };
  }

  function startSession(res, userId, status) {
    auth.issue(res, userId);
    const user = db.findUserById(userId);
    res.status(status).json({ user: { id: user.id, email: user.email, guest: Boolean(user.is_guest) } });
  }

  app.post('/api/auth/register', authLimiter, (req, res) => {
    const { email, password } = readCredentials(req.body || {});
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8–128 characters.');
    if (db.findUserByEmail(email)) throw new HttpError(409, 'An account with that email already exists.');
    const userId = db.createUser(email, hashPassword(password), false);
    db.appendTasks(userId, seedTasks());
    startSession(res, userId, 201);
  });

  app.post('/api/auth/login', authLimiter, (req, res) => {
    const { email, password } = readCredentials(req.body || {});
    const user = email ? db.findUserByEmail(email) : null;
    const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'Incorrect email or password.');
    startSession(res, user.id, 200);
  });

  // One-click demo account so reviewers don't have to sign up. Purged automatically (see index.js).
  app.post('/api/auth/guest', guestLimiter, (req, res) => {
    const email = 'guest-' + crypto.randomBytes(6).toString('hex') + '@guest.taskflow.local';
    const userId = db.createUser(email, hashPassword(crypto.randomBytes(24).toString('hex')), true);
    db.appendTasks(userId, seedTasks());
    startSession(res, userId, 201);
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.clear(res);
    res.status(204).end();
  });

  app.get('/api/auth/me', auth.require, (req, res) => {
    const user = db.findUserById(req.userId);
    if (!user) {
      auth.clear(res);
      throw new HttpError(401, 'Account no longer exists.');
    }
    res.json({ user: { id: user.id, email: user.email, guest: Boolean(user.is_guest) } });
  });

  /* ---------- tasks (all routes are scoped to the signed-in user) ---------- */
  const tasks = express.Router();
  tasks.use(auth.require);

  tasks.get('/', (req, res) => {
    res.json({ tasks: db.listTasks(req.userId) });
  });

  tasks.post('/', (req, res) => {
    if (db.countTasks(req.userId) >= MAX_TASKS_PER_USER) {
      throw new HttpError(409, 'Task limit reached (' + MAX_TASKS_PER_USER + ').');
    }
    const body = req.body || {};
    const check = L.validateTask(body);
    if (!check.valid) throw new HttpError(400, check.errors.join(' '));
    const task = L.createTask(body);
    // Clients generate ids so the UI can be optimistic; accept them only if well-formed.
    if (typeof body.id === 'string' && CLIENT_ID_RE.test(body.id)) {
      if (db.getTask(req.userId, body.id)) throw new HttpError(409, 'A task with that id already exists.');
      task.id = body.id;
    }
    db.appendTask(req.userId, task);
    res.status(201).json({ task });
  });

  // Registered before '/:id' so "order" and "import" are not treated as ids.
  tasks.put('/order', (req, res) => {
    const items = req.body && req.body.tasks;
    if (!Array.isArray(items)) throw new HttpError(400, 'Body must be { tasks: [{ id, status }] }.');
    const current = db.listTasks(req.userId);
    const byId = new Map(current.map((t) => [t.id, t]));
    const seen = new Set();
    const now = new Date().toISOString();
    const normalised = items.map((it) => {
      if (!it || typeof it.id !== 'string' || L.STATUSES.indexOf(it.status) === -1) {
        throw new HttpError(400, 'Each item needs a valid id and status.');
      }
      if (seen.has(it.id)) throw new HttpError(400, 'Duplicate id in order list.');
      seen.add(it.id);
      const existing = byId.get(it.id);
      if (!existing) throw new HttpError(409, 'Board is out of date. Reload to continue.');
      const completedAt = it.status === 'done' ? existing.completedAt || now : null;
      return { id: it.id, status: it.status, completedAt };
    });
    if (normalised.length !== current.length) throw new HttpError(409, 'Board is out of date. Reload to continue.');
    db.applyOrder(req.userId, normalised);
    res.json({ tasks: db.listTasks(req.userId) });
  });

  tasks.post('/import', (req, res) => {
    const list = req.body && req.body.tasks;
    if (!Array.isArray(list)) throw new HttpError(400, 'Body must be { tasks: [...] }.');
    let result;
    try {
      result = L.importTasks(JSON.stringify(list));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const room = MAX_TASKS_PER_USER - db.countTasks(req.userId);
    if (result.tasks.length > room) {
      throw new HttpError(409, 'Import would exceed the ' + MAX_TASKS_PER_USER + ' task limit.');
    }
    const fresh = result.tasks.map((t) => (db.getTask(req.userId, t.id) ? Object.assign({}, t, { id: L.uid() }) : t));
    db.appendTasks(req.userId, fresh);
    res.status(201).json({ imported: fresh.length, skipped: result.skipped, tasks: db.listTasks(req.userId) });
  });

  tasks.patch('/:id', (req, res) => {
    const existing = db.getTask(req.userId, req.params.id);
    if (!existing) throw new HttpError(404, 'Task not found.');
    const changes = {};
    EDITABLE.forEach((k) => {
      if (req.body && req.body[k] !== undefined) changes[k] = req.body[k];
    });
    let updated;
    try {
      updated = L.updateTask([existing], existing.id, changes)[0];
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    db.saveTask(req.userId, updated);
    res.json({ task: updated });
  });

  tasks.delete('/:id', (req, res) => {
    if (!db.removeTask(req.userId, req.params.id)) throw new HttpError(404, 'Task not found.');
    res.status(204).end();
  });

  app.use('/api/tasks', tasks);

  /* ---------- static client ---------- */
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Unknown API route.')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProduction ? '5m' : 0 }));

  /* ---------- errors ---------- */
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side.' });
  });

  return app;
}

module.exports = { createApp, HttpError };
