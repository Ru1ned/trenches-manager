/**
 * Feature: Purge Weekend
 * 
 * Toggles ORP (Offline Raid Protection) based on configured purge days.
 * v60.4: Uses Schedule Engine instead of internal interval loop.
 * 
 * Config stored in SQLite settings:
 *   purge_enabled  — "true" / "false"
 *   purge_days     — JSON array e.g. '["fri","sat","sun"]'
 * 
 * Does NOT restart servers automatically — queues a restart command
 * so the change is applied through the normal command lifecycle.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const name = 'purgeWeekend';
const core = false;

// Internal state
let _ctx = null;
let _lastAppliedDay = null;

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function getCurrentDay() {
  return DAY_NAMES[new Date().getDay()];
}

function getConfig() {
  if (!_ctx) return { enabled: false, days: ['fri', 'sat', 'sun'] };
  const enabled = _ctx.settings.get('purge_enabled', 'false') === 'true';
  let days;
  try {
    days = JSON.parse(_ctx.settings.get('purge_days', '["fri","sat","sun"]'));
    if (!Array.isArray(days)) days = ['fri', 'sat', 'sun'];
  } catch {
    days = ['fri', 'sat', 'sun'];
  }
  return { enabled, days };
}

function isPurgeActiveNow() {
  const cfg = getConfig();
  if (!cfg.enabled) return false;
  return cfg.days.includes(getCurrentDay());
}

/**
 * Apply ORP change to a server's GameUserSettings.ini
 */
