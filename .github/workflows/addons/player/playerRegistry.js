/**
 * Feature: Player Registry & Resolver
 * Maintains a live cache of connected players across all servers.
 * Provides resolution by EOS ID and player name.
 *
 * v61.0: Unified feature system — uses structured ctx namespaces.
 */
'use strict';

const name = 'playerRegistry';
const core = false;
const requires = [];

// ─── State ───
let _ctx = null;
let _pollInterval = null;
const POLL_INTERVAL_MS = 8000; // 8 seconds
const STALE_THRESHOLD_MS = 60000; // 60 seconds — remove players not seen for 1 min

// Live player registry: Map<eosId, PlayerEntry>
const _registry = new Map();

/**
 * @typedef {Object} PlayerEntry
 * @property {string} playerName
 * @property {string} eosId
 * @property {string} playerId - session-based ID (may change per login)
 * @property {string} serverName
 * @property {number} lastSeen - Date.now() timestamp
 */

// ─── Core Functions ───

function refreshPlayerRegistry() {
  if (!_ctx) return;

  try {
    const chatMonitor = _ctx.runtime.chatMonitor;
    if (!chatMonitor || !chatMonitor.clients) return;

    const now = Date.now();
    const seenEosIds = new Set();

    for (const [serverName, client] of chatMonitor.clients) {
      if (!client || !client.connected) continue;

      // Use synchronous execute to get player list
      client.execute('ListPlayers').then(response => {
        if (!response || response.includes('No Players Connected')) return;

        const lines = response.split('\n');
        for (const line of lines) {
          // Format: 0. PlayerName, EOSID_or_PlayerID
          const match = line.match(/^(\d+)\.\s*(.+?),\s*([0-9a-f]{32}|\d{10,20})/i);
          if (!match) continue;

          const playerId = match[1].trim();
          const playerName = match[2].trim();
          const rawId = match[3].trim();

          // Only track 32-char hex EOS IDs (persistent)
          if (!/^[0-9a-f]{32}$/i.test(rawId)) continue;

          const eosId = rawId.toLowerCase();
          seenEosIds.add(eosId);

          _registry.set(eosId, {
            playerName,
            eosId,
            playerId,
            serverName,
            lastSeen: now,
          });
        }
      }).catch(err => {
        // Non-critical — will retry next poll
      });
    }

    // Prune stale entries
    for (const [eosId, entry] of _registry) {
      if (now - entry.lastSeen > STALE_THRESHOLD_MS) {
        _registry.delete(eosId);
      }
    }
  } catch (err) {
    if (_ctx) _ctx.log(`[PlayerRegistry] Refresh error: ${err.message}`, 'warn');
  }
}

function resolvePlayerByEOSID(eosId) {
  if (!eosId) return null;
  const entry = _registry.get(eosId.toLowerCase());
  if (!entry) return null;
  if (Date.now() - entry.lastSeen > STALE_THRESHOLD_MS) {
    _registry.delete(eosId.toLowerCase());
    return null;
  }
  return { ...entry };
}

function resolvePlayerByName(playerName) {
  if (!playerName) return null;
  const target = playerName.toLowerCase().trim();
  for (const entry of _registry.values()) {
    if (entry.playerName.toLowerCase().trim() === target) {
      if (Date.now() - entry.lastSeen > STALE_THRESHOLD_MS) continue;
      return { ...entry };
    }
  }
  return null;
}

function getOnlinePlayers() {
  const now = Date.now();
  const result = [];
  for (const entry of _registry.values()) {
    if (now - entry.lastSeen <= STALE_THRESHOLD_MS) {
      result.push({ ...entry });
    }
  }
  return result;
}

function getPlayerCount() {
  return getOnlinePlayers().length;
}

function isPlayerOnline(eosId) {
  return resolvePlayerByEOSID(eosId) !== null;
}

// ─── Lifecycle ───

function init(ctx) {
  _ctx = ctx;

  _pollInterval = setInterval(() => {
    try { refreshPlayerRegistry(); } catch (e) {
      _ctx.log(`[PlayerRegistry] Poll error: ${e.message}`, 'warn');
    }
  }, POLL_INTERVAL_MS);

  // Initial poll after 3 seconds (give RCON connections time to establish)
  setTimeout(() => {
    try { refreshPlayerRegistry(); } catch (e) {}
  }, 3000);

  _ctx.log(`[PlayerRegistry] Initialized (${POLL_INTERVAL_MS}ms poll interval)`, 'info');
}

function shutdown() {
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
  _registry.clear();
}

module.exports = {
  name,
  core,
  requires,
  init,
  shutdown,
  resolvePlayerByEOSID,
  resolvePlayerByName,
  getOnlinePlayers,
  getPlayerCount,
  isPlayerOnline,
  refreshPlayerRegistry,
};
