// scheduler.js — node-cron based schedule manager
const cron = require('node-cron');
const { getAllEnabledSchedules, addLog, getProjectById, getLogs } = require('./db');
const { snoozeProject, unsnoozeProject } = require('./docker-manager');

// Map of scheduleId => cron.ScheduledTask
const activeTasks = new Map();

/**
 * Execute a scheduled action.
 */
async function executeScheduledAction(scheduleId, projectId, projectName, composePath, action) {
  console.log(`[Scheduler] Executing ${action} on "${projectName}" (schedule #${scheduleId})`);
  try {
    if (action === 'snooze') {
      await snoozeProject(composePath);
    } else if (action === 'unsnooze') {
      await unsnoozeProject(composePath);
    }
    addLog(projectId, projectName, action, 'success', `Scheduled ${action} completed`, 'schedule');
    console.log(`[Scheduler] ✓ ${action} on "${projectName}" succeeded`);
  } catch (err) {
    addLog(projectId, projectName, action, 'error', err.message, 'schedule');
    console.error(`[Scheduler] ✗ ${action} on "${projectName}" failed:`, err.message);
  }
}

/**
 * Register a single schedule as a cron job.
 */
function registerSchedule(schedule) {
  // Stop any existing task for this schedule id
  stopSchedule(schedule.id);

  if (!schedule.enabled) return;

  if (!cron.validate(schedule.cron_expression)) {
    console.warn(`[Scheduler] Invalid cron expression for schedule #${schedule.id}: "${schedule.cron_expression}"`);
    return;
  }

  const task = cron.schedule(schedule.cron_expression, () => {
    executeScheduledAction(
      schedule.id,
      schedule.project_id,
      schedule.project_name || schedule.name,
      schedule.compose_path,
      schedule.action
    );
  }, {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'
  });

  activeTasks.set(schedule.id, task);
  console.log(`[Scheduler] ✓ Registered schedule #${schedule.id} — ${schedule.action} on "${schedule.project_name}" (${schedule.cron_expression})`);
}

/**
 * Stop and remove a cron job for a schedule.
 */
function stopSchedule(scheduleId) {
  if (activeTasks.has(scheduleId)) {
    activeTasks.get(scheduleId).stop();
    activeTasks.delete(scheduleId);
  }
}

/**
 * Calculates the most recent past occurrence of a daily cron expression.
 */
function getMostRecentExecutionTime(cronExpression) {
  const parts = cronExpression.split(' ');
  // Only support basic daily cron for catchup "mm hh * * *"
  if (parts.length === 5 && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    const min = parseInt(parts[0], 10);
    const hr = parseInt(parts[1], 10);
    if (!isNaN(min) && !isNaN(hr)) {
      const now = new Date();
      const expected = new Date();
      expected.setHours(hr, min, 0, 0);
      if (now < expected) {
        expected.setDate(expected.getDate() - 1);
      }
      return expected;
    }
  }
  return null;
}

/**
 * Catch up on schedules that were missed (e.g. if the host OS went to sleep).
 * Evaluates the "dominant" (most recently passed) schedule for each project
 * and enforces it if there's no log indicating the user/system acted since then.
 */
async function catchUpMissedSchedules() {
  try {
    const schedules = getAllEnabledSchedules();
    const projectSchedules = {};
    for (const s of schedules) {
      if (!projectSchedules[s.project_id]) projectSchedules[s.project_id] = [];
      projectSchedules[s.project_id].push(s);
    }

    const allLogs = getLogs(500);

    for (const projectId in projectSchedules) {
      const pSchedules = projectSchedules[projectId];
      let dominantSchedule = null;
      let maxExpectedTime = null;

      // Find the schedule that should have triggered most recently
      for (const s of pSchedules) {
        const execTime = getMostRecentExecutionTime(s.cron_expression);
        if (execTime) {
          if (!maxExpectedTime || execTime > maxExpectedTime) {
            maxExpectedTime = execTime;
            dominantSchedule = s;
          }
        }
      }

      if (dominantSchedule && maxExpectedTime) {
        const pLogs = allLogs.filter(l => l.project_id === parseInt(projectId, 10) && l.status === 'success');
        let needsCatchup = false;

        if (pLogs.length === 0) {
          needsCatchup = true;
        } else {
          // DB created_at is UTC string without 'Z', e.g. "2026-05-15 22:36:41"
          const lastLogTime = new Date(pLogs[0].created_at + 'Z');
          if (maxExpectedTime > lastLogTime) {
            needsCatchup = true;
          }
        }

        if (needsCatchup) {
          console.log(`[Scheduler] Catching up missed schedule #${dominantSchedule.id} (${dominantSchedule.action}) for project "${dominantSchedule.project_name}" (Expected: ${maxExpectedTime.toLocaleString()})`);
          await executeScheduledAction(
            dominantSchedule.id,
            dominantSchedule.project_id,
            dominantSchedule.project_name || dominantSchedule.name,
            dominantSchedule.compose_path,
            dominantSchedule.action
          );
        }
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error during catch-up sweep:', err.message);
  }
}

/**
 * Boot: Load all enabled schedules from DB and register them.
 */
function initScheduler() {
  const schedules = getAllEnabledSchedules();
  console.log(`[Scheduler] Initializing ${schedules.length} schedule(s)...`);
  for (const schedule of schedules) {
    registerSchedule(schedule);
  }
  console.log(`[Scheduler] Ready — ${activeTasks.size} active cron job(s)`);

  // Start catch-up loops to recover missed schedules during sleep/suspension
  setTimeout(catchUpMissedSchedules, 5000); // 5 seconds after boot
  setInterval(catchUpMissedSchedules, 5 * 60 * 1000); // every 5 minutes
}

/**
 * Get count of active tasks.
 */
function getActiveTaskCount() {
  return activeTasks.size;
}

module.exports = { initScheduler, registerSchedule, stopSchedule, getActiveTaskCount };