function applyOrpToIni(server, disableOrp) {
  const installDir = server.install_dir;
  if (!installDir) return false;

  const iniPath = path.join(installDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer', 'GameUserSettings.ini');
  if (!fs.existsSync(iniPath)) {
    _ctx.log(`[PurgeWeekend] INI not found for "${server.name}": ${iniPath}`, 'warn');
    return false;
  }

  try {
    let content = fs.readFileSync(iniPath, 'utf8');
    const orpValue = disableOrp ? '0' : '1';
    const regex = /^PreventOfflineRaiding\s*=\s*\d+/m;

    if (regex.test(content)) {
      content = content.replace(regex, `PreventOfflineRaiding=${orpValue}`);
    } else {
      const ssMatch = content.match(/^\[ServerSettings\]/m);
      if (ssMatch) {
        content = content.replace(/^\[ServerSettings\]/m, `[ServerSettings]\nPreventOfflineRaiding=${orpValue}`);
      } else {
        content += `\n[ServerSettings]\nPreventOfflineRaiding=${orpValue}\n`;
      }
    }

    fs.writeFileSync(iniPath, content, 'utf8');
    _ctx.log(`[PurgeWeekend] Set PreventOfflineRaiding=${orpValue} for "${server.name}"`, 'info');
    return true;
  } catch (e) {
    _ctx.log(`[PurgeWeekend] Failed to modify INI for "${server.name}": ${e.message}`, 'error');
    return false;
  }
}

/**
 * Main logic — called by the Schedule Engine on day transitions.
 * Determines if purge should be active, modifies INI, and queues restarts.
 */
function executePurgeCheck() {
  const cfg = getConfig();
  if (!cfg.enabled) return;

  const today = getCurrentDay();

  // Only run once per day change
  if (_lastAppliedDay === today) return;
  _lastAppliedDay = today;

  const purgeActive = cfg.days.includes(today);
  const servers = _ctx.servers.list();

  if (!servers || servers.length === 0) return;

  let modified = 0;
  for (const srv of servers) {
    if (applyOrpToIni(srv, purgeActive)) {
      modified++;
    }
  }

  if (modified === 0) return;

  // Emit event
  if (purgeActive) {
    _ctx.events.emit('purge:activated', 'Purge Activated (ORP disabled)', { level: 'warning' });
    _ctx.log(`[PurgeWeekend] Purge ACTIVATED — ORP disabled on ${modified} server(s)`, 'warn');
  } else {
    _ctx.events.emit('purge:deactivated', 'Purge Ended (ORP enabled)', { level: 'success' });
    _ctx.log(`[PurgeWeekend] Purge ENDED — ORP enabled on ${modified} server(s)`, 'success');
  }

  // Queue restarts for running servers so INI changes take effect
  for (const srv of servers) {
    const sid = srv.server_id || srv.id;
    if (srv.status === 'running' && !_ctx.system.isServerLocked(sid)) {
      try {
        _ctx.commands.enqueue(
          async () => {
            return `Purge Weekend: ORP ${purgeActive ? 'disabled' : 'enabled'}`;
          },
          `Purge Weekend restart: ${srv.name}`,
          { serverId: sid, priority: 1 }
        );
      } catch (e) {
        _ctx.log(`[PurgeWeekend] Failed to queue restart for "${srv.name}": ${e.message}`, 'warn');
      }
    }
  }
}

// ─── Schedule Engine handler ───

function handlePurgeSchedule(_schedule, _handlerCtx) {
  executePurgeCheck();
}

// ─── Feature API ───

function init(ctx) {
  _ctx = ctx;
  _lastAppliedDay = null;

  // Ensure settings exist with defaults
  if (!_ctx.settings.get('purge_enabled')) {
    _ctx.settings.set('purge_enabled', 'false');
  }
  if (!_ctx.settings.get('purge_days')) {
    _ctx.settings.set('purge_days', JSON.stringify(['fri', 'sat', 'sun']));
  }

  // Register with Schedule Engine (if available)
  try {
    const scheduler = require('../scheduler');
    const cfg = getConfig();

    // Register handler
    scheduler.registerHandler('purge_toggle', handlePurgeSchedule);

    // Register schedule — runs every cycle (no specific time), checks internally for day change
    scheduler.register({
      id: 'purge_weekend',
      type: 'purge_toggle',
      enabled: cfg.enabled,
      days: [], // Empty = every cycle; feature handles day logic internally
      time: null, // Every cycle
      meta: { description: 'Purge Weekend ORP toggle' },
    });

    _ctx.log('[PurgeWeekend] Registered with Schedule Engine', 'info');
  } catch (e) {
    _ctx.log(`[PurgeWeekend] Schedule Engine not available, using fallback interval: ${e.message}`, 'warn');
    // Fallback: use own interval if scheduler not present
    _fallbackInterval = setInterval(() => {
      try { executePurgeCheck(); } catch (err) {
        _ctx.log(`[PurgeWeekend] Check error: ${err.message}`, 'error');
      }
    }, 60000);
    setTimeout(() => {
      try { executePurgeCheck(); } catch (err) {
        _ctx.log(`[PurgeWeekend] Initial check error: ${err.message}`, 'error');
      }
    }, 5000);
  }

  _ctx.log('[PurgeWeekend] Feature initialized', 'info');
}

let _fallbackInterval = null;

function shutdown() {
  if (_fallbackInterval) {
    clearInterval(_fallbackInterval);
    _fallbackInterval = null;
  }
  // Unregister from scheduler
  try {
    const scheduler = require('../scheduler');
    scheduler.unregister('purge_weekend');
  } catch {}
}

/** Public API — used by dashboard-state and execute-command */
function getPurgeStatus() {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    days: cfg.days,
    active_now: isPurgeActiveNow(),
    current_day: getCurrentDay(),
  };
}

function updateConfig(newEnabled, newDays) {
  if (typeof newEnabled === 'boolean') {
    _ctx.settings.set('purge_enabled', newEnabled ? 'true' : 'false');
  }
  if (Array.isArray(newDays)) {
    const valid = newDays.filter(d => DAY_NAMES.includes(d));
    _ctx.settings.set('purge_days', JSON.stringify(valid));
  }
  // Reset last applied day to force re-evaluation
  _lastAppliedDay = null;

  // Update scheduler entry
  try {
    const scheduler = require('../scheduler');
    scheduler.update('purge_weekend', {
      enabled: typeof newEnabled === 'boolean' ? newEnabled : undefined,
    });
  } catch {}

  _ctx.log(`[PurgeWeekend] Config updated: enabled=${newEnabled}, days=${JSON.stringify(newDays)}`, 'info');
}

module.exports = { name, core, init, shutdown, getPurgeStatus, updateConfig };
