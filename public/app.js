// app.js — Frontend Logic

let projectsData = [];
let currentProjectId = null;
let schedulesData = [];

// DOM Elements
const projectsGrid = document.getElementById('projects-grid');
const emptyState = document.getElementById('empty-state');
const projectCountEl = document.getElementById('project-count');
const logContainer = document.getElementById('log-container');
const statRunningVal = document.getElementById('stat-running-val');
const statStoppedVal = document.getElementById('stat-stopped-val');
const statSchedulesVal = document.getElementById('stat-schedules-val');
const systemTimeEl = document.getElementById('system-time');

// ── Fetch Interceptor ──
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  let [resource, config] = args;
  if (!config) config = {};
  if (!config.headers) config.headers = {};
  
  const token = localStorage.getItem('snooze_token');
  // Attach token to all API calls except login/setup endpoints
  const skipTokenPaths = ['/api/auth/login', '/api/auth/setup', '/api/auth/verify-setup'];
  if (token && resource.startsWith('/api/') && !skipTokenPaths.includes(resource)) {
    if (config.headers instanceof Headers) {
      config.headers.append('Authorization', 'Bearer ' + token);
    } else {
      config.headers['Authorization'] = 'Bearer ' + token;
    }
  }
  
  const response = await originalFetch(resource, config);
  if (response.status === 401 && !resource.startsWith('/api/auth/')) {
    localStorage.removeItem('snooze_token');
    window.location.reload();
  }
  return response;
};

// ── Auth Logic ──
let setupSecret = null;

async function initAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    
    if (!data.configured) {
      // Show Setup
      document.getElementById('auth-overlay').classList.remove('hidden');
      document.getElementById('auth-setup-view').classList.remove('hidden');
      document.getElementById('auth-login-view').classList.add('hidden');
    } else if (!data.authenticated) {
      // Show Login
      document.getElementById('auth-overlay').classList.remove('hidden');
      document.getElementById('auth-setup-view').classList.add('hidden');
      document.getElementById('auth-login-view').classList.remove('hidden');
    } else {
      // Authenticated, show app
      document.getElementById('auth-overlay').classList.add('hidden');
      document.getElementById('app-container').classList.remove('hidden');
      initApp();
    }
  } catch (err) {
    console.error('Failed to check auth status', err);
    setTimeout(initAuth, 2000); // Retry
  }
}

function showAuthError(msg) {
  const errEl = document.getElementById('auth-error-msg');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
  setTimeout(() => errEl.classList.add('hidden'), 5000);
}

document.getElementById('btn-generate-totp').addEventListener('click', async () => {
  const pwd = document.getElementById('setup-password').value;
  if (pwd.length < 6) return showAuthError('Password must be at least 6 characters');
  
  try {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const data = await res.json();
    if (res.ok) {
      setupSecret = data;
      document.getElementById('setup-qr-img').src = data.qrCode;
      document.getElementById('setup-qr-section').classList.remove('hidden');
      document.getElementById('btn-generate-totp').classList.add('hidden');
      document.getElementById('setup-password').disabled = true;
    } else {
      showAuthError(data.error);
    }
  } catch (err) {
    showAuthError('Connection error');
  }
});

document.getElementById('btn-verify-setup').addEventListener('click', async () => {
  const code = document.getElementById('setup-totp-code').value;
  if (code.length !== 6) return showAuthError('Enter 6-digit code');
  
  try {
    const res = await fetch('/api/auth/verify-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: code,
        secret: setupSecret.secret,
        passwordHash: setupSecret.passwordHash
      })
    });
    const data = await res.json();
    if (res.ok) {
      localStorage.setItem('snooze_token', data.token);
      window.location.reload();
    } else {
      showAuthError(data.error);
    }
  } catch (err) {
    showAuthError('Connection error');
  }
});

document.getElementById('btn-login').addEventListener('click', async () => {
  const pwd = document.getElementById('login-password').value;
  const code = document.getElementById('login-totp-code').value;
  
  if (!pwd && !code) return showAuthError('Enter password OR authenticator passkey');
  
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd, token: code })
    });
    const data = await res.json();
    if (res.ok) {
      localStorage.setItem('snooze_token', data.token);
      window.location.reload();
    } else {
      showAuthError(data.error);
    }
  } catch (err) {
    showAuthError('Connection error');
  }
});

