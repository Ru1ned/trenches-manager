/**
 * Feature: Auto-Restart
 * Monitors server processes and restarts them if they crash unexpectedly.
 * Only acts on servers with auto_restart enabled.
 * v60.5: Uses Schedule Engine instead of internal interval loop.
 */
'use strict';

const name = 'autoRestart';
let _ctx = null;
let _fallbackInterval = null;

function checkAndRestart() {
  if (!_ctx || !_ctx.servers) return;

  const servers = _ctx.servers.list();

  for (const srv of servers) {
    if (!srv.auto_restart) continue;

    const sid = srv.server_id || srv.id;

    // Only restart servers that have crashed or stopped unexpectedly
    if (srv.status !== 'crashed' && srv.status !== 'stopped') continue;

    // Skip if a command is already in progress for this server
    if (_ctx.system.isServerLocked(sid)) continue;

    // Skip if circuit breaker is open
    if (_ctx.system.isCircuitBreakerOpen()) continue;

    _ctx.log(`[autoRestart] Server "${srv.name}" (${sid}) is ${srv.status} with auto_restart enabled — restarting`, 'info');

    _ctx.commands.enqueue(
      async () => {
        return { action: 'auto_restart', server_id: sid, reason: `auto-restart: server was ${srv.status}` };
      },
      `Auto-restart: ${srv.name} (was ${srv.status})`,
      { commandType: 'start', priority: 60, serverId: sid, serverName: srv.name }
    );
  }
}

// Schedule Engine handler
function handleAutoRestartSchedule(_schedule, _handlerCtx) {
  checkAndRestart();
}

async function init(ctx) {
  _ctx = ctx;

  // Register with Schedule Engine (if available)
  try {
    const scheduler = require('../scheduler');

    // Register handler
    scheduler.registerHandler('auto_restart_check', handleAutoRestartSchedule);

    // Register schedule — runs every cycle (no time/day filter)
    scheduler.register({
      id: 'auto_restart',
      type: 'auto_restart_check',
      enabled: true,
      days: [],   // Every day
      time: null,  // Every cycle (30s via scheduler)
      meta: { description: 'Monitor and restart crashed servers' },
    });

    _ctx.log('[autoRestart] Registered with Schedule Engine', 'info');
  } catch (e) {
    _ctx.log(`[autoRestart] Schedule Engine not available, using fallback interval: ${e.message}`, 'warn');
    // Fallback: own interval if scheduler not present
    _fallbackInterval = setInterval(() => {
      try { checkAndRestart(); } catch (err) {
        _ctx.log(`[autoRestart] Check error: ${err.message}`, 'warn');
      }
    }, 30000);
  }

  _ctx.log('[autoRestart] Monitoring started', 'info');
}

function shutdown() {
  if (_fallbackInterval) {
    clearInterval(_fallbackInterval);
    _fallbackInterval = null;
  }
  try {
    const scheduler = require('../scheduler');
    scheduler.unregister('auto_restart');
  } catch {}
}

module.exports = { name, init, shutdown };
