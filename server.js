// server.js — Express API server
const { ready } = require('./db');
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const {
  getProjects, getProjectById, createProject, deleteProject,
  getSchedules, getSchedulesByProject, getScheduleById, getAllEnabledSchedules,
  createSchedule, updateSchedule, toggleSchedule, deleteSchedule,
  addLog, getLogs
} = require('./db');
const { getProjectStatus, snoozeProject, unsnoozeProject, getProjectStats } = require('./docker-manager');
const { initScheduler, registerSchedule, stopSchedule, getActiveTaskCount } = require('./scheduler');
const auth = require('./auth');

// ── CPU Usage tracker (sampled between requests) ──────────
let lastCpuInfo = os.cpus().map(c => ({ ...c.times }));

function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;

  cpus.forEach((cpu, i) => {
    const prev = lastCpuInfo[i] || cpu.times;
    const idleDelta = cpu.times.idle - prev.idle;
    const totalDelta = (cpu.times.user - prev.user)
      + (cpu.times.nice - prev.nice)
      + (cpu.times.sys - prev.sys)
      + (cpu.times.idle - prev.idle)
      + (cpu.times.irq - prev.irq);
    totalIdle += idleDelta;
    totalTick += totalDelta;
  });

  lastCpuInfo = cpus.map(c => ({ ...c.times }));
  const usage = totalTick > 0 ? ((1 - totalIdle / totalTick) * 100) : 0;
  return Math.round(usage * 10) / 10;
}

function getDiskUsage() {
  try {
    const output = execSync('df -k / | tail -1', { encoding: 'utf-8', timeout: 3000 });
    const parts = output.trim().split(/\s+/);
    const totalKB = parseInt(parts[1]) || 0;
    const usedKB = parseInt(parts[2]) || 0;
    const availKB = parseInt(parts[3]) || 0;
    return {
      total: totalKB * 1024,
      used: usedKB * 1024,
      available: availKB * 1024,
      percent: totalKB > 0 ? Math.round((usedKB / totalKB) * 1000) / 10 : 0
    };
  } catch {
    return { total: 0, used: 0, available: 0, percent: 0 };
  }
}

function getTopProcesses() {
  try {
    const output = execSync(
      'ps -eo pcpu,pmem,rss,comm | sort -k1 -rn | head -8',
      { encoding: 'utf-8', timeout: 3000 }
    );
    return output.trim().split('\n').slice(1).map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        cpu: parseFloat(parts[0]) || 0,
        mem: parseFloat(parts[1]) || 0,
        rss: (parseInt(parts[2]) || 0) * 1024,
        name: parts.slice(3).join(' ').split('/').pop()
      };
    }).filter(p => p.name && p.cpu > 0);
  } catch {
    return [];
  }
}

