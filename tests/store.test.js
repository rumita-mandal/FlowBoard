'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/src/store.js');

const NOW = new Date('2026-11-12T10:00:00.000Z');

function make(over) {
  return L.createTask(Object.assign({ title: 'Task' }, over || {}), NOW);
}

function fixture() {
  const a = Object.assign(make({ title: 'A', status: 'todo' }), { id: 'a' });
  const b = Object.assign(make({ title: 'B', status: 'todo' }), { id: 'b' });
  const c = Object.assign(make({ title: 'C', status: 'doing' }), { id: 'c' });
  const d = Object.assign(make({ title: 'D', status: 'done' }), { id: 'd' });
  return [a, b, c, d];
}

test('parseTags lowercases, trims, dedupes and caps', () => {
  assert.deepEqual(L.parseTags(' Bug, UI ,bug,, '), ['bug', 'ui']);
  assert.deepEqual(L.parseTags('a,b,c,d,e,f,g'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(L.parseTags(undefined), []);
  assert.equal(L.parseTags('x'.repeat(50))[0].length, L.LIMITS.tagLength);
});

test('isValidDateString accepts real dates only', () => {
  assert.equal(L.isValidDateString('2026-02-28'), true);
  assert.equal(L.isValidDateString('2028-02-29'), true);
  assert.equal(L.isValidDateString('2026-02-30'), false);
  assert.equal(L.isValidDateString('2026-13-01'), false);
  assert.equal(L.isValidDateString('12/11/2026'), false);
  assert.equal(L.isValidDateString(20261112), false);
});

test('todayString uses local date parts with zero padding', () => {
  assert.equal(L.todayString(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(L.todayString(new Date(2026, 10, 12)), '2026-11-12');
});

test('validateTask applies defaults and reports errors', () => {
  const ok = L.validateTask({ title: '  Hello  ' });
  assert.equal(ok.valid, true);
  assert.equal(ok.value.title, 'Hello');
  assert.equal(ok.value.priority, 'medium');
  assert.equal(ok.value.status, 'todo');

  assert.equal(L.validateTask({ title: '   ' }).valid, false);
  assert.equal(L.validateTask({ title: 'x'.repeat(81) }).valid, false);
  assert.equal(L.validateTask({ title: 'x', description: 'y'.repeat(501) }).valid, false);
  assert.equal(L.validateTask({ title: 'x', priority: 'urgent' }).valid, false);
  assert.equal(L.validateTask({ title: 'x', status: 'blocked' }).valid, false);
  assert.equal(L.validateTask({ title: 'x', due: '2026-02-31' }).valid, false);
  assert.equal(L.validateTask(null).valid, false);
  assert.equal(L.validateTask(undefined).valid, false);
});

test('createTask builds a complete task and throws on invalid input', () => {
  const t = L.createTask({ title: 'Ship', priority: 'high', tags: 'a, b', due: '2026-12-01' }, NOW);
  assert.equal(typeof t.id, 'string');
  assert.ok(t.id.length > 5);
  assert.equal(t.createdAt, NOW.toISOString());
  assert.equal(t.completedAt, null);
  assert.deepEqual(t.tags, ['a', 'b']);
  assert.throws(() => L.createTask({ title: '' }), /Title is required/);

  const done = L.createTask({ title: 'Already', status: 'done' }, NOW);
  assert.equal(done.completedAt, NOW.toISOString());
});

test('ids are unique', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(L.uid());
  assert.equal(ids.size, 500);
});

test('updateTask edits fields immutably and tracks completion', () => {
  const tasks = fixture();
  const next = L.updateTask(tasks, 'a', { title: 'A2', priority: 'high' }, NOW);
  assert.equal(next.find((t) => t.id === 'a').title, 'A2');
  assert.equal(tasks.find((t) => t.id === 'a').title, 'A');

  const finished = L.updateTask(next, 'a', { status: 'done' }, NOW);
  assert.equal(finished.find((t) => t.id === 'a').completedAt, NOW.toISOString());
  const reopened = L.updateTask(finished, 'a', { status: 'todo' }, NOW);
  assert.equal(reopened.find((t) => t.id === 'a').completedAt, null);

  assert.throws(() => L.updateTask(tasks, 'a', { title: '' }), /Title is required/);
  assert.equal(L.updateTask(tasks, 'missing', { title: 'x' }).length, tasks.length);
});

test('deleteTask and restoreTask round-trip', () => {
  const tasks = fixture();
  const res = L.deleteTask(tasks, 'b');
  assert.equal(res.tasks.length, 3);
  assert.equal(res.removed.id, 'b');
  assert.equal(res.index, 1);
  const back = L.restoreTask(res.tasks, res.removed, res.index);
  assert.deepEqual(back.map((t) => t.id), ['a', 'b', 'c', 'd']);
  // restoring twice does not duplicate
  assert.equal(L.restoreTask(back, res.removed, res.index).length, 4);
  // deleting a missing id is a no-op
  const miss = L.deleteTask(tasks, 'zzz');
  assert.equal(miss.removed, null);
  assert.equal(miss.tasks.length, 4);
});

test('moveTask reorders inside a column', () => {
  const tasks = fixture();
  const moved = L.moveTask(tasks, 'b', 'todo', 0, NOW);
  assert.deepEqual(moved.filter((t) => t.status === 'todo').map((t) => t.id), ['b', 'a']);
  const toEnd = L.moveTask(tasks, 'a', 'todo', 99, NOW);
  assert.deepEqual(toEnd.filter((t) => t.status === 'todo').map((t) => t.id), ['b', 'a']);
});

test('moveTask changes column, inserts at index and manages completedAt', () => {
  const tasks = fixture();
  const toDoing = L.moveTask(tasks, 'a', 'doing', 0, NOW);
  assert.deepEqual(toDoing.filter((t) => t.status === 'doing').map((t) => t.id), ['a', 'c']);
  assert.equal(toDoing.length, 4);

  const toDone = L.moveTask(tasks, 'a', 'done', Number.MAX_SAFE_INTEGER, NOW);
  const a = toDone.find((t) => t.id === 'a');
  assert.equal(a.status, 'done');
  assert.equal(a.completedAt, NOW.toISOString());
  assert.deepEqual(toDone.filter((t) => t.status === 'done').map((t) => t.id), ['d', 'a']);

  const back = L.moveTask(toDone, 'a', 'todo', 0, NOW);
  assert.equal(back.find((t) => t.id === 'a').completedAt, null);
});

test('moveTask into an empty column and with bad input', () => {
  const tasks = fixture().filter((t) => t.status !== 'doing');
  const moved = L.moveTask(tasks, 'a', 'doing', 0, NOW);
  assert.equal(moved.find((t) => t.id === 'a').status, 'doing');
  assert.equal(moved.length, 3);
  assert.throws(() => L.moveTask(tasks, 'a', 'nope', 0), /Invalid status/);
  assert.equal(L.moveTask(tasks, 'ghost', 'doing', 0).length, 3);
  const nan = L.moveTask(fixture(), 'a', 'doing', NaN, NOW);
  assert.deepEqual(nan.filter((t) => t.status === 'doing').map((t) => t.id), ['c', 'a']);
});

test('moveTask does not mutate its input', () => {
  const tasks = fixture();
  const snapshot = JSON.stringify(tasks);
  L.moveTask(tasks, 'a', 'done', 0, NOW);
  assert.equal(JSON.stringify(tasks), snapshot);
});

test('filterTasks searches title, description and tags; filters priority', () => {
  const tasks = [
    make({ title: 'Fix login', description: 'OAuth bug', tags: 'auth', priority: 'high' }),
    make({ title: 'Write docs', tags: 'docs', priority: 'low' }),
    make({ title: 'Refactor', description: 'Clean DB layer', priority: 'high' })
  ];
  assert.equal(L.filterTasks(tasks, { query: 'oauth' }).length, 1);
  assert.equal(L.filterTasks(tasks, { query: 'DOCS' }).length, 1);
  assert.equal(L.filterTasks(tasks, { query: 'db' }).length, 1);
  assert.equal(L.filterTasks(tasks, { priority: 'high' }).length, 2);
  assert.equal(L.filterTasks(tasks, { priority: 'high', query: 'login' }).length, 1);
  assert.equal(L.filterTasks(tasks, { priority: 'bogus' }).length, 3);
  assert.equal(L.filterTasks(tasks).length, 3);
});

test('sortTasks supports priority, due, created and stays stable', () => {
  const t1 = Object.assign(make({ title: '1', priority: 'low', due: '2026-12-05' }), { createdAt: '2026-01-01T00:00:00.000Z' });
  const t2 = Object.assign(make({ title: '2', priority: 'high' }), { createdAt: '2026-03-01T00:00:00.000Z' });
  const t3 = Object.assign(make({ title: '3', priority: 'high', due: '2026-11-20' }), { createdAt: '2026-02-01T00:00:00.000Z' });
  const list = [t1, t2, t3];
  assert.deepEqual(L.sortTasks(list, 'priority').map((t) => t.title), ['2', '3', '1']);
  assert.deepEqual(L.sortTasks(list, 'due').map((t) => t.title), ['3', '1', '2']);
  assert.deepEqual(L.sortTasks(list, 'created').map((t) => t.title), ['2', '3', '1']);
  assert.deepEqual(L.sortTasks(list, 'manual').map((t) => t.title), ['1', '2', '3']);
  assert.notEqual(L.sortTasks(list, 'manual'), list);
});

test('isOverdue ignores done tasks and tasks without due dates', () => {
  assert.equal(L.isOverdue({ due: '2026-11-01', status: 'todo' }, '2026-11-12'), true);
  assert.equal(L.isOverdue({ due: '2026-11-12', status: 'todo' }, '2026-11-12'), false);
  assert.equal(L.isOverdue({ due: '2026-11-01', status: 'done' }, '2026-11-12'), false);
  assert.equal(L.isOverdue({ due: '', status: 'todo' }, '2026-11-12'), false);
});

test('computeStats counts and percentage', () => {
  const tasks = [
    make({ due: '2026-11-01' }),
    make({ status: 'doing' }),
    make({ status: 'done', due: '2026-11-01' }),
    make({ status: 'done' })
  ];
  const s = L.computeStats(tasks, '2026-11-12');
  assert.deepEqual(s, { total: 4, todo: 1, doing: 1, done: 2, overdue: 1, percentDone: 50 });
  assert.equal(L.computeStats([], '2026-11-12').percentDone, 0);
});

test('export then import round-trips', () => {
  const tasks = fixture();
  const out = L.importTasks(L.exportTasks(tasks));
  assert.equal(out.skipped, 0);
  assert.deepEqual(out.tasks.map((t) => t.id), ['a', 'b', 'c', 'd']);
  assert.equal(out.tasks[3].status, 'done');
});

test('importTasks accepts bare arrays, skips bad rows, fixes duplicate ids', () => {
  const text = JSON.stringify([
    { id: 'x', title: 'Good' },
    { id: 'x', title: 'Duplicate id' },
    { title: '' },
    'junk',
    null,
    { title: 'Done one', status: 'done' }
  ]);
  const out = L.importTasks(text);
  assert.equal(out.tasks.length, 3);
  assert.equal(out.skipped, 3);
  assert.equal(new Set(out.tasks.map((t) => t.id)).size, 3);
  assert.ok(out.tasks[2].completedAt);
});

test('importTasks rejects unreadable files', () => {
  assert.throws(() => L.importTasks('not json'), /not valid JSON/);
  assert.throws(() => L.importTasks('{"hello":1}'), /task list/);
  assert.throws(() => L.importTasks('42'), /task list/);
});
