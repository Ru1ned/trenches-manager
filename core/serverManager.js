/**
 * Server Manager Module — extracted from trenches-agent.js
 * 
 * Contains server state management helpers:
 *   - Ghost server cleanup (purgeServerState)
 *   - Server array management (removeServerFromArray)
 *   - Server validation
 *   - Startup immunity tracking
 * 
 * ZERO new logic — this is a direct extraction.
 */
'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Purges ALL in-memory state for a removed/deleted server.
 * @param {string} name - server name
 * @param {string} serverId - server UUID
 * @param {object} maps - Map references to clear from
 * @param {Function} log
 */
function purgeServerState(name, serverId, maps, log) {
  log(`[CLEANUP] Purging all state for ghost server: "${name}" (${serverId || 'no-id'})`, 'warn');

  const {
    spawnedPids, serverReadyState, serverBootStarted,
    serverOnlineSince, serverConfirmedRunning, serverBootReason,
    a2sQueryCache, configSyncedOnRunning, modScanTriggered,
    serverStopRequested, serverStartLock, serverRconVerified,
    serverRconProbing, busyServers, isPidAlive, safeKillPid,
    stopLogWatcher, stopA2SBootPoller, pendingInjectionChecks,
  } = maps;

  // Kill orphan process
  const pid = spawnedPids.get(serverId) || spawnedPids.get(name);
  if (pid && isPidAlive && isPidAlive(pid)) {
    log(`[CLEANUP] Killing orphan PID ${pid} for "${name}"`, 'warn');
    try { if (safeKillPid) safeKillPid(pid); } catch (e) { log(`[CLEANUP] Kill failed: ${e.message}`, 'warn'); }
  }

  // Clear all state maps
  const deleteFromMap = (map, ...keys) => {
    if (!map) return;
    for (const k of keys) { if (k) map.delete(k); }
  };

  deleteFromMap(spawnedPids, name, serverId);
  deleteFromMap(serverReadyState, name);
  deleteFromMap(serverBootStarted, name);
  deleteFromMap(serverOnlineSince, name);
  deleteFromMap(serverConfirmedRunning, name);
  deleteFromMap(serverBootReason, name);
  deleteFromMap(a2sQueryCache, name);
  deleteFromMap(configSyncedOnRunning, name);
  deleteFromMap(modScanTriggered, name);
  deleteFromMap(serverStopRequested, name, serverId);
  deleteFromMap(serverStartLock, name);
  deleteFromMap(serverRconVerified, name);
  deleteFromMap(serverRconProbing, name);
  if (busyServers) busyServers.delete(name);

  // Stop watchers
  if (stopLogWatcher) try { stopLogWatcher(name); } catch {}
  if (stopA2SBootPoller) try { stopA2SBootPoller(name); } catch {}

  // Clean up pending injection checks
  if (pendingInjectionChecks && pendingInjectionChecks.has(name)) {
    clearTimeout(pendingInjectionChecks.get(name));
    pendingInjectionChecks.delete(name);
  }

  log(`[CLEANUP] Removed stale server: "${name}"`, 'warn');
}

/**
 * Safe array removal.
 */
function removeServerFromArray(servers, serverId) {
  const idx = servers.findIndex(s => s.server_id === serverId);
  if (idx >= 0) {
    servers.splice(idx, 1);
    return true;
  }
  return false;
}

/**
 * Startup immunity — 60s window after startup complete.
 */
function createStartupImmunityTracker(immunityMs = 60000) {
  const startupCompleteAt = new Map();

  function markComplete(serverName) {
    startupCompleteAt.set(serverName, Date.now());
  }

  function isImmune(serverName) {
    const completeTime = startupCompleteAt.get(serverName);
    if (!completeTime) return false;
    return (Date.now() - completeTime) < immunityMs;
  }

  function clear(serverName) {
    startupCompleteAt.delete(serverName);
  }

  return { markComplete, isImmune, clear, _map: startupCompleteAt };
}

module.exports = {
  UUID_RE,
  purgeServerState,
  removeServerFromArray,
  createStartupImmunityTracker,
};
