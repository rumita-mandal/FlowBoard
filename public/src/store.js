/*
 * TaskFlow core logic.
 * Pure, framework-free functions (no DOM access) so they can be unit tested in Node
 * and reused in the browser. Works as a classic <script> and as a CommonJS module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TaskLogic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATUSES = ['todo', 'doing', 'done'];
  var PRIORITIES = ['low', 'medium', 'high'];
  var LIMITS = { title: 80, description: 500, tags: 5, tagLength: 20 };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** Local-date string in YYYY-MM-DD form. */
  function todayString(date) {
    var d = date || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function isValidDateString(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var y = Number(s.slice(0, 4));
    var m = Number(s.slice(5, 7));
    var d = Number(s.slice(8, 10));
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  /** "Bug, UI, bug" -> ["bug", "ui"] (lowercase, unique, limited). */
  function parseTags(input) {
    var raw = Array.isArray(input) ? input : String(input || '').split(',');
    var seen = {};
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var t = String(raw[i]).trim().toLowerCase().slice(0, LIMITS.tagLength);
      if (t && !seen[t]) {
        seen[t] = true;
        out.push(t);
      }
      if (out.length >= LIMITS.tags) break;
    }
    return out;
  }

  /** Validates and normalises user input. Never throws. */
  function validateTask(input) {
    var src = input && typeof input === 'object' ? input : {};
    var errors = [];
    var title = typeof src.title === 'string' ? src.title.trim() : '';
    var description = typeof src.description === 'string' ? src.description.trim() : '';
    var priority = src.priority === undefined || src.priority === '' ? 'medium' : src.priority;
    var status = src.status === undefined || src.status === '' ? 'todo' : src.status;
    var due = src.due === undefined || src.due === null ? '' : src.due;

    if (!title) errors.push('Title is required.');
    else if (title.length > LIMITS.title) errors.push('Title must be at most ' + LIMITS.title + ' characters.');
    if (description.length > LIMITS.description) {
      errors.push('Description must be at most ' + LIMITS.description + ' characters.');
    }
    if (PRIORITIES.indexOf(priority) === -1) errors.push('Priority must be low, medium or high.');
    if (STATUSES.indexOf(status) === -1) errors.push('Status must be todo, doing or done.');
    if (due !== '' && !isValidDateString(due)) errors.push('Due date must be a valid date.');

    return {
      valid: errors.length === 0,
      errors: errors,
      value: {
        title: title,
        description: description,
        priority: priority,
        status: status,
        due: due,
        tags: parseTags(src.tags)
      }
    };
  }

  function createTask(input, now) {
    var result = validateTask(input);
    if (!result.valid) throw new Error(result.errors.join(' '));
    var when = now || new Date();
    var v = result.value;
    return {
      id: uid(),
      title: v.title,
      description: v.description,
      priority: v.priority,
      status: v.status,
      due: v.due,
      tags: v.tags,
      createdAt: when.toISOString(),
      completedAt: v.status === 'done' ? when.toISOString() : null
    };
  }

  function findTask(tasks, id) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === id) return tasks[i];
    }
    return null;
  }

  function withStatus(task, status, now) {
    var next = Object.assign({}, task, { status: status });
    if (status === 'done' && task.status !== 'done') {
      next.completedAt = (now || new Date()).toISOString();
    } else if (status !== 'done') {
      next.completedAt = null;
    }
    return next;
  }

  /** Returns a new array with the task updated. Throws on invalid data. */
  function updateTask(tasks, id, changes, now) {
    var existing = findTask(tasks, id);
    if (!existing) return tasks.slice();
    var merged = Object.assign({}, existing, changes);
    var result = validateTask(merged);
    if (!result.valid) throw new Error(result.errors.join(' '));
    var v = result.value;
    var updated = Object.assign({}, existing, {
      title: v.title,
      description: v.description,
      priority: v.priority,
      due: v.due,
      tags: v.tags
    });
    updated = withStatus(updated, v.status, now);
    return tasks.map(function (t) {
      return t.id === id ? updated : t;
    });
  }

  function deleteTask(tasks, id) {
    var index = -1;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === id) {
        index = i;
        break;
      }
    }
    if (index === -1) return { tasks: tasks.slice(), removed: null, index: -1 };
    var copy = tasks.slice();
    var removed = copy.splice(index, 1)[0];
    return { tasks: copy, removed: removed, index: index };
  }

  /** Re-inserts a previously deleted task at (roughly) its old position. */
  function restoreTask(tasks, task, index) {
    if (!task || findTask(tasks, task.id)) return tasks.slice();
    var copy = tasks.slice();
    var at = Math.max(0, Math.min(Number.isFinite(index) ? index : copy.length, copy.length));
    copy.splice(at, 0, task);
    return copy;
  }

  /**
   * Moves a task to a column. `index` is the position inside the target column
   * (ignoring the moved task itself); values past the end append to the column.
   */
  function moveTask(tasks, id, status, index, now) {
    if (STATUSES.indexOf(status) === -1) throw new Error('Invalid status: ' + status);
    var task = findTask(tasks, id);
    if (!task) return tasks.slice();

    var moved = withStatus(task, status, now);
    var rest = tasks.filter(function (t) {
      return t.id !== id;
    });
    var targets = rest.filter(function (t) {
      return t.status === status;
    });

    var i = Number(index);
    i = Number.isFinite(i) ? Math.max(0, Math.floor(i)) : targets.length;

    var insertAt;
    if (i >= targets.length) {
      insertAt = targets.length ? rest.indexOf(targets[targets.length - 1]) + 1 : rest.length;
    } else {
      insertAt = rest.indexOf(targets[i]);
    }
    rest.splice(insertAt, 0, moved);
    return rest;
  }

  function filterTasks(tasks, opts) {
    var o = opts || {};
    var q = String(o.query || '').trim().toLowerCase();
    var p = PRIORITIES.indexOf(o.priority) === -1 ? 'all' : o.priority;
    return tasks.filter(function (t) {
      if (p !== 'all' && t.priority !== p) return false;
      if (!q) return true;
      var hay = (t.title + ' ' + t.description + ' ' + t.tags.join(' ')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  /** Stable sort. Modes: manual (unchanged), priority, due, created. */
  function sortTasks(tasks, mode) {
    var rank = { high: 0, medium: 1, low: 2 };
    var decorated = tasks.map(function (t, i) {
      return { t: t, i: i };
    });
    var cmp;
    if (mode === 'priority') {
      cmp = function (a, b) {
        return rank[a.t.priority] - rank[b.t.priority];
      };
    } else if (mode === 'due') {
      cmp = function (a, b) {
        var ad = a.t.due || '';
        var bd = b.t.due || '';
        if (ad === bd) return 0;
        if (!ad) return 1;
        if (!bd) return -1;
        return ad < bd ? -1 : 1;
      };
    } else if (mode === 'created') {
      cmp = function (a, b) {
        if (a.t.createdAt === b.t.createdAt) return 0;
        return a.t.createdAt < b.t.createdAt ? 1 : -1;
      };
    } else {
      return tasks.slice();
    }
    decorated.sort(function (a, b) {
      return cmp(a, b) || a.i - b.i;
    });
    return decorated.map(function (d) {
      return d.t;
    });
  }

  function isOverdue(task, today) {
    return Boolean(task.due) && task.status !== 'done' && task.due < today;
  }

  function computeStats(tasks, today) {
    var counts = { todo: 0, doing: 0, done: 0 };
    var overdue = 0;
    tasks.forEach(function (t) {
      if (counts[t.status] !== undefined) counts[t.status]++;
      if (isOverdue(t, today)) overdue++;
    });
    var total = tasks.length;
    return {
      total: total,
      todo: counts.todo,
      doing: counts.doing,
      done: counts.done,
      overdue: overdue,
      percentDone: total ? Math.round((counts.done / total) * 100) : 0
    };
  }

  function exportTasks(tasks) {
    return JSON.stringify({ app: 'taskflow', version: 1, exportedAt: new Date().toISOString(), tasks: tasks }, null, 2);
  }

  /**
   * Parses a JSON export (or a bare array of tasks).
   * Invalid entries are skipped and counted. Throws on unreadable files.
   */
  function importTasks(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('That file is not valid JSON.');
    }
    var list = Array.isArray(data) ? data : data && Array.isArray(data.tasks) ? data.tasks : null;
    if (!list) throw new Error('That file does not contain a task list.');

    var seen = {};
    var tasks = [];
    var skipped = 0;
    var nowIso = new Date().toISOString();

    list.forEach(function (item) {
      if (!item || typeof item !== 'object') {
        skipped++;
        return;
      }
      var result = validateTask(item);
      if (!result.valid) {
        skipped++;
        return;
      }
      var v = result.value;
      var id = typeof item.id === 'string' && item.id && !seen[item.id] ? item.id : uid();
      while (seen[id]) id = uid();
      seen[id] = true;
      var created = typeof item.createdAt === 'string' && !isNaN(Date.parse(item.createdAt)) ? item.createdAt : nowIso;
      var completed = null;
      if (v.status === 'done') {
        completed =
          typeof item.completedAt === 'string' && !isNaN(Date.parse(item.completedAt)) ? item.completedAt : nowIso;
      }
      tasks.push({
        id: id,
        title: v.title,
        description: v.description,
        priority: v.priority,
        status: v.status,
        due: v.due,
        tags: v.tags,
        createdAt: created,
        completedAt: completed
      });
    });

    return { tasks: tasks, skipped: skipped };
  }

  return {
    STATUSES: STATUSES,
    PRIORITIES: PRIORITIES,
    LIMITS: LIMITS,
    uid: uid,
    todayString: todayString,
    isValidDateString: isValidDateString,
    parseTags: parseTags,
    validateTask: validateTask,
    createTask: createTask,
    updateTask: updateTask,
    deleteTask: deleteTask,
    restoreTask: restoreTask,
    moveTask: moveTask,
    filterTasks: filterTasks,
    sortTasks: sortTasks,
    isOverdue: isOverdue,
    computeStats: computeStats,
    exportTasks: exportTasks,
    importTasks: importTasks
  };
});
