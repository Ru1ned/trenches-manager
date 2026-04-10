/**
 * Feature: Tribe Enforcement + Cluster Tribe Builder
 * Extracted from agent v50.0
 * v60.0: Unified feature system — uses structured ctx namespaces. — behavior-identical.
 *
 * Intent-aware, log-based tribe management with automatic
 * cluster-wide tribe identity, rename handling, and enforcement.
 */
'use strict';

const crypto = require('crypto');

const name = 'tribeEnforcer';
const core = true;

// ─── State ───
const _recentTribeEvents = new Map(); // playerId -> { action, tribe, tribeId, timestamp, serverName }
const _activeTribeEnforcements = new Set(); // serverId:playerId — prevent duplicates
const _lastTribeRename = new Map(); // oldName -> timestamp (spam protection)
const _tribeEnforcementAttempts = new Map(); // playerId:serverId -> { count, lastAttempt }
const _recentTribeLeavers = new Map(); // clusterTribeId -> [{ playerId, timestamp }]
const _mapTribeCreationLocks = new Map(); // lockKey -> { timestamp, status }
const _recentTribeLogs = new Map(); // playerId -> [{ tribeName, timestamp, action }]

const TRIBE_GRACE_WINDOW_MS = 300000; // 5 min
const TRIBE_RENAME_COOLDOWN_MS = 5000; // 5s spam guard
const TRIBE_ENFORCE_MAX_ATTEMPTS = 3;
const TRIBE_ENFORCE_COOLDOWN_MS = 300000; // 5 min per player
const MAX_TRIBE_SIZE = 100;
const TRIBE_VERIFY_WINDOW_MS = 30000; // 30s
const MEMORY_CAP_LOCKS = 100;
const MEMORY_CAP_ATTEMPTS = 500;
const MEMORY_CAP_LEAVERS = 200;

// ─── Context refs ───
let _ctx = null;

