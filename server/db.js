'use strict';
/*
 * Data layer: SQLite via Node's built-in `node:sqlite` (no native addons to compile).
 * All SQL lives here so the HTTP layer stays thin and the storage engine is swappable.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    is_guest      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id           TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    priority     TEXT    NOT NULL CHECK (priority IN ('low','medium','high')),
    status       TEXT    NOT NULL CHECK (status IN ('todo','doing','done')),
    due          TEXT    NOT NULL DEFAULT '',
    tags         TEXT    NOT NULL DEFAULT '[]',
    created_at   TEXT    NOT NULL,
    completed_at TEXT,
    position     INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_user_position ON tasks (user_id, position);
  CREATE INDEX IF NOT EXISTS idx_users_guest_created ON users (is_guest, created_at);
`;

function toTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    due: row.due,
    tags: JSON.parse(row.tags),
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, is_guest FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, password_hash, is_guest, created_at) VALUES (?, ?, ?, ?)'),
    purgeGuests: db.prepare('DELETE FROM users WHERE is_guest = 1 AND created_at < ?'),
    listTasks: db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY position ASC'),
    getTask: db.prepare('SELECT * FROM tasks WHERE user_id = ? AND id = ?'),
    countTasks: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?'),
    maxPos: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM tasks WHERE user_id = ?'),
    insertTask: db.prepare(
      `INSERT INTO tasks (user_id, id, title, description, priority, status, due, tags, created_at, completed_at, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    updateTask: db.prepare(
      `UPDATE tasks SET title = ?, description = ?, priority = ?, status = ?, due = ?, tags = ?, completed_at = ?
       WHERE user_id = ? AND id = ?`
    ),
    deleteTask: db.prepare('DELETE FROM tasks WHERE user_id = ? AND id = ?'),
    setOrder: db.prepare('UPDATE tasks SET status = ?, completed_at = ?, position = ? WHERE user_id = ? AND id = ?')
  };

  /** Runs fn inside a transaction; rolls back if it throws. */
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function insertTaskRow(userId, t, position) {
    q.insertTask.run(
      userId, t.id, t.title, t.description, t.priority, t.status, t.due,
      JSON.stringify(t.tags), t.createdAt, t.completedAt, position
    );
  }

  return {
    raw: db,
    transaction,
    close: () => db.close(),

    findUserByEmail: (email) => q.userByEmail.get(email) || null,
    findUserById: (id) => q.userById.get(id) || null,
    createUser(email, passwordHash, isGuest) {
      const info = q.insertUser.run(email, passwordHash, isGuest ? 1 : 0, new Date().toISOString());
      return Number(info.lastInsertRowid);
    },
    purgeGuestsOlderThan: (iso) => Number(q.purgeGuests.run(iso).changes),

    listTasks: (userId) => q.listTasks.all(userId).map(toTask),
    getTask(userId, id) {
      const row = q.getTask.get(userId, id);
      return row ? toTask(row) : null;
    },
    countTasks: (userId) => q.countTasks.get(userId).n,
    appendTask(userId, task) {
      insertTaskRow(userId, task, q.maxPos.get(userId).p + 1);
    },
    appendTasks(userId, tasks) {
      transaction(() => {
        let pos = q.maxPos.get(userId).p + 1;
        tasks.forEach((t) => insertTaskRow(userId, t, pos++));
      });
    },
    saveTask(userId, t) {
      return Number(
        q.updateTask.run(t.title, t.description, t.priority, t.status, t.due, JSON.stringify(t.tags), t.completedAt, userId, t.id).changes
      );
    },
    removeTask: (userId, id) => Number(q.deleteTask.run(userId, id).changes),
    /** items: [{ id, status, completedAt }] in their new display order. */
    applyOrder(userId, items) {
      transaction(() => {
        items.forEach((it, i) => q.setOrder.run(it.status, it.completedAt, i, userId, it.id));
      });
    }
  };
}

module.exports = { openDatabase };