const app = express();
const PORT = process.env.PORT || 4242;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Utility ────────────────────────────────────────────────
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Authentication Middleware ──────────────────────────────
app.use('/api', (req, res, next) => {
  // Allow auth routes and healthcheck to bypass authentication
  if (req.path.startsWith('/auth/') || req.path === '/health') {
    return next();
  }

  const authConfig = auth.getAuthConfig();
  // If not configured yet, deny access to protected APIs
  if (!authConfig) {
    return res.status(403).json({ error: 'Authentication not configured. Please complete setup.' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];
  const payload = auth.verifyJWT(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }

  req.user = payload;
  next();
});

// ── Auth Endpoints ─────────────────────────────────────────

// GET /api/auth/status — Check if setup is needed and if token is valid
app.get('/api/auth/status', (req, res) => {
  const authConfig = auth.getAuthConfig();
  if (!authConfig) {
    return res.json({ configured: false, authenticated: false });
  }

  const authHeader = req.headers.authorization;
  let authenticated = false;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    if (auth.verifyJWT(token)) {
      authenticated = true;
    }
  }

  res.json({ configured: true, authenticated });
});

// POST /api/auth/setup — Initiate setup (returns TOTP secret and QR)
app.post('/api/auth/setup', async (req, res) => {
  const authConfig = auth.getAuthConfig();
  if (authConfig) {
    return res.status(400).json({ error: 'Already configured' });
  }

  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const secret = auth.generateTOTPSecret();
  const qrCode = await auth.generateQRCode(secret);
  const passwordHash = auth.hashPassword(password);

  res.json({ secret, qrCode, passwordHash });
});

// POST /api/auth/verify-setup — Finalize setup with first TOTP code
app.post('/api/auth/verify-setup', (req, res) => {
  const authConfig = auth.getAuthConfig();
  if (authConfig) {
    return res.status(400).json({ error: 'Already configured' });
  }

  const { token, secret, passwordHash } = req.body;
  if (!token || !secret || !passwordHash) {
    return res.status(400).json({ error: 'Missing required setup fields' });
  }

  if (!auth.verifyTOTP(token, secret)) {
    return res.status(401).json({ error: 'Invalid TOTP code' });
  }

  const jwtSecret = require('crypto').randomBytes(32).toString('hex');
  auth.saveAuthConfig({ secret, passwordHash, jwtSecret });
  const jwtToken = auth.generateJWT();
  res.json({ success: true, token: jwtToken });
});

// POST /api/auth/login — Login with password OR TOTP code
app.post('/api/auth/login', (req, res) => {
  const authConfig = auth.getAuthConfig();
  if (!authConfig) {
    return res.status(400).json({ error: 'Auth not configured' });
  }

  const { password, token } = req.body;
  console.log('[Auth Login] password provided:', !!password, '| token provided:', !!token, '| token value:', token);
  if (!password && !token) {
    return res.status(400).json({ error: 'Password or TOTP code required' });
  }

  let isValid = false;

  if (password && auth.verifyPassword(password, authConfig.passwordHash)) {
    console.log('[Auth Login] Password verified OK');
    isValid = true;
  } else if (password) {
    console.log('[Auth Login] Password verification FAILED');
  }

  if (token && auth.verifyTOTP(token, authConfig.secret)) {
    console.log('[Auth Login] TOTP verified OK');
    isValid = true;
  } else if (token) {
    console.log('[Auth Login] TOTP verification FAILED');
  }

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const jwtToken = auth.generateJWT();
  res.json({ success: true, token: jwtToken });
});

// ── Projects ───────────────────────────────────────────────

// GET /api/projects — List all projects with live Docker status
app.get('/api/projects', asyncHandler(async (req, res) => {
  const projects = getProjects();
  const enriched = await Promise.all(
    projects.map(async (p) => {
      const status = await getProjectStatus(p.compose_path);
      return { ...p, ...status };
    })
  );
  res.json({ projects: enriched, activeSchedules: getActiveTaskCount() });
}));

// POST /api/projects — Register a new project
app.post('/api/projects', asyncHandler(async (req, res) => {
  const { name, compose_path } = req.body;
  if (!name || !compose_path) {
    return res.status(400).json({ error: 'name and compose_path are required' });
  }
  const result = createProject(name.trim(), compose_path.trim());
  const project = getProjectById(result.lastInsertRowid);
  res.status(201).json({ project });
}));

// DELETE /api/projects/:id — Remove a project
app.delete('/api/projects/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const project = getProjectById(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  deleteProject(id);
  res.json({ success: true });
}));

// GET /api/projects/:id/status — Live status of a single project
app.get('/api/projects/:id/status', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const project = getProjectById(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const status = await getProjectStatus(project.compose_path);
  res.json({ ...project, ...status });
}));

// GET /api/projects/:id/stats — Container memory/CPU stats
app.get('/api/projects/:id/stats', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const project = getProjectById(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const stats = await getProjectStats(project.compose_path);
  res.json({ stats });
}));

// POST /api/projects/:id/snooze — Immediately snooze a project
app.post('/api/projects/:id/snooze', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const project = getProjectById(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    await snoozeProject(project.compose_path);
    addLog(id, project.name, 'snooze', 'success', 'Manual snooze executed', 'manual');
    res.json({ success: true, message: `"${project.name}" has been snoozed` });
  } catch (err) {
    addLog(id, project.name, 'snooze', 'error', err.message, 'manual');
    res.status(500).json({ error: err.message });
  }
}));