// ── Initialization ──
function initApp() {
  // Logout handler
  document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('snooze_token');
    window.location.reload();
  });

  updateSystemTime();
  setInterval(updateSystemTime, 1000);

  fetchProjects();
  setInterval(fetchProjects, 10000);

  fetchLogs();
  
  fetchSystemStats();
  setInterval(fetchSystemStats, 5000);

  setupEventListeners();
  populateQuickPaths();
}

function updateSystemTime() {
  var now = new Date();
  systemTimeEl.textContent = now.toLocaleTimeString('en-US', { hour12: false }) + ' ' +
    now.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }).toUpperCase();
}

// ── API Calls ──
async function fetchProjects() {
  try {
    var res = await fetch('/api/projects');
    var data = await res.json();
    projectsData = data.projects;
    statSchedulesVal.textContent = data.activeSchedules;
    renderProjects();
    updateStatsBar();
  } catch (err) {
    showToast('Connection Error', 'Failed to fetch projects', 'error');
  }
}

async function fetchLogs() {
  try {
    var res = await fetch('/api/logs?limit=50');
    var data = await res.json();
    renderLogs(data.logs);
  } catch (err) {
    console.error(err);
  }
}

async function fetchSystemStats() {
  try {
    var res = await fetch('/api/system-stats');
    var data = await res.json();
    renderSystemStats(data);
  } catch (err) {
    console.error('Failed to fetch system stats', err);
  }
}

// ── Rendering ──
function renderSystemStats(data) {
  // CPU
  const cpuVal = document.getElementById('sys-cpu-val');
  const cpuFill = document.getElementById('sys-cpu-fill');
  const cpuFooter = document.getElementById('sys-cpu-footer');
  cpuVal.textContent = data.cpu.usagePercent + '%';
  cpuFill.style.width = data.cpu.usagePercent + '%';
  cpuFill.className = 'progress-fill ' + (data.cpu.usagePercent > 80 ? 'high' : data.cpu.usagePercent > 50 ? 'med' : '');
  cpuFooter.textContent = data.cpu.cores + ' Cores | Load: ' + data.os.loadavg.map(v => v.toFixed(2)).join(', ');

  // Memory
  const memVal = document.getElementById('sys-mem-val');
  const memFill = document.getElementById('sys-mem-fill');
  const memFooter = document.getElementById('sys-mem-footer');
  memVal.textContent = data.memory.usagePercent + '%';
  memFill.style.width = data.memory.usagePercent + '%';
  memFill.className = 'progress-fill ' + (data.memory.usagePercent > 80 ? 'high' : data.memory.usagePercent > 60 ? 'med' : '');
  memFooter.textContent = (data.memory.used / 1e9).toFixed(1) + ' / ' + (data.memory.total / 1e9).toFixed(1) + ' GB';

  // Disk
  const diskVal = document.getElementById('sys-disk-val');
  const diskFill = document.getElementById('sys-disk-fill');
  const diskFooter = document.getElementById('sys-disk-footer');
  diskVal.textContent = data.disk.percent + '%';
  diskFill.style.width = data.disk.percent + '%';
  diskFill.className = 'progress-fill ' + (data.disk.percent > 90 ? 'high' : data.disk.percent > 70 ? 'med' : '');
  diskFooter.textContent = (data.disk.used / 1e9).toFixed(1) + ' / ' + (data.disk.total / 1e9).toFixed(1) + ' GB';

  // Top Processes
  const procContainer = document.getElementById('top-processes');
  procContainer.innerHTML = '';
  data.topProcesses.forEach(p => {
    const div = document.createElement('div');
    div.className = 'process-item';
    div.innerHTML = `
      <span class="process-name" title="${p.name}">${p.name}</span>
      <span class="process-stats">${p.cpu.toFixed(1)}% CPU | ${(p.rss / 1e6).toFixed(0)}MB</span>
    `;
    procContainer.appendChild(div);
  });
}
function renderProjects() {
  if (projectsData.length === 0) {
    emptyState.classList.remove('hidden');
    Array.from(projectsGrid.children).forEach(function(child) {
      if (child !== emptyState) child.remove();
    });
    projectCountEl.textContent = '0 PROJECTS';
    return;
  }

  emptyState.classList.add('hidden');
  projectCountEl.textContent = projectsData.length + ' PROJECT' + (projectsData.length > 1 ? 'S' : '');

  Array.from(projectsGrid.children).forEach(function(child) {
    if (child !== emptyState) child.remove();
  });

  projectsData.forEach(function(p) {
    var isRunning = p.status === 'running';
    var isStopped = p.status === 'stopped';
    var isPartial = p.status === 'partial';

    var card = document.createElement('div');
    card.className = 'project-card status-' + p.status;

    var btnText = isStopped ? 'UNSNOOZE' : 'SNOOZE';
    var btnIcon = isStopped ? '⚡' : '😴';
    var statusLabel = isRunning ? 'RUNNING' : isStopped ? 'SNOOZED' : isPartial ? 'PARTIAL' : 'UNKNOWN';
    var pathTail = '...' + p.compose_path.slice(-30);

    card.innerHTML =
      '<button class="btn-delete-project" onclick="confirmDeleteProject(' + p.id + ', \'' + p.name.replace(/'/g, "\\'") + '\')" title="Remove Project">✕</button>' +
      '<div class="pc-header">' +
        '<div class="pc-title-wrap">' +
          '<div class="pc-name" title="' + p.name + '">' + p.name + '</div>' +
          '<div class="pc-path" title="' + p.compose_path + '">' + pathTail + '</div>' +
        '</div>' +
        '<div class="pc-status-badge">' + statusLabel + '</div>' +
      '</div>' +
      '<div class="pc-stats">' +
        '<div class="pc-stat">' +
          '<div class="pc-stat-label">CONTAINERS</div>' +
          '<div class="pc-stat-val">' + (p.containers ? p.containers.length : 0) + '</div>' +
        '</div>' +
        '<div class="pc-stat">' +
          '<div class="pc-stat-label">UPTIME</div>' +
          '<div class="pc-stat-val">' + (isRunning ? 'Online' : '—') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pc-actions">' +
        '<button class="btn-toggle-power" onclick="confirmTogglePower(' + p.id + ', \'' + p.status + '\')">' +
          '<span>' + btnIcon + '</span>' +
          '<span>' + btnText + '</span>' +
        '</button>' +
        '<button class="btn-manage" onclick="openSchedulesModal(' + p.id + ')" title="Manage Schedules">⏱️</button>' +
      '</div>';

    projectsGrid.appendChild(card);
  });
}

function updateStatsBar() {
  var running = projectsData.filter(function(p) { return p.status === 'running' || p.status === 'partial'; }).length;
  var stopped = projectsData.filter(function(p) { return p.status === 'stopped'; }).length;
  statRunningVal.textContent = running;
  statStoppedVal.textContent = stopped;
}

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    logContainer.innerHTML = '<div class="log-empty">No activity recorded yet</div>';
    return;
  }

  logContainer.innerHTML = '';
  logs.forEach(function(log) {
    var time = new Date(log.created_at).toLocaleTimeString('en-US', { hour12: false });
    var div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML =
      '<div class="log-time">[' + time + ']</div>' +
      '<div class="log-project">' + (log.project_name || 'System') + '</div>' +
      '<div class="log-action">' + log.action.toUpperCase() + '</div>' +
      '<div class="log-status ' + log.status + '">' + log.status.toUpperCase() + '</div>' +
      '<div class="log-msg">' + log.message + '</div>' +
      '<div class="log-trigger">[' + log.triggered_by + ']</div>';
    logContainer.appendChild(div);
  });
}

