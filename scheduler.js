/**
 * Schedule Engine v1
 * 
 * Unified scheduling system for the Trenches Agent.
 * Maintains an in-memory schedule registry and evaluates entries
 * every 30 seconds using simple time + day matching.
 * 
 * Features register schedules via register(). The engine calls
 * action handlers when conditions match. Prevents duplicate
 * execution using last_run tracking.
 */
'use strict';

const name = 'scheduler';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ─── Registry ───
const _schedules = new Map(); // id → schedule entry
const _handlers = new Map();  // type → handler function
let _interval = null;
let _ctx = null;

/**
 * Register an action handler for a schedule type.
 * @param {string} type  - e.g. "purge_toggle", "restart", "auto_restart_check"
 * @param {function} handler - async (schedule, ctx) => void
 */
function registerHandler(type, handler) {
  _handlers.set(type, handler);
  if (_ctx) _ctx.log(`[Scheduler] Handler registered: ${type}`, 'info');
}

/**
 * Register a schedule entry.
 * @param {object} entry
 * @param {string} entry.id         - unique ID
 * @param {string} entry.type       - handler type
 * @param {boolean} entry.enabled   - active or not
 * @param {string[]} [entry.days]   - weekday filter (empty = every day)
 * @param {string} [entry.time]     - "HH:mm" match (null = every cycle)
 * @param {object} [entry.meta]     - arbitrary metadata for the handler
 */
function register(entry) {
  if (!entry || !entry.id || !entry.type) {
    if (_ctx) _ctx.log(`[Scheduler] Invalid schedule entry — missing id or type`, 'warn');
    return;
  }
  _schedules.set(entry.id, {
    id: entry.id,
    type: entry.type,
    enabled: entry.enabled !== false,
    days: Array.isArray(entry.days) ? entry.days : [],
    time: entry.time || null,
    meta: entry.meta || {},
    last_run: null,
    last_result: null,
  });
  if (_ctx) _ctx.log(`[Scheduler] Schedule registered: ${entry.id} (type=${entry.type})`, 'info');
}

/**
 * Remove a schedule entry.
 */
function unregister(id) {
  _schedules.delete(id);
}

/**
 * Update a schedule entry (partial).
 */
function update(id, changes) {
  const existing = _schedules.get(id);
  if (!existing) return;
  if (changes.enabled !== undefined) existing.enabled = !!changes.enabled;
  if (changes.days !== undefined) existing.days = Array.isArray(changes.days) ? changes.days : existing.days;
  if (changes.time !== undefined) existing.time = changes.time;
  if (changes.meta !== undefined) existing.meta = { ...existing.meta, ...changes.meta };
  // Reset last_run to allow re-evaluation
  if (changes.days !== undefined || changes.time !== undefined) {
    existing.last_run = null;
  }
}

// ─── Matching Logic ───

function getCurrentDay() {
  return DAY_NAMES[new Date().getDay()];
}

function getCurrentTime() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function getRunKey(schedule) {
  // For time-based schedules: "YYYY-MM-DD HH:mm"
  // For cycle-based schedules (no time): "YYYY-MM-DD HH:mm" rounded to minute
  const now = new Date();
  if (schedule.time) {
    // Run once per day for time-based schedules
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${schedule.time}`;
  }
  // Cycle-based: run once per minute
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${getCurrentTime()}`;
}

function shouldRun(schedule) {
  if (!schedule.enabled) return false;

  // Day filter
  if (schedule.days.length > 0) {
    if (!schedule.days.includes(getCurrentDay())) return false;
  }

  // Time filter — only match within ±1 minute window
  if (schedule.time) {
    const current = getCurrentTime();
    if (current !== schedule.time) return false;
  }

  // Duplicate prevention
  const runKey = getRunKey(schedule);
  if (schedule.last_run === runKey) return false;

  return true;
}

// ─── Evaluation Loop ───

async function evaluate() {
  if (!_ctx) return;

  for (const [, schedule] of _schedules) {
    if (!shouldRun(schedule)) continue;

    const handler = _handlers.get(schedule.type);
    if (!handler) {
      _ctx.log(`[Scheduler] No handler for type: ${schedule.type}`, 'warn');
      continue;
    }

    // Safety checks
    if (_ctx.system && _ctx.system.isCircuitBreakerOpen()) {
      _ctx.log(`[Scheduler] Circuit breaker open — skipping ${schedule.id}`, 'warn');
      continue;
    }

    // Mark as run BEFORE executing to prevent duplicate triggers
    const runKey = getRunKey(schedule);
    schedule.last_run = runKey;

    try {
      _ctx.log(`[Scheduler] Executing: ${schedule.id} (type=${schedule.type})`, 'info');
      await handler(schedule, _ctx);
      schedule.last_result = 'success';
    } catch (err) {
      schedule.last_result = `error: ${err.message}`;
      _ctx.log(`[Scheduler] Error in ${schedule.id}: ${err.message}`, 'error');
    }
  }
}

// ─── Next Run Calculation ───

function getNextRun(schedule) {
  if (!schedule.enabled) return null;

  const now = new Date();

  // Cycle-based (no time set) — next run is ~30s from now (next eval cycle)
  if (!schedule.time) {
    // If day filter exists and today isn't in it, find next matching day
    if (schedule.days.length > 0 && !schedule.days.includes(getCurrentDay())) {
      return getNextMatchingDay(schedule.days, schedule.time);
    }
    const next = new Date(now.getTime() + 30000);
    return next.toISOString();
  }

  // Time-based — find next occurrence
  return getNextMatchingDay(schedule.days, schedule.time);
}

function getNextMatchingDay(days, time) {
  const now = new Date();
  const [targetH, targetM] = time ? time.split(':').map(Number) : [now.getHours(), now.getMinutes()];

  // Check up to 8 days ahead (today + 7)
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(targetH, targetM, 0, 0);

    // Skip if in the past
    if (candidate <= now) continue;

    // Check day filter
    if (days.length > 0) {
      const dayName = DAY_NAMES[candidate.getDay()];
      if (!days.includes(dayName)) continue;
    }

    return candidate.toISOString();
  }

  return null;
}

// ─── Public API ───

function getSchedules() {
  const result = [];
  for (const [, s] of _schedules) {
    result.push({
      id: s.id,
      type: s.type,
      enabled: s.enabled,
      days: s.days,
      time: s.time,
      last_run: s.last_run,
      last_result: s.last_result,
      meta: s.meta,
      next_run: getNextRun(s),
    });
  }
  return result;
}

function getSchedule(id) {
  const s = _schedules.get(id);
  if (!s) return null;
  return { ...s, next_run: getNextRun(s) };
}

// ─── Lifecycle ───

function init(ctx) {
  _ctx = ctx;

  // Evaluate every 30 seconds
  _interval = setInterval(() => {
    try { evaluate(); } catch (err) {
      _ctx.log(`[Scheduler] Evaluate error: ${err.message}`, 'error');
    }
  }, 30000);

  // Deferred initial evaluation
  setTimeout(() => {
    try { evaluate(); } catch (err) {
      _ctx.log(`[Scheduler] Initial evaluate error: ${err.message}`, 'error');
    }
  }, 5000);

  _ctx.log('[Scheduler] Engine initialized (30s cycle)', 'info');
}

function shutdown() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  _schedules.clear();
  _handlers.clear();
}

module.exports = {
  name,
  init,
  shutdown,
  register,
  unregister,
  update,
  registerHandler,
  getSchedules,
  getSchedule,
};