// ─── Memory safety ───
function enforceMemoryCaps() {
  if (_mapTribeCreationLocks.size > MEMORY_CAP_LOCKS) {
    const sorted = [..._mapTribeCreationLocks.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = sorted.slice(0, _mapTribeCreationLocks.size - MEMORY_CAP_LOCKS);
    for (const [key] of toRemove) _mapTribeCreationLocks.delete(key);
    _ctx.log(`[MemorySafety] Trimmed _mapTribeCreationLocks to ${MEMORY_CAP_LOCKS}`, 'warn');
  }
  if (_tribeEnforcementAttempts.size > MEMORY_CAP_ATTEMPTS) {
    const sorted = [..._tribeEnforcementAttempts.entries()].sort((a, b) => a[1].lastAttempt - b[1].lastAttempt);
    const toRemove = sorted.slice(0, _tribeEnforcementAttempts.size - MEMORY_CAP_ATTEMPTS);
    for (const [key] of toRemove) _tribeEnforcementAttempts.delete(key);
    _ctx.log(`[MemorySafety] Trimmed _tribeEnforcementAttempts to ${MEMORY_CAP_ATTEMPTS}`, 'warn');
  }
  if (_recentTribeLeavers.size > MEMORY_CAP_LEAVERS) {
    const sorted = [..._recentTribeLeavers.entries()].sort((a, b) => {
      const aMax = Math.max(...a[1].map(l => l.timestamp));
      const bMax = Math.max(...b[1].map(l => l.timestamp));
      return aMax - bMax;
    });
    const toRemove = sorted.slice(0, _recentTribeLeavers.size - MEMORY_CAP_LEAVERS);
    for (const [key] of toRemove) _recentTribeLeavers.delete(key);
    _ctx.log(`[MemorySafety] Trimmed _recentTribeLeavers to ${MEMORY_CAP_LEAVERS}`, 'warn');
  }
  const now = Date.now();
  for (const [pid, logs] of _recentTribeLogs) {
    const filtered = logs.filter(l => now - l.timestamp < TRIBE_VERIFY_WINDOW_MS);
    if (filtered.length === 0) _recentTribeLogs.delete(pid);
    else _recentTribeLogs.set(pid, filtered);
  }
}

function recordTribeLogForVerification(playerId, tribeName, action) {
  const logs = _recentTribeLogs.get(playerId) || [];
  logs.push({ tribeName, timestamp: Date.now(), action });
  if (logs.length > 10) logs.splice(0, logs.length - 10);
  _recentTribeLogs.set(playerId, logs);
}

// ─── Hybrid tribe identity ───
function buildClusterTribeId(tribeName, founderPlayerId) {
  const normalized = tribeName.toLowerCase().trim();
  return crypto.createHash('sha1').update(`${normalized}|${founderPlayerId}`).digest('hex');
}

// ─── Log parsers ───
function parseTribeLogEvent(logLine) {
  if (!logLine || typeof logLine !== 'string') return null;
  const joinMatch = logLine.match(/^(.+?)\s+joined\s+(?:Tribe\s+)?(.+)/i);
  if (joinMatch) return { action: 'joined', playerName: joinMatch[1].trim(), tribeName: joinMatch[2].trim() };
  const leftMatch = logLine.match(/^(.+?)\s+left\s+(?:Tribe\s+)?(.+)/i);
  if (leftMatch) return { action: 'left', playerName: leftMatch[1].trim(), tribeName: leftMatch[2].trim() };
  const kickMatch = logLine.match(/^(.+?)\s+was\s+kicked\s+from\s+(?:Tribe\s+)?(.+)/i);
  if (kickMatch) return { action: 'kicked', playerName: kickMatch[1].trim(), tribeName: kickMatch[2].trim() };
  return null;
}

function parseTribeRename(logLine) {
  if (!logLine || typeof logLine !== 'string') return null;
  const match = logLine.match(/Tribe\s+['"]?(.+?)['"]?\s+(?:renamed to|is now)\s+['"]?(.+?)['"]?\s*$/i);
  if (!match) return null;
  return { oldName: match[1].trim(), newName: match[2].trim() };
}

// ─── Intent tracking ───
function trackTribeEvent(playerId, playerName, action, tribeName, serverId, serverName) {
  if (!_ctx.settings.isEnabled('tribe_enforcement')) return;
  _recentTribeEvents.set(playerId, { action, tribe: tribeName, timestamp: Date.now(), serverName });
  try {
    _ctx.db.instance().prepare(
      `INSERT INTO tribe_events (player_id, player_name, action, tribe_name, server_id, server_name)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(playerId, playerName, action, tribeName, serverId, serverName);
  } catch {}

  _ctx.events.emit('system:decision', `Tribe event: ${playerName} ${action} tribe "${tribeName}" on ${serverName}`, {
    level: 'info', serverName, serverId,
  });

  updateClusterTribeFromEvent(playerId, playerName, action, tribeName, serverId, serverName);
}

function shouldEnforceTribe(playerId) {
  if (!_ctx.settings.isEnabled('tribe_enforcement')) return false;
  const recent = _recentTribeEvents.get(playerId);
  if (!recent) return true;
  const age = Date.now() - recent.timestamp;
  if (age > TRIBE_GRACE_WINDOW_MS) return true;
  if (recent.action === 'left' || recent.action === 'kicked') return false;
  return true;
}

function cleanTribeEvents() {
  const now = Date.now();
  for (const [pid, evt] of _recentTribeEvents) {
    if (now - evt.timestamp > TRIBE_GRACE_WINDOW_MS * 2) _recentTribeEvents.delete(pid);
  }
  for (const [name, ts] of _lastTribeRename) {
    if (now - ts > 60000) _lastTribeRename.delete(name);
  }
  for (const [key, info] of _tribeEnforcementAttempts) {
    if (now - info.lastAttempt > TRIBE_ENFORCE_COOLDOWN_MS * 2) _tribeEnforcementAttempts.delete(key);
  }
  for (const [tid, leavers] of _recentTribeLeavers) {
    const filtered = leavers.filter(l => now - l.timestamp < 60000);
    if (filtered.length === 0) _recentTribeLeavers.delete(tid);
    else _recentTribeLeavers.set(tid, filtered);
  }
  try {
    _ctx.db.instance().prepare(`DELETE FROM cluster_tribes WHERE last_seen < datetime('now', '-7 days')`).run();
    _ctx.db.instance().prepare(`DELETE FROM cluster_tribe_members WHERE cluster_tribe_id NOT IN (SELECT cluster_tribe_id FROM cluster_tribes)`).run();
    _ctx.db.instance().prepare(`DELETE FROM tribe_permissions WHERE cluster_tribe_id NOT IN (SELECT cluster_tribe_id FROM cluster_tribes)`).run();
    const logCnt = _ctx.db.instance().prepare('SELECT COUNT(*) as c FROM tribe_enforcement_log').get();
    if (logCnt && logCnt.c > 500) _ctx.db.instance().prepare('DELETE FROM tribe_enforcement_log WHERE id IN (SELECT id FROM tribe_enforcement_log ORDER BY id ASC LIMIT ?)').run(logCnt.c - 500);
  } catch {}
  enforceMemoryCaps();
  const lockTimeout = 10000;
  for (const [key, lock] of _mapTribeCreationLocks) {
    if (now - lock.timestamp > lockTimeout) {
      _mapTribeCreationLocks.delete(key);
      _ctx.log(`[TribeEnforce] lock_timeout_release: ${key}`, 'warn');
    }
  }
}

// ─── Cluster Tribe Builder ───
function updateClusterTribeFromEvent(playerId, playerName, action, tribeName, serverId, serverName) {
  if (!tribeName || !playerId) return;
  recordTribeLogForVerification(playerId, tribeName, action);

  try {
    const db = _ctx.db.instance();
    const existingMembership = db.prepare('SELECT cluster_tribe_id FROM cluster_tribe_members WHERE player_id = ?').get(playerId);

    if (action === 'joined') {
      let row = db.prepare('SELECT * FROM cluster_tribes WHERE tribe_name = ? COLLATE NOCASE LIMIT 1').get(tribeName);

      if (!row) {
        const clusterId = buildClusterTribeId(tribeName, playerId);
        db.prepare(
          `INSERT OR IGNORE INTO cluster_tribes (cluster_tribe_id, tribe_name, canonical_server_id, founder_player_id, last_seen)
           VALUES (?, ?, ?, ?, datetime('now'))`
        ).run(clusterId, tribeName, serverId, playerId);
        db.prepare(
          `INSERT OR IGNORE INTO cluster_tribe_members (cluster_tribe_id, player_id, player_name) VALUES (?, ?, ?)`
        ).run(clusterId, playerId, playerName);
        _ctx.events.emit('tribe:auto_registered', `Cluster tribe "${tribeName}" auto-created (founder: ${playerName}) on ${serverName}`, { level: 'info', serverName });
        _ctx.log(`[TribeBuilder] Created cluster tribe "${tribeName}" (${clusterId}) founder=${playerName}`, 'info');
        return;
      }

      db.prepare(
        `INSERT OR IGNORE INTO cluster_tribe_members (cluster_tribe_id, player_id, player_name) VALUES (?, ?, ?)`
      ).run(row.cluster_tribe_id, playerId, playerName);
      db.prepare(
        `UPDATE cluster_tribe_members SET player_name = ? WHERE cluster_tribe_id = ? AND player_id = ?`
      ).run(playerName, row.cluster_tribe_id, playerId);
      db.prepare(`UPDATE cluster_tribes SET last_seen = datetime('now') WHERE cluster_tribe_id = ?`).run(row.cluster_tribe_id);
    }

    if (action === 'left' || action === 'kicked') {
      if (existingMembership) {
        db.prepare('DELETE FROM cluster_tribe_members WHERE cluster_tribe_id = ? AND player_id = ?')
          .run(existingMembership.cluster_tribe_id, playerId);
        db.prepare(`UPDATE cluster_tribes SET last_seen = datetime('now') WHERE cluster_tribe_id = ?`)
          .run(existingMembership.cluster_tribe_id);

        const leavers = _recentTribeLeavers.get(existingMembership.cluster_tribe_id) || [];
        leavers.push({ playerId, timestamp: Date.now() });
        _recentTribeLeavers.set(existingMembership.cluster_tribe_id, leavers);

        detectTribeSplit(existingMembership.cluster_tribe_id, serverId, serverName);
      }
    }
  } catch (e) {
    _ctx.log('[TribeBuilder] Error updating cluster tribe: ' + e.message, 'warn');
  }
}

// ─── Tribe Split Detection ───
function detectTribeSplit(clusterTribeId, serverId, serverName) {
  try {
    const leavers = _recentTribeLeavers.get(clusterTribeId) || [];
    const recentLeavers = leavers.filter(l => Date.now() - l.timestamp < 60000);
    if (recentLeavers.length < 2) return;

    const db = _ctx.db.instance();
    const remainingCount = db.prepare('SELECT COUNT(*) as c FROM cluster_tribe_members WHERE cluster_tribe_id = ?').get(clusterTribeId);
    const remaining = remainingCount ? remainingCount.c : 0;
    const originalSize = remaining + recentLeavers.length;

    if (originalSize < 4 || recentLeavers.length < Math.floor(originalSize * 0.5)) return;

    const tribe = db.prepare('SELECT * FROM cluster_tribes WHERE cluster_tribe_id = ?').get(clusterTribeId);
    if (!tribe) return;

    _ctx.events.emit('system:decision', `Tribe split detected: ${recentLeavers.length} of ${originalSize} members left "${tribe.tribe_name}" within 60s`, {
      level: 'warning', serverName, serverId,
    });
    _ctx.log(`[TribeBuilder] Split detected for "${tribe.tribe_name}": ${recentLeavers.length}/${originalSize} left`, 'warn');

    _recentTribeLeavers.delete(clusterTribeId);
  } catch (e) {
    _ctx.log('[TribeBuilder] Split detection error: ' + e.message, 'warn');
  }
}

// ─── Tribe Rename Handler ───
function handleTribeRename(oldName, newName, serverId, serverName) {
  if (!_ctx.settings.isEnabled('tribe_enforcement')) return;
  if (!oldName || !newName || oldName === newName) return;

  const lastRename = _lastTribeRename.get(oldName);
  if (lastRename && Date.now() - lastRename < TRIBE_RENAME_COOLDOWN_MS) return;
  _lastTribeRename.set(oldName, Date.now());

  try {
    const db = _ctx.db.instance();
    const oldTribe = db.prepare('SELECT * FROM cluster_tribes WHERE tribe_name = ? COLLATE NOCASE LIMIT 1').get(oldName);
    if (!oldTribe) return;

    const newTribe = db.prepare('SELECT * FROM cluster_tribes WHERE tribe_name = ? COLLATE NOCASE LIMIT 1').get(newName);

    if (!newTribe) {
      db.prepare(
        `UPDATE cluster_tribes SET tribe_name = ?, last_seen = datetime('now') WHERE cluster_tribe_id = ?`
      ).run(newName, oldTribe.cluster_tribe_id);
      db.prepare(
        `UPDATE tribe_map_links SET tribe_name = ? WHERE cluster_tribe_id = ?`
      ).run(newName, oldTribe.cluster_tribe_id);

      _ctx.events.emit('system:decision', `Tribe renamed: "${oldName}" → "${newName}" (cluster identity preserved)`, {
        level: 'info', serverName, serverId,
      });
      _ctx.log(`[TribeBuilder] Rename: "${oldName}" → "${newName}" (id=${oldTribe.cluster_tribe_id})`, 'info');
      return;
    }

    // Check for safe merge (≥70% member overlap)
    const oldMembers = db.prepare('SELECT player_id FROM cluster_tribe_members WHERE cluster_tribe_id = ?').all(oldTribe.cluster_tribe_id).map(r => r.player_id);
    const newMembers = db.prepare('SELECT player_id FROM cluster_tribe_members WHERE cluster_tribe_id = ?').all(newTribe.cluster_tribe_id).map(r => r.player_id);
    const overlap = oldMembers.filter(id => newMembers.includes(id)).length;
    const overlapPct = Math.max(oldMembers.length, newMembers.length) > 0
      ? overlap / Math.max(oldMembers.length, newMembers.length) : 0;

    if (overlapPct >= 0.7) {
      for (const pid of oldMembers) {
        db.prepare('INSERT OR IGNORE INTO cluster_tribe_members (cluster_tribe_id, player_id, player_name) VALUES (?, ?, (SELECT player_name FROM cluster_tribe_members WHERE player_id = ? LIMIT 1))')
          .run(newTribe.cluster_tribe_id, pid, pid);
      }
      db.prepare('DELETE FROM cluster_tribe_members WHERE cluster_tribe_id = ?').run(oldTribe.cluster_tribe_id);
      db.prepare('DELETE FROM cluster_tribes WHERE cluster_tribe_id = ?').run(oldTribe.cluster_tribe_id);
      db.prepare('UPDATE tribe_map_links SET cluster_tribe_id = ? WHERE cluster_tribe_id = ?').run(newTribe.cluster_tribe_id, oldTribe.cluster_tribe_id);
      _ctx.events.emit('system:decision', `Tribe merge: "${oldName}" → "${newName}" (${Math.round(overlapPct * 100)}% overlap, safe merge)`, {
        level: 'info', serverName, serverId,
      });
      return;
    }

    _ctx.events.emit('system:decision', `Rename conflict: "${oldName}" → "${newName}" but target tribe already exists (${Math.round(overlapPct * 100)}% overlap). No merge performed.`, {
      level: 'warning', serverName, serverId,
    });
    _ctx.log(`[TribeBuilder] Rename conflict: "${oldName}" → "${newName}" (overlap ${Math.round(overlapPct * 100)}%)`, 'warn');

  } catch (e) {
    _ctx.log('[TribeBuilder] Rename error: ' + e.message, 'warn');
  }
}

// ─── DB helpers ───
function getClusterTribeForPlayer(playerId) {
  try {
    const membership = _ctx.db.instance().prepare(
      `SELECT ct.* FROM cluster_tribes ct
       JOIN cluster_tribe_members ctm ON ct.cluster_tribe_id = ctm.cluster_tribe_id
       WHERE ctm.player_id = ? LIMIT 1`
    ).get(playerId);
    return membership || null;
  } catch { return null; }
}

function getMapTribe(serverId, clusterTribeId) {
  try {
    return _ctx.db.instance().prepare(
      `SELECT * FROM tribe_map_links WHERE server_id = ? AND cluster_tribe_id = ? LIMIT 1`
    ).get(serverId, clusterTribeId) || null;
  } catch { return null; }
}

function dbGetClusterTribes() {
  try {
    return _ctx.db.instance().prepare('SELECT * FROM cluster_tribes ORDER BY last_seen DESC').all();
  } catch { return []; }
}

function dbGetTribeMemberCount(clusterTribeId) {
  try {
    const row = _ctx.db.instance().prepare('SELECT COUNT(*) as c FROM cluster_tribe_members WHERE cluster_tribe_id = ?').get(clusterTribeId);
    return row ? row.c : 0;
  } catch { return 0; }
}

function dbGetTribeMembers(clusterTribeId) {
  try {
    return _ctx.db.instance().prepare('SELECT * FROM cluster_tribe_members WHERE cluster_tribe_id = ?').all(clusterTribeId);
  } catch { return []; }
}

function dbGetTribeMapLinks(serverId) {
  try {
    if (serverId) return _ctx.db.instance().prepare('SELECT * FROM tribe_map_links WHERE server_id = ? ORDER BY id DESC').all(serverId);
    return _ctx.db.instance().prepare('SELECT * FROM tribe_map_links ORDER BY id DESC').all();
  } catch { return []; }
}

function dbGetTribeEnforcementLog(limit = 30) {
  try {
    return _ctx.db.instance().prepare('SELECT * FROM tribe_enforcement_log ORDER BY id DESC LIMIT ?').all(limit);
  } catch { return []; }
}

function dbRecordTribeEnforcement(playerId, playerName, serverId, serverName, clusterTribeId, tribeName, action, result) {
  try {
    _ctx.db.instance().prepare(
      `INSERT INTO tribe_enforcement_log (player_id, player_name, server_id, server_name, cluster_tribe_id, tribe_name, action, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(playerId, playerName, serverId, serverName, clusterTribeId, tribeName, action, result);
    const cnt = _ctx.db.instance().prepare('SELECT COUNT(*) as c FROM tribe_enforcement_log').get();
    if (cnt && cnt.c > 200) {
      _ctx.db.instance().prepare('DELETE FROM tribe_enforcement_log WHERE id IN (SELECT id FROM tribe_enforcement_log ORDER BY id ASC LIMIT ?)').run(cnt.c - 200);
    }
  } catch {}
}

function registerClusterTribe(tribeName, ownerPlayerId, memberIds) {
  const clusterTribeId = buildClusterTribeId(tribeName, ownerPlayerId || 'system');
  try {
    const db = _ctx.db.instance();
    const existing = db.prepare('SELECT * FROM cluster_tribes WHERE cluster_tribe_id = ?').get(clusterTribeId);
    if (existing) return { cluster_tribe_id: clusterTribeId, tribe_name: existing.tribe_name, existing: true };
    db.prepare(
      `INSERT INTO cluster_tribes (cluster_tribe_id, tribe_name, founder_player_id, canonical_server_id)
       VALUES (?, ?, ?, NULL)`
    ).run(clusterTribeId, tribeName, ownerPlayerId || null);
    if (Array.isArray(memberIds)) {
      for (const mid of memberIds) {
        const pid = typeof mid === 'object' ? mid.id : mid;
        const pname = typeof mid === 'object' ? mid.name : '';
        db.prepare('INSERT OR IGNORE INTO cluster_tribe_members (cluster_tribe_id, player_id, player_name) VALUES (?, ?, ?)').run(clusterTribeId, pid, pname);
      }
    }
    _ctx.events.emit('tribe:registered', `Cluster tribe "${tribeName}" registered (${clusterTribeId})`, { level: 'info' });
    return { cluster_tribe_id: clusterTribeId, tribe_name: tribeName };
  } catch (e) {
    _ctx.log('[TribeEnforce] Failed to register cluster tribe: ' + e.message, 'warn');
    return null;
  }
}

function updateClusterTribeMembers(clusterTribeId, memberIds) {
  try {
    const db = _ctx.db.instance();
    db.prepare('DELETE FROM cluster_tribe_members WHERE cluster_tribe_id = ?').run(clusterTribeId);
    for (const mid of (memberIds || [])) {
      const pid = typeof mid === 'object' ? mid.id : mid;
      const pname = typeof mid === 'object' ? mid.name : '';
      db.prepare('INSERT OR IGNORE INTO cluster_tribe_members (cluster_tribe_id, player_id, player_name) VALUES (?, ?, ?)').run(clusterTribeId, pid, pname);
    }
    db.prepare(`UPDATE cluster_tribes SET last_seen = datetime('now') WHERE cluster_tribe_id = ?`).run(clusterTribeId);
    return true;
  } catch { return false; }
}

function linkMapTribe(serverId, arkTribeId, clusterTribeId, tribeName) {
  try {
    _ctx.db.instance().prepare(
      `INSERT OR REPLACE INTO tribe_map_links (server_id, ark_tribe_id, cluster_tribe_id, tribe_name)
       VALUES (?, ?, ?, ?)`
    ).run(serverId, arkTribeId, clusterTribeId, tribeName);
    return true;
  } catch { return false; }
}

async function createMapTribe(serverId, serverName, clusterTribe) {
  const lockKey = `${serverId}:${clusterTribe.cluster_tribe_id}`;
  const existingLock = _mapTribeCreationLocks.get(lockKey);
  if (existingLock && existingLock.status === 'active') {
    _ctx.log(`[TribeEnforce] Map tribe creation already locked for ${lockKey}`, 'info');
    return null;
  }
  _mapTribeCreationLocks.set(lockKey, { timestamp: Date.now(), status: 'active' });
  _ctx.log(`[TribeEnforce] lock_acquired: ${lockKey}`, 'info');

  try {
    const tribeName = clusterTribe.tribe_name || `ClusterTribe_${clusterTribe.cluster_tribe_id}`;
    _ctx.events.emit('system:decision', `Creating tribe "${tribeName}" on ${serverName} for cluster-wide enforcement`, { level: 'info', serverName, serverId });

    await _ctx.commands.enqueue(
      async () => {
        return { action: 'create_tribe', tribe_name: tribeName, server_id: serverId };
      },
      `Create tribe ${tribeName} on ${serverName}`,
      { commandType: 'tribe_create', priority: 70, serverId, serverName }
    );

    const pendingId = `pending_${Date.now()}`;
    linkMapTribe(serverId, pendingId, clusterTribe.cluster_tribe_id, tribeName);
    dbRecordTribeEnforcement(clusterTribe.founder_player_id || 'system', 'system', serverId, serverName, clusterTribe.cluster_tribe_id, tribeName, 'create_tribe', 'queued');
    _mapTribeCreationLocks.set(lockKey, { timestamp: Date.now(), status: 'completed' });
    _ctx.log(`[TribeEnforce] lock_released_success: ${lockKey}`, 'info');
    return { tribe_name: tribeName, ark_tribe_id: pendingId };
  } catch (e) {
    _mapTribeCreationLocks.set(lockKey, { timestamp: Date.now(), status: 'failed' });
    _ctx.log(`[TribeEnforce] lock_released_failure: ${lockKey} — ${e.message}`, 'warn');
    return null;
  }
}

// ─── Fail-closed verification ───
async function verifyPlayerInTribe(playerId, tribeName) {
  _ctx.log(`[TribeVerify] action_start: verifying ${playerId} in "${tribeName}"`, 'info');

  const recentLogs = _recentTribeLogs.get(playerId) || [];
  const now = Date.now();
  const recentJoin = recentLogs.find(l =>
    l.tribeName.toLowerCase() === tribeName.toLowerCase() &&
    l.action === 'joined' &&
    now - l.timestamp < TRIBE_VERIFY_WINDOW_MS
  );
  if (recentJoin) {
    _ctx.log(`[TribeVerify] action_success: ${playerId} verified via tribe log cache`, 'info');
    return 'verified';
  }

  const recentLeave = recentLogs.find(l =>
    l.tribeName.toLowerCase() === tribeName.toLowerCase() &&
    (l.action === 'left' || l.action === 'kicked') &&
    now - l.timestamp < TRIBE_VERIFY_WINDOW_MS
  );
  if (recentLeave) {
    _ctx.log(`[TribeVerify] action_failure: ${playerId} recently left "${tribeName}"`, 'warn');
    return 'failed_verify';
  }

  try {
    const db = _ctx.db.instance();
    const tribe = db.prepare(
      `SELECT ct.cluster_tribe_id FROM cluster_tribes ct WHERE ct.tribe_name = ? LIMIT 1`
    ).get(tribeName);
    if (tribe) {
      const member = db.prepare(
        'SELECT 1 FROM cluster_tribe_members WHERE cluster_tribe_id = ? AND player_id = ? LIMIT 1'
      ).get(tribe.cluster_tribe_id, playerId);
      if (member) {
        _ctx.log(`[TribeVerify] action_success: ${playerId} found in DB for "${tribeName}"`, 'info');
        return 'verified';
      }
    }
  } catch (e) {
    _ctx.log(`[TribeVerify] DB check error: ${e.message}`, 'warn');
  }

  _ctx.log(`[TribeVerify] verification_result: verification_unavailable for ${playerId} in "${tribeName}"`, 'warn');
  return 'verification_unavailable';
}

async function assignPlayerToTribe(player, tribe, serverId, serverName) {
  const enforceKey = `${serverId}:${player.id}`;
  if (_activeTribeEnforcements.has(enforceKey)) {
    _ctx.log(`[TribeEnforce] Skipped duplicate enforcement for ${player.name} on ${serverName}`, 'info');
    return;
  }

  const attemptKey = `${player.id}:${serverId}`;
  const attempts = _tribeEnforcementAttempts.get(attemptKey) || { count: 0, lastAttempt: 0, blocked: false };
  if (attempts.blocked) {
    if (Date.now() - attempts.lastAttempt < TRIBE_ENFORCE_COOLDOWN_MS) {
      _ctx.log(`[TribeEnforce] Player ${player.name} is blocked_temp on ${serverName}, cooldown active`, 'warn');
      return;
    }
    attempts.blocked = false;
    attempts.count = 0;
  }
  if (attempts.count >= TRIBE_ENFORCE_MAX_ATTEMPTS) {
    attempts.blocked = true;
    attempts.lastAttempt = Date.now();
    _tribeEnforcementAttempts.set(attemptKey, attempts);
    _ctx.log(`[TribeEnforce] HARD STOP: ${player.name} blocked_temp after ${TRIBE_ENFORCE_MAX_ATTEMPTS} attempts on ${serverName}`, 'warn');
    dbRecordTribeEnforcement(player.id, player.name, serverId, serverName, tribe.cluster_tribe_id || '', tribe.tribe_name, 'assign', 'blocked_temp');
    _ctx.events.emit('system:decision', `Player ${player.name} temporarily blocked from tribe enforcement on ${serverName} (max attempts reached)`, {
      level: 'warning', serverName, serverId,
    });
    return;
  }

  const memberCount = dbGetTribeMemberCount(tribe.cluster_tribe_id || '');
  const maxSize = parseInt(_ctx.settings.get('max_tribe_size', String(MAX_TRIBE_SIZE)), 10);
  if (memberCount >= maxSize) {
    _ctx.events.emit('system:decision', `Tribe "${tribe.tribe_name}" at capacity (${memberCount}/${maxSize}). Cannot assign ${player.name}.`, {
      level: 'warning', serverName, serverId,
    });
    dbRecordTribeEnforcement(player.id, player.name, serverId, serverName, tribe.cluster_tribe_id || '', tribe.tribe_name, 'assign', 'tribe_full');
    return;
  }

  _activeTribeEnforcements.add(enforceKey);
  _ctx.log(`[TribeEnforce] action_start: assigning ${player.name} to "${tribe.tribe_name}" on ${serverName}`, 'info');

  const backoffDelays = [0, 2000, 5000];
  let finalResult = 'failed_verify';

  for (let i = 0; i < TRIBE_ENFORCE_MAX_ATTEMPTS; i++) {
    if (backoffDelays[i] > 0) {
      await new Promise(resolve => setTimeout(resolve, backoffDelays[i]));
    }

    _tribeEnforcementAttempts.set(attemptKey, { count: i + 1, lastAttempt: Date.now(), blocked: false });

    _ctx.events.emit('system:decision', `Auto-assigning ${player.name} to tribe "${tribe.tribe_name}" on ${serverName} (attempt ${i + 1}/${TRIBE_ENFORCE_MAX_ATTEMPTS})`, {
      level: 'info', serverName, serverId,
    });

    try {
      await _ctx.commands.enqueue(
        async () => {
          return { action: 'tribe_assign', player_id: player.id, tribe_name: tribe.tribe_name };
        },
        `Assign ${player.name} to tribe ${tribe.tribe_name} (attempt ${i + 1})`,
        { commandType: 'tribe_assign', priority: 85, serverId, serverName }
      );

      const verifyResult = await verifyPlayerInTribe(player.id, tribe.tribe_name);
      if (verifyResult === 'verified') {
        dbRecordTribeEnforcement(player.id, player.name, serverId, serverName, tribe.cluster_tribe_id || '', tribe.tribe_name, 'assign', 'verified');
        _ctx.log(`[TribeEnforce] action_success: ${player.name} verified in "${tribe.tribe_name}" on ${serverName}`, 'info');
        finalResult = 'verified';
        break;
      } else if (verifyResult === 'failed_verify') {
        _ctx.log(`[TribeEnforce] action_failure: verification explicitly failed for ${player.name} (attempt ${i + 1})`, 'warn');
        finalResult = 'failed_verify';
      } else {
        _ctx.log(`[TribeEnforce] verification_result: unavailable for ${player.name} (attempt ${i + 1}), will retry`, 'warn');
        finalResult = 'verification_unavailable';
      }
    } catch (e) {
      _ctx.log(`[TribeEnforce] action_failure: ${player.name} attempt ${i + 1} error: ${e.message}`, 'warn');
      finalResult = 'failed_verify';
      break;
    }
  }

  if (finalResult !== 'verified') {
    dbRecordTribeEnforcement(player.id, player.name, serverId, serverName, tribe.cluster_tribe_id || '', tribe.tribe_name, 'assign', finalResult);
    _ctx.log(`[TribeEnforce] action_failure: all attempts exhausted for ${player.name} on ${serverName} (result: ${finalResult})`, 'warn');
  }

  _activeTribeEnforcements.delete(enforceKey);
}

async function handlePlayerJoinTribeEnforcement(player, serverId, serverName) {
  if (!_ctx.settings.isEnabled('tribe_enforcement')) return;
  if (!shouldEnforceTribe(player.id)) {
    _ctx.log(`[TribeEnforce] Skipped (intent detected) for ${player.name} on ${serverName}`, 'info');
    return;
  }

  const pressure = _ctx.system.getPressure();
  if (pressure === 'high') { _ctx.log('[TribeEnforce] Blocked — system pressure high', 'warn'); return; }
  if (_ctx.system.isCircuitBreakerOpen()) { _ctx.log('[TribeEnforce] Blocked — circuit breaker open', 'warn'); return; }
  if (_ctx.system.isServerLocked(serverId)) { _ctx.log('[TribeEnforce] Blocked — server locked', 'warn'); return; }

  const clusterTribe = getClusterTribeForPlayer(player.id);
  if (!clusterTribe) return;

  let mapTribe = getMapTribe(serverId, clusterTribe.cluster_tribe_id);
  if (!mapTribe) {
    mapTribe = await createMapTribe(serverId, serverName, clusterTribe);
  }

  const checkAndAssign = async (retries = 0) => {
    if (retries > 2) {
      _ctx.log(`[TribeEnforce] Player ${player.name} state check timed out, proceeding anyway`, 'warn');
    }
    try {
      await assignPlayerToTribe(player, { ...mapTribe, cluster_tribe_id: clusterTribe.cluster_tribe_id }, serverId, serverName);
    } catch (e) {
      _ctx.log(`[TribeEnforce] Failed to assign ${player.name}: ${e.message}`, 'warn');
    }
  };

  setTimeout(() => checkAndAssign(0), 3000);
}

// ─── Audit log ───
function logTribeAdminAction(action, clusterTribeId, playerId, detail) {
  try {
    _ctx.db.instance().prepare(
      'INSERT INTO tribe_admin_actions (action, cluster_tribe_id, player_id, detail) VALUES (?, ?, ?, ?)'
    ).run(action, clusterTribeId, playerId || null, detail || null);
  } catch (e) {
    _ctx.log('[TribeAudit] Failed to log action: ' + e.message, 'warn');
  }
}

// ─── Permissions ───
function grantTribePermission(playerId, permission) {
  const tribe = getClusterTribeForPlayer(playerId);
  if (!tribe) {
    _ctx.log(`[Permissions] No tribe found for player ${playerId}`, 'warn');
    return { granted: false, reason: 'no_tribe' };
  }
  try {
    _ctx.db.instance().prepare(
      `INSERT OR IGNORE INTO tribe_permissions (cluster_tribe_id, permission) VALUES (?, ?)`
    ).run(tribe.cluster_tribe_id, permission);
    _ctx.events.emit('tribe:permission_granted', `Permission "${permission}" granted to tribe "${tribe.tribe_name}"`, {
      level: 'info',
      cluster_tribe_id: tribe.cluster_tribe_id,
      tribe_name: tribe.tribe_name,
      permission,
    });
    _ctx.log(`[Permissions] "${permission}" granted to tribe "${tribe.tribe_name}" (${tribe.cluster_tribe_id})`, 'info');
    return { granted: true, cluster_tribe_id: tribe.cluster_tribe_id, tribe_name: tribe.tribe_name };
  } catch (e) {
    _ctx.log('[Permissions] Failed: ' + e.message, 'warn');
    return { granted: false, reason: e.message };
  }
}

function hasTribePermission(clusterTribeId, permission) {
  try {
    const row = _ctx.db.instance().prepare(
      'SELECT 1 FROM tribe_permissions WHERE cluster_tribe_id = ? AND permission = ? LIMIT 1'
    ).get(clusterTribeId, permission);
    return !!row;
  } catch { return false; }
}

function getTribeEnforcementStatus() {
  const tribes = dbGetClusterTribes();
  let permissions = [];
  try {
    permissions = _ctx.db.instance().prepare('SELECT * FROM tribe_permissions ORDER BY created_at DESC LIMIT 50').all();
  } catch {}

  return {
    enabled: _ctx.settings.isEnabled('tribe_enforcement'),
    cluster_tribes: tribes.length,
    tribes_detail: tribes.slice(0, 20).map(t => ({
      cluster_tribe_id: t.cluster_tribe_id,
      tribe_name: t.tribe_name,
      canonical_server_id: t.canonical_server_id,
      founder_player_id: t.founder_player_id || null,
      member_count: dbGetTribeMemberCount(t.cluster_tribe_id),
      last_seen: t.last_seen,
      permissions: permissions.filter(p => p.cluster_tribe_id === t.cluster_tribe_id).map(p => p.permission),
    })),
    map_links: dbGetTribeMapLinks().length,
    active_enforcements: _activeTribeEnforcements.size,
    recent_actions: dbGetTribeEnforcementLog(10),
    permissions_count: permissions.length,
  };
}

function syncTribeSizeFromConfig() {
  try {
    const servers = _ctx.servers.list();
    const path = require('path');
    const fs = require('fs');
    for (const srv of servers) {
      if (!srv.config_dir) continue;
      const gameIniPath = path.join(srv.config_dir, 'Game.ini');
      if (!fs.existsSync(gameIniPath)) continue;
      const content = fs.readFileSync(gameIniPath, 'utf8');
      const match = content.match(/MaxNumberOfPlayersInTribe\s*=\s*(\d+)/i);
      if (match) {
        const val = parseInt(match[1], 10);
        if (val > 0 && val !== parseInt(_ctx.settings.get('max_tribe_size', '100'), 10)) {
          _ctx.settings.set('max_tribe_size', String(val));
          _ctx.log(`[TribeSync] Updated max_tribe_size to ${val} from Game.ini (${srv.name})`, 'info');
        }
        break;
      }
    }
  } catch (e) {
    _ctx.log(`[TribeSync] Config sync error: ${e.message}`, 'warn');
  }
}

// ─── Init ───
function init(ctx) {
  _ctx = ctx;
  _ctx.log('[TribeEnforcer] Feature initialized', 'info');
}

function shutdown() {
  _recentTribeEvents.clear();
  _activeTribeEnforcements.clear();
  _lastTribeRename.clear();
  _tribeEnforcementAttempts.clear();
  _recentTribeLeavers.clear();
  _mapTribeCreationLocks.clear();
  _recentTribeLogs.clear();
}

module.exports = {
  core,
  name,
  init,
  shutdown,
  // Core API
  trackTribeEvent,
  shouldEnforceTribe,
  cleanTribeEvents,
  handleTribeRename,
  handlePlayerJoinTribeEnforcement,
  // Cluster tribe management
  getClusterTribeForPlayer,
  getMapTribe,
  dbGetClusterTribes,
  dbGetTribeMemberCount,
  dbGetTribeMembers,
  dbGetTribeMapLinks,
  dbGetTribeEnforcementLog,
  dbRecordTribeEnforcement,
  registerClusterTribe,
  updateClusterTribeMembers,
  linkMapTribe,
  createMapTribe,
  // Permissions
  grantTribePermission,
  hasTribePermission,
  logTribeAdminAction,
  // Status
  getTribeEnforcementStatus,
  syncTribeSizeFromConfig,
  // Parsers
  parseTribeLogEvent,
  parseTribeRename,
  buildClusterTribeId,
  // State access
  getRecentTribeEventsCount: () => _recentTribeEvents.size,
  getActiveEnforcementsCount: () => _activeTribeEnforcements.size,
};