// ── Actions ──
var confirmCallback = null;
function openConfirm(title, message, callback) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  confirmCallback = callback;
  document.getElementById('modal-confirm').classList.remove('hidden');
}

document.getElementById('btn-confirm-action').addEventListener('click', function() {
  if (confirmCallback) confirmCallback();
  closeModal('modal-confirm');
});

function confirmTogglePower(projectId, currentStatus) {
  var p = projectsData.find(function(x) { return x.id === projectId; });
  if (!p) return;

  var action = currentStatus === 'stopped' ? 'unsnooze' : 'snooze';
  var title = action.toUpperCase() + ' PROJECT';
  var msg = 'Are you sure you want to ' + action + ' ' + p.name + '?';

  openConfirm(title, msg, async function() {
    showToast('Executing', 'Sending ' + action + ' command...', 'success');
    try {
      var res = await fetch('/api/projects/' + projectId + '/' + action, { method: 'POST' });
      var data = await res.json();
      if (res.ok) {
        showToast('Success', data.message, 'success');
        fetchProjects();
        setTimeout(fetchLogs, 2000);
      } else {
        showToast('Error', data.error, 'error');
      }
    } catch (e) {
      showToast('Error', e.message, 'error');
    }
  });
}

function confirmDeleteProject(projectId, name) {
  openConfirm('REMOVE PROJECT', 'Stop managing ' + name + '? (This will NOT delete your docker files)', async function() {
    await fetch('/api/projects/' + projectId, { method: 'DELETE' });
    showToast('Removed', 'Project removed from portal', 'success');
    fetchProjects();
  });
}

