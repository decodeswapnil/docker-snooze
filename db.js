// db.js — SQLite database setup and helpers (using sql.js — pure WASM, no native build)
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'snoozing.db');

let db;

// ── Lazy-init helper ───────────────────────────────────────
// sql.js is async to init (loads the WASM binary).
// We initialise once at boot and expose a `ready` promise.
const initSql = require('sql.js');

const ready = initSql().then((SQL) => {
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`PRAGMA foreign_keys = ON;`);

  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      compose_path TEXT   NOT NULL UNIQUE,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      action           TEXT    NOT NULL CHECK(action IN ('snooze', 'unsnooze')),
      cron_expression  TEXT    NOT NULL,
      description      TEXT,
      enabled          INTEGER DEFAULT 1,
      recurrence_type  TEXT    DEFAULT 'custom',
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      project_name TEXT,
      action      TEXT    NOT NULL,
      status      TEXT    NOT NULL,
      message     TEXT,
      triggered_by TEXT   DEFAULT 'manual',
      created_at  DATETIME DEFAULT (datetime('now'))
    );
  `);

  persist();
  console.log('[DB] SQLite ready via sql.js (WASM)');
});

// ── Persistence ────────────────────────────────────────────
function persist() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── Query helpers (synchronous-style wrappers) ─────────────

/** Run a SELECT and return all rows as plain objects */
function all(sql, ...params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/** Run a SELECT and return first row */
function get(sql, ...params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

/** Run an INSERT/UPDATE/DELETE and return { lastInsertRowid, changes } */
function run(sql, ...params) {
  db.run(sql, params);
  const lastInsertRowid = db.exec('SELECT last_insert_rowid() AS r')[0]?.values[0][0] ?? null;
  persist();
  return { lastInsertRowid };
}

// ── Projects ───────────────────────────────────────────────
const getProjects = () => all('SELECT * FROM projects ORDER BY name');
const getProjectById = (id) => get('SELECT * FROM projects WHERE id = ?', id);
const createProject = (name, composePath) =>
  run('INSERT INTO projects (name, compose_path) VALUES (?, ?)', name, composePath);
const deleteProject = (id) => run('DELETE FROM projects WHERE id = ?', id);

// ── Schedules ──────────────────────────────────────────────
const getSchedules = () =>
  all('SELECT s.*, p.name as project_name FROM schedules s LEFT JOIN projects p ON s.project_id = p.id ORDER BY s.created_at DESC');
const getSchedulesByProject = (projectId) =>
  all('SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at DESC', projectId);
const getScheduleById = (id) => get('SELECT * FROM schedules WHERE id = ?', id);
const getAllEnabledSchedules = () =>
  all('SELECT s.*, p.name as project_name, p.compose_path FROM schedules s JOIN projects p ON s.project_id = p.id WHERE s.enabled = 1');
const createSchedule = (projectId, action, cronExpression, description, recurrenceType) =>
  run('INSERT INTO schedules (project_id, action, cron_expression, description, recurrence_type) VALUES (?, ?, ?, ?, ?)',
    projectId, action, cronExpression, description, recurrenceType);
const updateSchedule = (id, action, cronExpression, description, recurrenceType) =>
  run('UPDATE schedules SET action=?, cron_expression=?, description=?, recurrence_type=? WHERE id=?',
    action, cronExpression, description, recurrenceType, id);
const toggleSchedule = (id, enabled) =>
  run('UPDATE schedules SET enabled=? WHERE id=?', enabled ? 1 : 0, id);
const deleteSchedule = (id) => run('DELETE FROM schedules WHERE id = ?', id);

// ── Logs ───────────────────────────────────────────────────
const addLog = (projectId, projectName, action, status, message, triggeredBy = 'manual') =>
  run('INSERT INTO logs (project_id, project_name, action, status, message, triggered_by) VALUES (?, ?, ?, ?, ?, ?)',
    projectId, projectName, action, status, message, triggeredBy);
const getLogs = (limit = 100) =>
  all('SELECT * FROM logs ORDER BY created_at DESC LIMIT ?', limit);

module.exports = {
  ready,
  db: new Proxy({}, { get: () => db }),
  getProjects, getProjectById, createProject, deleteProject,
  getSchedules, getSchedulesByProject, getScheduleById, getAllEnabledSchedules,
  createSchedule, updateSchedule, toggleSchedule, deleteSchedule,
  addLog, getLogs
};
