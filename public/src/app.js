/*
 * TaskFlow UI controller.
 * All DOM text is set via textContent (no innerHTML), so user input can never inject markup.
 *
 * Data flow: the UI updates optimistically using the pure functions in store.js, then the change is
 * sent to the REST API through a single request queue (so rapid actions reach the server in order).
 * If the server rejects a change, the board is reloaded from the server so the two never drift apart.
 */
(function () {
  'use strict';

  var L = window.TaskLogic;
  var THEME_KEY = 'taskflow.theme';
  var STATUS_LABELS = { todo: 'To Do', doing: 'In Progress', done: 'Done' };
  var EMPTY_TEXT = {
    todo: 'Nothing planned. Add a task!',
    doing: 'Drag a task here when you start it.',
    done: 'Finished tasks land here.'
  };

  var state = {
    user: null,
    tasks: [],
    query: '',
    priority: 'all',
    sort: 'manual',
    editingId: null,
    lastDeleted: null,
    draggedId: null,
    toastTimer: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  /* ---------- storage (wrapped: private mode / blocked storage must not crash the app) ---------- */

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* ignore quota / privacy errors */
    }
  }

  /* ---------- API layer ---------- */

  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Request failed (' + res.status + ').');
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  // Serialises writes: each request starts only after the previous one finished.
  var queue = Promise.resolve();
  function enqueue(job) {
    var run = queue.then(job);
    queue = run.catch(function () {});
    return run;
  }

  function handleSyncError(err) {
    if (err && err.status === 401) {
      showAuth('Your session expired. Please sign in again.');
      return;
    }
    showToast((err && err.message) || 'Could not save your change.');
    loadTasks();
  }

  /** Fire-and-forget write with optimistic UI; reloads the board if the server disagrees. */
  function sync(job) {
    return enqueue(job).catch(handleSyncError);
  }

  function loadTasks() {
    return api('GET', '/api/tasks').then(function (data) {
      state.tasks = data.tasks;
      render();
    }, handleSyncError);
  }

  function orderPayload() {
    return {
      tasks: state.tasks.map(function (t) {
        return { id: t.id, status: t.status };
      })
    };
  }

  function syncOrder() {
    return sync(function () {
      return api('PUT', '/api/tasks/order', orderPayload());
    });
  }

  /* ---------- rendering ---------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatDue(due) {
    var parts = due.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function actionButton(action, label, text, disabled) {
    var b = el('button', '', text);
    b.type = 'button';
    b.setAttribute('data-action', action);
    b.setAttribute('aria-label', label);
    b.title = label;
    if (disabled) b.disabled = true;
    return b;
  }

  function buildCard(task, today) {
    var idx = L.STATUSES.indexOf(task.status);
    var card = el('article', 'card p-' + task.priority + (task.status === 'done' ? ' is-done' : ''));
    card.draggable = true;
    card.setAttribute('data-id', task.id);

    var top = el('div', 'card-top');
    top.appendChild(el('h3', 'card-title', task.title));
    top.appendChild(el('span', 'badge ' + task.priority, task.priority));
    card.appendChild(top);

    if (task.description) card.appendChild(el('p', 'card-desc', task.description));

    if (task.tags.length || task.due) {
      var meta = el('div', 'card-meta');
      task.tags.forEach(function (t) {
        meta.appendChild(el('span', 'tag', '#' + t));
      });
      if (task.due) {
        var overdue = L.isOverdue(task, today);
        meta.appendChild(el('span', 'due' + (overdue ? ' overdue' : ''), (overdue ? 'Overdue · ' : 'Due ') + formatDue(task.due)));
      }
      card.appendChild(meta);
    }

    var actions = el('div', 'card-actions');
    actions.appendChild(actionButton('left', 'Move to previous column', '←', idx === 0));
    actions.appendChild(actionButton('right', 'Move to next column', '→', idx === L.STATUSES.length - 1));
    actions.appendChild(actionButton('edit', 'Edit task', 'Edit', false));
    actions.appendChild(actionButton('delete', 'Delete task', 'Delete', false));
    card.appendChild(actions);

    return card;
  }

  function render() {
    var today = L.todayString(new Date());
    var filtering = state.query.trim() !== '' || state.priority !== 'all';
    var visible = L.sortTasks(L.filterTasks(state.tasks, { query: state.query, priority: state.priority }), state.sort);

    L.STATUSES.forEach(function (status) {
      var list = $('list-' + status);
      list.textContent = '';
      var items = visible.filter(function (t) {
        return t.status === status;
      });
      var total = state.tasks.filter(function (t) {
        return t.status === status;
      }).length;

      items.forEach(function (t) {
        list.appendChild(buildCard(t, today));
      });
      if (!items.length) {
        list.appendChild(el('p', 'empty', filtering && total ? 'No tasks match your filters.' : EMPTY_TEXT[status]));
      }
      $('count-' + status).textContent = filtering ? items.length + '/' + total : String(total);
    });

    var s = L.computeStats(state.tasks, today);
    $('stat-total').textContent = String(s.total);
    $('stat-doing').textContent = String(s.doing);
    $('stat-done').textContent = String(s.done);
    $('stat-overdue').textContent = String(s.overdue);
    $('progress-bar').style.width = s.percentDone + '%';
    $('progress').setAttribute('aria-valuenow', String(s.percentDone));
    $('progress-label').textContent = s.percentDone + '% complete';
  }

  function commit() {
    render();
  }

  /* ---------- toast ---------- */

  function showToast(message, actionLabel, onAction) {
    var toast = $('toast');
    var btn = $('toast-action');
    $('toast-text').textContent = message;
    btn.onclick = null;
    if (actionLabel && onAction) {
      btn.textContent = actionLabel;
      btn.hidden = false;
      btn.onclick = function () {
        hideToast();
        onAction();
      };
    } else {
      btn.hidden = true;
    }
    toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(hideToast, 6000);
  }

  function hideToast() {
    clearTimeout(state.toastTimer);
    $('toast').hidden = true;
  }

  /* ---------- dialog ---------- */

  function showErrors(messages) {
    var box = $('form-errors');
    if (messages.length) {
      box.textContent = messages.join(' ');
      box.hidden = false;
    } else {
      box.textContent = '';
      box.hidden = true;
    }
  }

  function openDialog(task, defaultStatus) {
    var dialog = $('task-dialog');
    state.editingId = task ? task.id : null;
    $('dialog-title').textContent = task ? 'Edit task' : 'New task';
    $('f-title').value = task ? task.title : '';
    $('f-description').value = task ? task.description : '';
    $('f-priority').value = task ? task.priority : 'medium';
    $('f-status').value = task ? task.status : defaultStatus || 'todo';
    $('f-due').value = task ? task.due : '';
    $('f-tags').value = task ? task.tags.join(', ') : '';
    showErrors([]);
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    $('f-title').focus();
  }

  function closeDialog() {
    var dialog = $('task-dialog');
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
    state.editingId = null;
  }

  function onSubmit(event) {
    event.preventDefault();
    var input = {
      title: $('f-title').value,
      description: $('f-description').value,
      priority: $('f-priority').value,
      status: $('f-status').value,
      due: $('f-due').value,
      tags: $('f-tags').value
    };
    var result = L.validateTask(input);
    if (!result.valid) {
      showErrors(result.errors);
      return;
    }
    try {
      if (state.editingId) {
        var editId = state.editingId;
        state.tasks = L.updateTask(state.tasks, editId, input);
        sync(function () {
          return api('PATCH', '/api/tasks/' + encodeURIComponent(editId), input);
        });
        showToast('Task updated.');
      } else {
        var created = L.createTask(input);
        state.tasks = state.tasks.concat([created]);
        sync(function () {
          return api('POST', '/api/tasks', created);
        });
        showToast('Task added.');
      }
    } catch (e) {
      showErrors([e.message]);
      return;
    }
    closeDialog();
    commit();
  }

  /* ---------- card actions ---------- */

  function handleBoardClick(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    var addBtn = target.closest('.add-in');
    if (addBtn) {
      openDialog(null, addBtn.getAttribute('data-status'));
      return;
    }

    var btn = target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    var card = btn.closest('.card');
    if (!card) return;
    var id = card.getAttribute('data-id');
    var task = state.tasks.filter(function (t) {
      return t.id === id;
    })[0];
    if (!task) return;

    var action = btn.getAttribute('data-action');
    if (action === 'edit') {
      openDialog(task);
    } else if (action === 'delete') {
      var res = L.deleteTask(state.tasks, id);
      state.tasks = res.tasks;
      state.lastDeleted = { task: res.removed, index: res.index };
      sync(function () {
        return api('DELETE', '/api/tasks/' + encodeURIComponent(id));
      });
      commit();
      showToast('Deleted "' + res.removed.title + '".', 'Undo', undoDelete);
    } else if (action === 'left' || action === 'right') {
      var i = L.STATUSES.indexOf(task.status) + (action === 'left' ? -1 : 1);
      if (i >= 0 && i < L.STATUSES.length) {
        state.tasks = L.moveTask(state.tasks, id, L.STATUSES[i], Number.MAX_SAFE_INTEGER);
        syncOrder();
        commit();
        showToast('Moved to ' + STATUS_LABELS[L.STATUSES[i]] + '.');
      }
    }
  }

  function undoDelete() {
    if (!state.lastDeleted) return;
    var restored = state.lastDeleted.task;
    state.tasks = L.restoreTask(state.tasks, restored, state.lastDeleted.index);
    state.lastDeleted = null;
    sync(function () {
      return api('POST', '/api/tasks', restored).then(function () {
        return api('PUT', '/api/tasks/order', orderPayload());
      });
    });
    commit();
  }

  /* ---------- drag and drop ---------- */

  function clearDropHighlights() {
    var lists = document.querySelectorAll('.card-list.over');
    for (var i = 0; i < lists.length; i++) lists[i].classList.remove('over');
  }

  function cardAfterPointer(list, y) {
    var cards = list.querySelectorAll('.card:not(.dragging)');
    for (var i = 0; i < cards.length; i++) {
      var box = cards[i].getBoundingClientRect();
      if (y < box.top + box.height / 2) return cards[i];
    }
    return null;
  }

  function onDragStart(event) {
    var card = event.target instanceof Element ? event.target.closest('.card') : null;
    if (!card) return;
    state.draggedId = card.getAttribute('data-id');
    event.dataTransfer.effectAllowed = 'move';
    try {
      event.dataTransfer.setData('text/plain', state.draggedId);
    } catch (e) {
      /* some browsers restrict setData; draggedId in state is the source of truth */
    }
    setTimeout(function () {
      card.classList.add('dragging');
    }, 0);
  }

  function onDragEnd() {
    state.draggedId = null;
    clearDropHighlights();
    var dragging = document.querySelectorAll('.card.dragging');
    for (var i = 0; i < dragging.length; i++) dragging[i].classList.remove('dragging');
  }

  function onDragOver(event) {
    var list = event.target instanceof Element ? event.target.closest('.card-list') : null;
    if (!list || !state.draggedId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (!list.classList.contains('over')) {
      clearDropHighlights();
      list.classList.add('over');
    }
  }

  function onDrop(event) {
    var list = event.target instanceof Element ? event.target.closest('.card-list') : null;
    if (!list || !state.draggedId) return;
    event.preventDefault();

    var id = state.draggedId;
    var status = list.getAttribute('data-status');
    var after = cardAfterPointer(list, event.clientY);
    var siblings = state.tasks.filter(function (t) {
      return t.status === status && t.id !== id;
    });
    var index = siblings.length;
    if (after) {
      for (var i = 0; i < siblings.length; i++) {
        if (siblings[i].id === after.getAttribute('data-id')) {
          index = i;
          break;
        }
      }
    }

    onDragEnd();
    state.tasks = L.moveTask(state.tasks, id, status, index);
    syncOrder();
    commit();
  }

  /* ---------- import / export ---------- */

  function exportJson() {
    var blob = new Blob([L.exportTasks(state.tasks)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'taskflow-' + L.todayString(new Date()) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    showToast('Exported ' + state.tasks.length + ' tasks.');
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = L.importTasks(String(reader.result));
      } catch (e) {
        showToast(e.message || 'Could not import that file.');
        return;
      }
      enqueue(function () {
        return api('POST', '/api/tasks/import', { tasks: parsed.tasks });
      }).then(function (data) {
        state.tasks = data.tasks;
        render();
        var msg = 'Imported ' + data.imported + ' task' + (data.imported === 1 ? '' : 's') + '.';
        if (parsed.skipped) msg += ' Skipped ' + parsed.skipped + ' invalid.';
        showToast(msg);
      }, handleSyncError);
    };
    reader.onerror = function () {
      showToast('Could not read that file.');
    };
    reader.readAsText(file);
  }

  /* ---------- theme ---------- */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    $('btn-theme').textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  function initTheme() {
    var saved = storageGet(THEME_KEY);
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved === 'dark' || saved === 'light' ? saved : prefersDark ? 'dark' : 'light');
  }

  function toggleTheme() {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storageSet(THEME_KEY, next);
  }

  /* ---------- keyboard ---------- */

  function isTyping(target) {
    if (!(target instanceof Element)) return false;
    var tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function onKeyDown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.body.getAttribute('data-view') !== 'app') return;
    if ($('task-dialog').open || isTyping(event.target)) return;
    if (event.key === 'n') {
      event.preventDefault();
      openDialog(null, 'todo');
    } else if (event.key === '/') {
      event.preventDefault();
      $('search').focus();
    }
  }

  /* ---------- auth ---------- */

  var authMode = 'login';

  function setView(view) {
    document.body.setAttribute('data-view', view);
  }

  function setAuthMode(mode) {
    authMode = mode;
    var signup = mode === 'register';
    $('auth-title').textContent = signup ? 'Create your account' : 'Sign in to TaskFlow';
    $('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
    $('auth-switch').textContent = signup ? 'Already have an account? Sign in' : 'New here? Create an account';
    $('a-hint').hidden = !signup;
    $('a-password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    showAuthError('');
  }

  function showAuthError(message) {
    var box = $('auth-errors');
    box.textContent = message;
    box.hidden = !message;
  }

  function showAuth(message) {
    state.user = null;
    state.tasks = [];
    $('a-password').value = '';
    setAuthMode('login');
    if (message) showAuthError(message);
    setView('auth');
  }

  function enterApp(user) {
    state.user = user;
    $('user-chip').textContent = user.guest ? 'Demo session' : user.email;
    $('user-chip').title = user.guest ? 'Temporary demo account (deleted after 24h)' : 'Signed in as ' + user.email;
    $('a-password').value = '';
    showAuthError('');
    setView('app');
    return loadTasks();
  }

  function setBusy(busy) {
    ['auth-submit', 'btn-guest'].forEach(function (id) {
      $(id).disabled = busy;
    });
  }

  function submitAuth(path, body) {
    setBusy(true);
    showAuthError('');
    return api('POST', path, body)
      .then(function (data) {
        return enterApp(data.user);
      })
      .catch(function (err) {
        showAuthError(err.message || 'Could not sign in.');
      })
      .then(function () {
        setBusy(false);
      });
  }

  function onAuthSubmit(event) {
    event.preventDefault();
    submitAuth(authMode === 'register' ? '/api/auth/register' : '/api/auth/login', {
      email: $('a-email').value,
      password: $('a-password').value
    });
  }

  function logout() {
    hideToast();
    api('POST', '/api/auth/logout').then(function () {
      showAuth();
    }, function () {
      showAuth();
    });
  }

  function boot() {
    api('GET', '/api/auth/me').then(
      function (data) {
        return enterApp(data.user);
      },
      function () {
        showAuth();
      }
    );
  }

  /* ---------- init ---------- */

  function init() {
    initTheme();

    $('search').addEventListener('input', function (e) {
      state.query = e.target.value;
      render();
    });
    $('filter-priority').addEventListener('change', function (e) {
      state.priority = e.target.value;
      render();
    });
    $('sort').addEventListener('change', function (e) {
      state.sort = e.target.value;
      render();
    });

    $('btn-new').addEventListener('click', function () {
      openDialog(null, 'todo');
    });
    $('btn-cancel').addEventListener('click', closeDialog);
    $('task-form').addEventListener('submit', onSubmit);
    $('task-dialog').addEventListener('click', function (e) {
      if (e.target === $('task-dialog')) closeDialog();
    });
    $('task-dialog').addEventListener('cancel', function () {
      state.editingId = null;
    });

    $('auth-form').addEventListener('submit', onAuthSubmit);
    $('auth-switch').addEventListener('click', function () {
      setAuthMode(authMode === 'login' ? 'register' : 'login');
    });
    $('btn-guest').addEventListener('click', function () {
      submitAuth('/api/auth/guest', {});
    });
    $('btn-logout').addEventListener('click', logout);

    $('btn-theme').addEventListener('click', toggleTheme);
    $('btn-export').addEventListener('click', exportJson);
    $('btn-import').addEventListener('click', function () {
      $('import-file').click();
    });
    $('import-file').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) importJson(file);
      e.target.value = '';
    });

    var board = $('board');
    board.addEventListener('click', handleBoardClick);
    board.addEventListener('dragstart', onDragStart);
    board.addEventListener('dragend', onDragEnd);
    board.addEventListener('dragover', onDragOver);
    board.addEventListener('drop', onDrop);
    board.addEventListener('dragleave', function (e) {
      var list = e.target instanceof Element ? e.target.closest('.card-list') : null;
      if (list && !list.contains(e.relatedTarget)) list.classList.remove('over');
    });

    document.addEventListener('keydown', onKeyDown);
    boot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