// ── Add Project Modal ──
document.getElementById('btn-add-project').addEventListener('click', function() {
  document.getElementById('input-project-name').value = '';
  document.getElementById('input-compose-path').value = '';
  document.getElementById('modal-add-project').classList.remove('hidden');
});

function populateQuickPaths() {
  var chipsContainer = document.getElementById('quick-path-chips');
  var commonPaths = [
    '/home/user/projects/my-app/docker-compose.yml',
    '/home/user/projects/my-app/infrastructure/docker/docker-compose.yml'
  ];

  commonPaths.forEach(function(p) {
    var btn = document.createElement('button');
    btn.className = 'path-chip';
    btn.textContent = p.split('/').pop() + ' (' + p.split('/').slice(-2,-1)[0] + ')';
    btn.title = p;
    btn.onclick = function() {
      document.getElementById('input-compose-path').value = p;
      if (!document.getElementById('input-project-name').value) {
        document.getElementById('input-project-name').value = p.split('/').slice(-2,-1)[0];
      }
    };
    chipsContainer.appendChild(btn);
  });
}

document.getElementById('btn-confirm-add-project').addEventListener('click', async function() {
  var name = document.getElementById('input-project-name').value;
  var composePath = document.getElementById('input-compose-path').value;

  if (!name || !composePath) return showToast('Error', 'Fill all fields', 'error');

  try {
    var res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, compose_path: composePath })
    });
    if (res.ok) {
      showToast('Added', 'Project registered', 'success');
      closeModal('modal-add-project');
      fetchProjects();
    } else {
      var data = await res.json();
      showToast('Error', data.error, 'error');
    }
  } catch (e) {
    showToast('Error', e.message, 'error');
  }
});

// ── Schedules Modal ──
var scheduleState = {
  action: 'snooze',
  hour: 1,
  minute: 0,
  recurrence: 'daily',
  days: [1,2,3,4,5,6,0]
};

async function openSchedulesModal(projectId) {
  currentProjectId = projectId;
  var p = projectsData.find(function(x) { return x.id === projectId; });
  document.getElementById('modal-schedules-project-name').textContent = p.compose_path;
  document.getElementById('modal-schedules').classList.remove('hidden');

  await fetchSchedules(projectId);
  updateCronPreview();
}

async function fetchSchedules(projectId) {
  var res = await fetch('/api/projects/' + projectId + '/schedules');
  var data = await res.json();
  schedulesData = data.schedules;
  renderSchedulesList();
}

function renderSchedulesList() {
  var list = document.getElementById('schedules-list');
  if (schedulesData.length === 0) {
    list.innerHTML = '<div class="schedule-empty">No schedules configured for this project</div>';
    return;
  }

  list.innerHTML = '';
  schedulesData.forEach(function(s) {
    var isSnooze = s.action === 'snooze';
    var div = document.createElement('div');
    div.className = 'schedule-item' + (!s.enabled ? ' disabled' : '');
    div.innerHTML =
      '<div class="sch-icon">' + (isSnooze ? '😴' : '⚡') + '</div>' +
      '<div class="sch-info">' +
        '<div class="sch-time">' + s.action.toUpperCase() + '</div>' +
        '<div class="sch-desc">' + (s.description || 'Scheduled task') + ' <span class="sch-cron">' + s.cron_expression + '</span></div>' +
      '</div>' +
      '<div class="sch-actions">' +
        '<div class="toggle-switch ' + (s.enabled ? 'on' : '') + '" onclick="toggleSchedule(' + s.id + ')"></div>' +
        '<button class="btn-del-sch" onclick="deleteSchedule(' + s.id + ')">✕</button>' +
      '</div>';
    list.appendChild(div);
  });
}

// ── Schedule Form Interactions ──
document.querySelectorAll('.action-btn').forEach(function(btn) {
  btn.addEventListener('click', function(e) {
    document.querySelectorAll('.action-btn').forEach(function(b) { b.classList.remove('active'); });
    var target = e.currentTarget;
    target.classList.add('active');
    scheduleState.action = target.dataset.action;
  });
});

