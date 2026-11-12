'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');

const config = {
  jwtSecret: 'test-secret-test-secret-test-secret',
  isProduction: false,
  secureCookies: false,
  trustProxy: 0,
  authRateLimit: 1000,
  guestRateLimit: 1000
};

async function start(overrides) {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: Object.assign({}, config, overrides) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  return { db, base, close: () => new Promise((r) => server.close(() => { db.close(); r(); })) };
}

/** Minimal cookie-aware client. */
function client(base) {
  let cookie = '';
  async function call(method, path, body, headers) {
    const res = await fetch(base + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json', Cookie: cookie }, headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.getSetCookie();
    if (set.length) {
      const first = set[0].split(';')[0];
      cookie = first.endsWith('=') ? '' : first;
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }
  return { call, get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b, h), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

async function signedIn(base, email) {
  const c = client(base);
  const res = await c.post('/api/auth/register', { email: email || 'a@example.com', password: 'correct horse' });
  assert.equal(res.status, 201);
  return c;
}

test('health check works without auth', async () => {
  const s = await start();
  const res = await client(s.base).get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  await s.close();
});

test('security headers are present and CSP forbids inline scripts', async () => {
  const s = await start();
  const res = await fetch(s.base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
  await s.close();
});

test('register seeds a board, sets an HttpOnly cookie and never leaks the hash', async () => {
  const s = await start();
  const c = client(s.base);
  const res = await c.post('/api/auth/register', { email: '  Me@Example.com ', password: 'correct horse' });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'me@example.com');
  assert.equal(JSON.stringify(res.body).includes('hash'), false);
  assert.match(res.headers.getSetCookie()[0], /HttpOnly/i);
  assert.match(res.headers.getSetCookie()[0], /SameSite=Lax/i);
  const list = await c.get('/api/tasks');
  assert.equal(list.body.tasks.length, 6);
  await s.close();
});

test('register validates input and rejects duplicates', async () => {
  const s = await start();
  const c = client(s.base);
  assert.equal((await c.post('/api/auth/register', { email: 'nope', password: 'correct horse' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { email: 'a@b.co', password: 'short' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { email: 'a@b.co', password: 'correct horse' })).status, 201);
  assert.equal((await client(s.base).post('/api/auth/register', { email: 'A@B.co', password: 'correct horse' })).status, 409);
  await s.close();
});

test('login succeeds with the right password and fails otherwise', async () => {
  const s = await start();
  await signedIn(s.base, 'login@example.com');
  const bad = await client(s.base).post('/api/auth/login', { email: 'login@example.com', password: 'wrong password' });
  assert.equal(bad.status, 401);
  const unknown = await client(s.base).post('/api/auth/login', { email: 'ghost@example.com', password: 'wrong password' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, bad.body.error);
  const good = client(s.base);
  assert.equal((await good.post('/api/auth/login', { email: 'login@example.com', password: 'correct horse' })).status, 200);
  assert.equal((await good.get('/api/auth/me')).body.user.email, 'login@example.com');
  await s.close();
});

test('protected routes require a session; logout ends it', async () => {
  const s = await start();
  assert.equal((await client(s.base).get('/api/tasks')).status, 401);
  const c = await signedIn(s.base);
  assert.equal((await c.get('/api/tasks')).status, 200);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/tasks')).status, 401);
  await s.close();
});

test('a forged or tampered token is rejected', async () => {
  const s = await start();
  const res = await fetch(s.base + '/api/tasks', { headers: { Cookie: 'taskflow_session=abc.def.ghi' } });
  assert.equal(res.status, 401);
  await s.close();
});

test('guest demo accounts work and are purgeable', async () => {
  const s = await start();
  const c = client(s.base);
  const res = await c.post('/api/auth/guest', {});
  assert.equal(res.status, 201);
  assert.equal(res.body.user.guest, true);
  assert.equal((await c.get('/api/tasks')).body.tasks.length, 6);
  assert.equal(s.db.purgeGuestsOlderThan(new Date(Date.now() + 1000).toISOString()), 1);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  await s.close();
});

test('task CRUD round-trip', async () => {
  const s = await start();
  const c = await signedIn(s.base);

  const created = await c.post('/api/tasks', { title: '  Ship it ', priority: 'high', tags: 'Release, release, QA' });
  assert.equal(created.status, 201);
  assert.equal(created.body.task.title, 'Ship it');
  assert.deepEqual(created.body.task.tags, ['release', 'qa']);
  const id = created.body.task.id;

  const patched = await c.patch('/api/tasks/' + id, { status: 'done', title: 'Shipped' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.task.status, 'done');
  assert.ok(patched.body.task.completedAt);

  const list = await c.get('/api/tasks');
  assert.equal(list.body.tasks[list.body.tasks.length - 1].title, 'Shipped');

  assert.equal((await c.del('/api/tasks/' + id)).status, 204);
  assert.equal((await c.del('/api/tasks/' + id)).status, 404);
  await s.close();
});

test('validation errors come back as 400 with a message', async () => {
  const s = await start();
  const c = await signedIn(s.base);
  const empty = await c.post('/api/tasks', { title: '   ' });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /Title is required/);
  const badPriority = await c.post('/api/tasks', { title: 'x', priority: 'urgent' });
  assert.equal(badPriority.status, 400);
  const created = await c.post('/api/tasks', { title: 'ok' });
  const badPatch = await c.patch('/api/tasks/' + created.body.task.id, { due: '2026-02-31' });
  assert.equal(badPatch.status, 400);
  await s.close();
});

test('client-supplied ids are honoured when well-formed and must be unique', async () => {
  const s = await start();
  const c = await signedIn(s.base);
  const a = await c.post('/api/tasks', { id: 'abc123xyz', title: 'one' });
  assert.equal(a.body.task.id, 'abc123xyz');
  assert.equal((await c.post('/api/tasks', { id: 'abc123xyz', title: 'dup' })).status, 409);
  const weird = await c.post('/api/tasks', { id: "x'; DROP TABLE tasks;--", title: 'two' });
  assert.equal(weird.status, 201);
  assert.notEqual(weird.body.task.id, "x'; DROP TABLE tasks;--");
  await s.close();
});

test('users can never read or modify each other\'s tasks', async () => {
  const s = await start();
  const alice = await signedIn(s.base, 'alice@example.com');
  const bob = await signedIn(s.base, 'bob@example.com');
  const t = await alice.post('/api/tasks', { title: 'alice private' });
  const id = t.body.task.id;
  assert.equal((await bob.patch('/api/tasks/' + id, { title: 'hacked' })).status, 404);
  assert.equal((await bob.del('/api/tasks/' + id)).status, 404);
  const bobsList = await bob.get('/api/tasks');
  assert.equal(bobsList.body.tasks.some((x) => x.id === id), false);
  const aliceList = await alice.get('/api/tasks');
  assert.equal(aliceList.body.tasks.find((x) => x.id === id).title, 'alice private');
  await s.close();
});

test('reorder moves tasks across columns and persists order', async () => {
  const s = await start();
  const c = await signedIn(s.base);
  const { tasks } = (await c.get('/api/tasks')).body;
  const reversed = tasks.slice().reverse().map((t) => ({ id: t.id, status: 'done' }));
  const res = await c.put('/api/tasks/order', { tasks: reversed });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.tasks.map((t) => t.id), reversed.map((t) => t.id));
  assert.ok(res.body.tasks.every((t) => t.status === 'done' && t.completedAt));

  const back = await c.put('/api/tasks/order', { tasks: reversed.map((t) => ({ id: t.id, status: 'todo' })) });
  assert.ok(back.body.tasks.every((t) => t.status === 'todo' && t.completedAt === null));
  await s.close();
});

test('reorder rejects stale, duplicate or foreign ids', async () => {
  const s = await start();
  const c = await signedIn(s.base);
  const { tasks } = (await c.get('/api/tasks')).body;
  const items = tasks.map((t) => ({ id: t.id, status: t.status }));
  assert.equal((await c.put('/api/tasks/order', { tasks: items.slice(1) })).status, 409);
  assert.equal((await c.put('/api/tasks/order', { tasks: items.concat([{ id: 'nope', status: 'todo' }]) })).status, 409);
  assert.equal((await c.put('/api/tasks/order', { tasks: [items[0], items[0]] })).status, 400);
  assert.equal((await c.put('/api/tasks/order', { tasks: [{ id: items[0].id, status: 'bogus' }] })).status, 400);
  assert.equal((await c.put('/api/tasks/order', {})).status, 400);
  await s.close();
});

test('import skips invalid rows, keeps valid ones and re-ids collisions', async () => {
  const s = await start();
  const c = await signedIn(s.base);
  const before = (await c.get('/api/tasks')).body.tasks;
  const res = await c.post('/api/tasks/import', {
    tasks: [{ id: before[0].id, title: 'collides' }, { title: '' }, 'junk', { title: 'fine', status: 'doing' }]
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.imported, 2);
  assert.equal(res.body.skipped, 2);
  assert.equal(res.body.tasks.length, before.length + 2);
  assert.equal(new Set(res.body.tasks.map((t) => t.id)).size, res.body.tasks.length);
  await s.close();
});

test('cross-origin writes are blocked', async () => {
  const s = await start();
  const c = await signedIn(s.base);
  const res = await c.post('/api/tasks', { title: 'csrf' }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  await s.close();
});

test('malformed JSON and unknown routes return JSON errors', async () => {
  const s = await start();
  const res = await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Malformed JSON body.');
  assert.equal((await client(s.base).get('/api/nothing')).status, 404);
  await s.close();
});

test('auth endpoints are rate limited', async () => {
  const s = await start({ authRateLimit: 3 });
  const c = client(s.base);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await c.post('/api/auth/login', { email: 'x@y.co', password: 'whatever1' })).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  await s.close();
});