// POST /api/projects/:id/unsnooze — Immediately unsnooze a project
app.post('/api/projects/:id/unsnooze', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const project = getProjectById(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    await unsnoozeProject(project.compose_path);
    addLog(id, project.name, 'unsnooze', 'success', 'Manual unsnooze executed', 'manual');
    res.json({ success: true, message: `"${project.name}" has been unsnoozed` });
  } catch (err) {
    addLog(id, project.name, 'unsnooze', 'error', err.message, 'manual');
    res.status(500).json({ error: err.message });
  }
}));

// ── Schedules ──────────────────────────────────────────────

// GET /api/schedules — All schedules
app.get('/api/schedules', asyncHandler(async (req, res) => {
  const schedules = getSchedules();
  res.json({ schedules });
}));

// GET /api/projects/:id/schedules — Schedules for a project
app.get('/api/projects/:id/schedules', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const schedules = getSchedulesByProject(id);
  res.json({ schedules });
}));

// POST /api/schedules — Create a new schedule
app.post('/api/schedules', asyncHandler(async (req, res) => {
  const { project_id, action, cron_expression, description, recurrence_type } = req.body;
  if (!project_id || !action || !cron_expression) {
    return res.status(400).json({ error: 'project_id, action, and cron_expression are required' });
  }
  if (!['snooze', 'unsnooze'].includes(action)) {
    return res.status(400).json({ error: 'action must be "snooze" or "unsnooze"' });
  }

  const project = getProjectById(project_id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const result = createSchedule(project_id, action, cron_expression, description, recurrence_type || 'custom');
  const schedule = getScheduleById(result.lastInsertRowid);

  // Register cron job immediately
  registerSchedule({ ...schedule, project_name: project.name, compose_path: project.compose_path });

  res.status(201).json({ schedule });
}));

// PUT /api/schedules/:id — Update a schedule
app.put('/api/schedules/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const existing = getScheduleById(id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  const { action, cron_expression, description, recurrence_type } = req.body;
  updateSchedule(id, action || existing.action, cron_expression || existing.cron_expression, description, recurrence_type || existing.recurrence_type);

  const schedule = getScheduleById(id);
  const project = getProjectById(schedule.project_id);

  // Re-register the cron job
  registerSchedule({ ...schedule, project_name: project.name, compose_path: project.compose_path });

  res.json({ schedule });
}));

// PATCH /api/schedules/:id/toggle — Enable/disable a schedule
app.patch('/api/schedules/:id/toggle', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const existing = getScheduleById(id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  const newEnabled = !existing.enabled;
  toggleSchedule(id, newEnabled);
  const schedule = getScheduleById(id);

  if (newEnabled) {
    const project = getProjectById(schedule.project_id);
    registerSchedule({ ...schedule, project_name: project.name, compose_path: project.compose_path });
  } else {
    stopSchedule(id);
  }

  res.json({ schedule, enabled: newEnabled });
}));

// DELETE /api/schedules/:id — Delete a schedule
app.delete('/api/schedules/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const existing = getScheduleById(id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  stopSchedule(id);
  deleteSchedule(id);
  res.json({ success: true });
}));

// ── Logs ───────────────────────────────────────────────────

// GET /api/logs — Recent activity log
app.get('/api/logs', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = getLogs(limit);
  res.json({ logs });
}));

// ── System Stats ─────────────────────────────────────────────
app.get('/api/system-stats', asyncHandler(async (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = (usedMem / totalMem) * 100;

  const disk = getDiskUsage();
  const cpu = getCpuUsage();
  const processes = getTopProcesses();

  res.json({
    os: {
      platform: os.platform(),
      release: os.release(),
      uptime: os.uptime(),
      loadavg: os.loadavg()
    },
    cpu: {
      cores: os.cpus().length,
      usagePercent: cpu
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usagePercent: Math.round(memPercent * 10) / 10
    },
    disk: disk,
    topProcesses: processes
  });
}));

// ── Health ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeSchedules: getActiveTaskCount(), uptime: process.uptime() });
});

// ── Error handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ error: err.message });
});

// ── Boot ──────────────────────────────────────────────────
ready.then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║  🐳 Docker Snoozing Portal               ║`);
    console.log(`║  Local:   http://localhost:${PORT}           ║`);
    console.log(`║  Network: http://0.0.0.0:${PORT}             ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
    initScheduler();
  });
}).catch(err => {
  console.error('[Boot] DB failed to init:', err.message);
  process.exit(1);
});