document.querySelectorAll('.rec-tab').forEach(function(btn) {
  btn.addEventListener('click', function(e) {
    document.querySelectorAll('.rec-tab').forEach(function(b) { b.classList.remove('active'); });
    var target = e.currentTarget;
    target.classList.add('active');
    scheduleState.recurrence = target.dataset.rec;

    if (scheduleState.recurrence === 'custom') {
      document.getElementById('day-picker-group').classList.remove('hidden');
    } else {
      document.getElementById('day-picker-group').classList.add('hidden');
    }
    updateCronPreview();
  });
});

document.querySelectorAll('.day-chip').forEach(function(btn) {
  btn.addEventListener('click', function(e) {
    e.target.classList.toggle('active');
    updateCronPreview();
  });
});

// Time wheels
document.querySelectorAll('.wheel-arrow').forEach(function(btn) {
  btn.addEventListener('click', function(e) {
    var wheel = e.target.dataset.wheel;
    var dir = e.target.dataset.dir;

    if (wheel === 'hour') {
      if (dir === 'up') scheduleState.hour = (scheduleState.hour + 1) % 24;
      else scheduleState.hour = (scheduleState.hour - 1 + 24) % 24;
      document.getElementById('wheel-hour').textContent = scheduleState.hour.toString().padStart(2, '0');
    } else {
      if (dir === 'up') scheduleState.minute = (scheduleState.minute + 5) % 60;
      else scheduleState.minute = (scheduleState.minute - 5 + 60) % 60;
      document.getElementById('wheel-minute').textContent = scheduleState.minute.toString().padStart(2, '0');
    }
    updateCronPreview();
  });
});

function updateCronPreview() {
  var m = scheduleState.minute;
  var h = scheduleState.hour;
  var d = '*';
  var human = 'At ' + h.toString().padStart(2,'0') + ':' + m.toString().padStart(2,'0');

  if (scheduleState.recurrence === 'daily') { d = '*'; human = 'Every day ' + human; }
  else if (scheduleState.recurrence === 'weekdays') { d = '1-5'; human = 'On weekdays ' + human; }
  else if (scheduleState.recurrence === 'weekends') { d = '0,6'; human = 'On weekends ' + human; }
  else {
    var activeDays = Array.from(document.querySelectorAll('.day-chip.active')).map(function(el) { return el.dataset.day; });
    if (activeDays.length === 0) d = 'none';
    else if (activeDays.length === 7) d = '*';
    else { d = activeDays.sort().join(','); human = 'On selected days ' + human; }
  }

  var cron = m + ' ' + h + ' * * ' + d;
  document.getElementById('cron-preview').textContent = cron;
  document.getElementById('cron-human').textContent = human;
}

document.getElementById('btn-add-schedule').addEventListener('click', async function() {
  var desc = document.getElementById('input-schedule-desc').value;
  var cron = document.getElementById('cron-preview').textContent;

  if (cron.includes('none')) return showToast('Error', 'Select at least one day', 'error');

  var payload = {
    project_id: currentProjectId,
    action: scheduleState.action,
    cron_expression: cron,
    description: desc,
    recurrence_type: scheduleState.recurrence
  };

  try {
    var res = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast('Success', 'Schedule added', 'success');
      document.getElementById('input-schedule-desc').value = '';
      fetchSchedules(currentProjectId);
    }
  } catch (e) {
    showToast('Error', e.message, 'error');
  }
});

async function toggleSchedule(id) {
  await fetch('/api/schedules/' + id + '/toggle', { method: 'PATCH' });
  fetchSchedules(currentProjectId);
}

async function deleteSchedule(id) {
  if (confirm('Delete schedule?')) {
    await fetch('/api/schedules/' + id, { method: 'DELETE' });
    fetchSchedules(currentProjectId);
  }
}

// ── Generic ──
function setupEventListeners() {
  document.querySelectorAll('.modal-close, [data-close]').forEach(function(el) {
    el.addEventListener('click', function(e) {
      var target = e.currentTarget.dataset.close || e.currentTarget.closest('.modal-overlay').id;
      closeModal(target);
    });
  });

  document.getElementById('btn-refresh-logs').addEventListener('click', fetchLogs);
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function showToast(title, msg, type) {
  type = type || 'success';
  var container = document.getElementById('toast-container');
  var toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.innerHTML = '<div class="toast-title">' + title + '</div><div class="toast-msg">' + msg + '</div>';
  container.appendChild(toast);

  setTimeout(function() {
    toast.classList.add('hiding');
    setTimeout(function() { toast.remove(); }, 300);
  }, 4000);
}

// Boot
initAuth();
