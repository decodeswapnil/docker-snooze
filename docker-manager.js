// docker-manager.js — Docker Engine control via dockerode + child_process
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Utility: run docker compose command ───────────────────
function runDockerCompose(composePath, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(composePath);
    const file = path.basename(composePath);

    const proc = spawn('docker', ['compose', '-f', file, ...args], {
      cwd: dir,
      timeout,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`docker compose ${args[0]} exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

// ── Utility: get container list for a compose project ─────
function getContainersForProject(composePath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(composePath);
    const file = path.basename(composePath);

    execFile(
      'docker',
      ['compose', '-f', file, 'ps', '--format', 'json'],
      { cwd: dir, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));

        let containers = [];
        try {
          // docker compose ps --format json outputs one JSON object per line (not a JSON array)
          const lines = stdout.trim().split('\n').filter(Boolean);
          containers = lines.map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          }).filter(Boolean);
        } catch {
          containers = [];
        }
        resolve(containers);
      }
    );
  });
}

// ── Utility: get container stats (memory usage) ──────────
function getContainerStats(containerId) {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['stats', '--no-stream', '--format', '{{.MemUsage}}\t{{.CPUPerc}}', containerId],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) return resolve({ mem: 'N/A', cpu: 'N/A' });
        const [mem, cpu] = stdout.trim().split('\t');
        resolve({ mem: mem || 'N/A', cpu: cpu || 'N/A' });
      }
    );
  });
}

// ── Public API ─────────────────────────────────────────────

/**
 * Get the status of a Docker Compose project.
 * Returns: { status: 'running'|'stopped'|'partial'|'unknown', containers: [...] }
 */
async function getProjectStatus(composePath) {
  if (!fs.existsSync(composePath)) {
    return { status: 'file_not_found', containers: [], error: 'Compose file not found at: ' + composePath };
  }

  try {
    const containers = await getContainersForProject(composePath);

    if (containers.length === 0) {
      return { status: 'stopped', containers: [] };
    }

    const running = containers.filter((c) => {
      const s = (c.State || c.Status || '').toLowerCase();
      return s === 'running' || s.includes('up');
    });

    let status;
    if (running.length === containers.length) status = 'running';
    else if (running.length === 0) status = 'stopped';
    else status = 'partial';

    const enriched = containers.map((c) => ({
      id: c.ID || c.Id,
      name: c.Name || c.Service || 'unknown',
      service: c.Service || c.Name,
      state: c.State || (c.Status?.includes('Up') ? 'running' : 'stopped'),
      status: c.Status || c.State,
      ports: c.Publishers || [],
    }));

    return { status, containers: enriched };
  } catch (err) {
    return { status: 'unknown', containers: [], error: err.message };
  }
}

/**
 * Snooze (stop) a Docker Compose project.
 */
async function snoozeProject(composePath) {
  if (!fs.existsSync(composePath)) {
    throw new Error('Compose file not found: ' + composePath);
  }
  const result = await runDockerCompose(composePath, ['stop'], 120000);
  return result;
}

/**
 * Unsnooze (start) a Docker Compose project.
 */
async function unsnoozeProject(composePath) {
  if (!fs.existsSync(composePath)) {
    throw new Error('Compose file not found: ' + composePath);
  }
  const result = await runDockerCompose(composePath, ['start'], 120000);
  return result;
}

/**
 * Get per-container memory + CPU stats for a project.
 */
async function getProjectStats(composePath) {
  try {
    const containers = await getContainersForProject(composePath);
    const running = containers.filter((c) => {
      const s = (c.State || '').toLowerCase();
      return s === 'running';
    });

    const stats = await Promise.all(
      running.map(async (c) => {
        const id = c.ID || c.Id;
        const s = id ? await getContainerStats(id) : { mem: 'N/A', cpu: 'N/A' };
        return { name: c.Name || c.Service, ...s };
      })
    );
    return stats;
  } catch {
    return [];
  }
}

module.exports = { getProjectStatus, snoozeProject, unsnoozeProject, getProjectStats };
