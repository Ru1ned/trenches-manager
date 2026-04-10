/**
 * Feature: TrenchesRaid — Bracket-based raid protection & XP progression
 *
 * Integrates with tribeEnforcer for tribe identity and purgeWeekend for
 * purge-aware bypass. Tracks per-tribe XP, levels, and brackets, then
 * enforces bracket distance rules on all damage/raid events.
 *
 * Lifecycle: init → postInit (hooks damage events)
 *
 * Dependencies: tribeEnforcer
 */
'use strict';

const name = 'trenchesRaid';
const core = false;
const requires = ['tribeEnforcer'];

// ─── Constants ───

const XP_VALUES = {
  player_kill: 10,
  structure_destroy: 2,
  turret_destroy: 15,
  dino_kill: 5,
  defense_success: 50,
  raid_success: 100,
};

const LEVEL_THRESHOLDS = [0, 100, 300, 700, 1500, 3000, 6000, 12000];

const BRACKETS = [
  { name: 'Bronze', min: 1, max: 2 },
  { name: 'Silver', min: 3, max: 4 },
  { name: 'Gold',   min: 5, max: 6 },
  { name: 'Alpha',  min: 7, max: 8 },
];

const RETALIATION_DURATION_MS = 48 * 60 * 60 * 1000; // 48 hours
const PAIR_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between same pair XP
const DIMINISHING_WINDOW_MS = 5 * 60 * 1000; // 5 min window
const DIMINISHING_MAX_EVENTS = 10; // max events per window before diminish
const SAME_TRIBE_BLOCK = true;
const MAX_BRACKET_DIFF = 1; // ±1 allowed

// Raid alert constants
const RAID_ALERT_COOLDOWN_MS = 3 * 60 * 1000; // 3 min cooldown per defending tribe
const RAID_DETECT_WINDOW_MS = 30 * 1000; // 30s window for damage clustering
const RAID_DETECT_THRESHOLD = 3; // hits in window to trigger via damage alone
const RAID_MIN_DAMAGE = 5; // ignore trivial damage

// ─── State ───

let _ctx = null;
let _tribeEnforcer = null;
let _purgeWeekend = null;

// In-memory tribe raid data (keyed by clusterTribeId — globally unique)
// { xp, level, bracket, lastAttack, retaliationTargets: Map<targetClusterTribeId, expiresAt> }
const _tribeRaidData = new Map();

// clusterTribeId cache: serverTribeId → clusterTribeId (refreshed periodically)
const _clusterTribeIdCache = new Map();

// Anti-exploit: pairKey → lastXpTimestamp
const _pairCooldowns = new Map();

// Anti-exploit: tribeId → [{ timestamp }] recent events for diminishing
const _recentXpEvents = new Map();

// Raid alert state: defenderTribeId → { lastAlertAt, hits: [{ timestamp }] }
const _raidAlertState = new Map();

// Memory caps
const MEMORY_CAP_PAIRS = 500;
const MEMORY_CAP_EVENTS = 300;
const MEMORY_CAP_TRIBES = 500;

// ─── Helpers ───

function levelFromXp(xp) {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= LEVEL_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}

function bracketFromLevel(level) {
  for (const b of BRACKETS) {
    if (level >= b.min && level <= b.max) return b;
  }
  return BRACKETS[BRACKETS.length - 1];
}

function bracketIndex(bracket) {
  return BRACKETS.findIndex(b => b.name === bracket.name);
}

function pairKey(tribeA, tribeB) {
  return [tribeA, tribeB].sort().join(':');
}

function now() {
  return Date.now();
}

// ─── Memory safety ───

function enforceMemoryCaps() {
  if (_pairCooldowns.size > MEMORY_CAP_PAIRS) {
    const sorted = [..._pairCooldowns.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = sorted.slice(0, _pairCooldowns.size - MEMORY_CAP_PAIRS);
    for (const [key] of toRemove) _pairCooldowns.delete(key);
  }
  if (_recentXpEvents.size > MEMORY_CAP_EVENTS) {
    const sorted = [..._recentXpEvents.keys()];
    const toRemove = sorted.slice(0, _recentXpEvents.size - MEMORY_CAP_EVENTS);
    for (const key of toRemove) _recentXpEvents.delete(key);
  }
  if (_tribeRaidData.size > MEMORY_CAP_TRIBES) {
    // Keep tribes with highest XP
    const sorted = [..._tribeRaidData.entries()].sort((a, b) => b[1].xp - a[1].xp);
    const keep = new Set(sorted.slice(0, MEMORY_CAP_TRIBES).map(e => e[0]));
    for (const key of _tribeRaidData.keys()) {
      if (!keep.has(key)) _tribeRaidData.delete(key);
    }
  }
}

// ─── Cluster Tribe Identity ───

/**
 * Resolve a server-local tribeId to a cluster-wide clusterTribeId.
 * Uses tribeEnforcer's DB for authoritative mapping.
 * Falls back to raw tribeId if tribeEnforcer unavailable.
 */
function resolveClusterTribeId(serverTribeId) {
  if (!serverTribeId) return serverTribeId;

  // Check cache first
  const cached = _clusterTribeIdCache.get(serverTribeId);
  if (cached) return cached;

  // Try tribeEnforcer lookup
  if (_tribeEnforcer && _ctx && _ctx.db) {
    try {
      const row = _ctx.db.instance().prepare(
        `SELECT cluster_tribe_id FROM tribe_map_links WHERE map_tribe_id = ? LIMIT 1`
      ).get(serverTribeId);
      if (row && row.cluster_tribe_id) {
        _clusterTribeIdCache.set(serverTribeId, row.cluster_tribe_id);
        return row.cluster_tribe_id;
      }
    } catch (err) {
      _ctx.log(`[trenchesRaid] clusterTribeId lookup error: ${err.message}`, 'debug');
    }
  }

  // Fallback: use serverTribeId directly (works for single-server setups)
  return serverTribeId;
}

/**
 * Periodically clear cache so tribe identity stays fresh.
 */
function clearClusterTribeIdCache() {
  _clusterTribeIdCache.clear();
}

// ─── Tribe Data Access ───

function ensureTribe(tribeId) {
  if (!_tribeRaidData.has(tribeId)) {
    _tribeRaidData.set(tribeId, {
      xp: 0,
      level: 1,
      bracket: BRACKETS[0],
      members: new Set(),
      lastAttack: 0,
      retaliationTargets: new Map(),
    });
  }
  return _tribeRaidData.get(tribeId);
}

function getTribeData(tribeId) {
  return _tribeRaidData.get(tribeId) || null;
}

function recalcLevel(data) {
  const oldLevel = data.level;
  data.level = levelFromXp(data.xp);
  data.bracket = bracketFromLevel(data.level);
  return data.level !== oldLevel;
}

// ─── Retaliation ───

function grantRetaliation(defenderTribeId, attackerTribeId) {
  const defender = ensureTribe(defenderTribeId);
  const expiresAt = now() + RETALIATION_DURATION_MS;
  defender.retaliationTargets.set(attackerTribeId, expiresAt);
  _ctx.log(`[trenchesRaid] retaliation granted ${defenderTribeId} → ${attackerTribeId} for 48h`, 'info');
}

function hasRetaliation(tribeId, targetTribeId) {
  const data = getTribeData(tribeId);
  if (!data) return false;
  const expires = data.retaliationTargets.get(targetTribeId);
  if (!expires) return false;
  if (now() > expires) {
    data.retaliationTargets.delete(targetTribeId);
    return false;
  }
  return true;
}

function cleanExpiredRetaliations() {
  const timestamp = now();
  for (const [, data] of _tribeRaidData) {
    for (const [target, expires] of data.retaliationTargets) {
      if (timestamp > expires) {
        data.retaliationTargets.delete(target);
      }
    }
  }
}

// ─── Anti-exploit ───

function isPairOnCooldown(tribeA, tribeB) {
  const key = pairKey(tribeA, tribeB);
  const last = _pairCooldowns.get(key);
  if (!last) return false;
  return (now() - last) < PAIR_COOLDOWN_MS;
}

function setPairCooldown(tribeA, tribeB) {
  _pairCooldowns.set(pairKey(tribeA, tribeB), now());
}

function getDiminishingMultiplier(tribeId) {
  const events = _recentXpEvents.get(tribeId) || [];
  const cutoff = now() - DIMINISHING_WINDOW_MS;
  const recent = events.filter(e => e.timestamp > cutoff);
  _recentXpEvents.set(tribeId, recent);

  if (recent.length >= DIMINISHING_MAX_EVENTS) {
    // Diminishing: halve XP for each event past threshold
    const over = recent.length - DIMINISHING_MAX_EVENTS;
    return Math.max(0.1, 1 / (1 + over));
  }
  return 1.0;
}

function recordXpEvent(tribeId) {
  if (!_recentXpEvents.has(tribeId)) _recentXpEvents.set(tribeId, []);
  _recentXpEvents.get(tribeId).push({ timestamp: now() });
}

// ─── XP Award ───

function awardXp(tribeId, eventType, targetTribeId) {
  if (!tribeId) return;

  // Same-tribe block
  if (SAME_TRIBE_BLOCK && targetTribeId && tribeId === targetTribeId) return;

  // Pair cooldown
  if (targetTribeId && isPairOnCooldown(tribeId, targetTribeId)) return;

  const baseXp = XP_VALUES[eventType] || 0;
  if (baseXp <= 0) return;

  // Diminishing returns
  const multiplier = getDiminishingMultiplier(tribeId);
  const finalXp = Math.max(1, Math.round(baseXp * multiplier));

  const data = ensureTribe(tribeId);
  data.xp += finalXp;

  // Record for anti-exploit
  recordXpEvent(tribeId);
  if (targetTribeId) setPairCooldown(tribeId, targetTribeId);

  // Check level up
  const leveled = recalcLevel(data);
  if (leveled) {
    _ctx.log(`[trenchesRaid] tribe ${tribeId} leveled up → ${data.level} (${data.bracket.name})`, 'info');
    _ctx.events.emit('raid:levelup', `Tribe ${tribeId} reached level ${data.level}`, {
      tribeId, level: data.level, bracket: data.bracket.name, xp: data.xp,
    });
    forwardToDiscord('levelup', { tribeId, level: data.level, bracket: data.bracket.name, xp: data.xp });
  }
}

// ─── Purge Check ───

function isPurgeActive() {
  if (!_purgeWeekend) return false;
  try {
    return typeof _purgeWeekend.isPurgeActiveNow === 'function'
      ? _purgeWeekend.isPurgeActiveNow()
      : false;
  } catch {
    return false;
  }
}

// ─── Damage Gate ───

/**
 * Evaluate whether a raid/damage action should be allowed.
 * @param {string} attackerTribeId - cluster tribe ID of attacker
 * @param {string} defenderTribeId - cluster tribe ID of defender
 * @returns {{ allowed: boolean, reason?: string }}
 */
function evaluateRaidPermission(attackerTribeId, defenderTribeId) {
  // Purge weekend → allow everything
  if (isPurgeActive()) {
    return { allowed: true, reason: 'purge_active' };
  }

  // Same tribe → always allow (friendly fire handled elsewhere)
  if (attackerTribeId === defenderTribeId) {
    return { allowed: true, reason: 'same_tribe' };
  }

  // Missing tribe data → allow (no bracket info = no restriction)
  const attacker = getTribeData(attackerTribeId);
  const defender = getTribeData(defenderTribeId);
  if (!attacker || !defender) {
    return { allowed: true, reason: 'no_bracket_data' };
  }

  const attackerBracketIdx = bracketIndex(attacker.bracket);
  const defenderBracketIdx = bracketIndex(defender.bracket);
  const diff = Math.abs(attackerBracketIdx - defenderBracketIdx);

  // Retaliation override → allow regardless of bracket
  if (hasRetaliation(attackerTribeId, defenderTribeId)) {
    return { allowed: true, reason: 'retaliation' };
  }

  // Bracket distance check
  if (diff > MAX_BRACKET_DIFF) {
    _ctx.log(`[trenchesRaid] blocked raid ${attackerTribeId} (${attacker.bracket.name}) → ${defenderTribeId} (${defender.bracket.name})`, 'warn');
    _ctx.events.emit('raid:blocked', `Bracket mismatch: ${attacker.bracket.name} vs ${defender.bracket.name}`, {
      attackerTribeId, defenderTribeId,
      attackerBracket: attacker.bracket.name,
      defenderBracket: defender.bracket.name,
      diff,
    });
    forwardToDiscord('blocked', { attackerTribeId, defenderTribeId, attackerBracket: attacker.bracket.name, defenderBracket: defender.bracket.name });
    return { allowed: false, reason: `bracket_diff_${diff}` };
  }

  // Lower attacks higher → grant retaliation to defender
  if (attackerBracketIdx < defenderBracketIdx) {
    grantRetaliation(defenderTribeId, attackerTribeId);
    forwardToDiscord('retaliation', { defenderTribeId, attackerTribeId });
  }

  return { allowed: true, reason: 'bracket_ok' };
}

// ─── Raid Alert System ───

/**
 * Check if a raid alert should fire for the defending tribe.
 * Triggers on: structure/turret destroy (instant) or damage clustering.
 * Cooldown: one alert per defender every RAID_ALERT_COOLDOWN_MS.
 */
function checkRaidAlert(attackerTribeId, defenderTribeId, eventType, serverName, damage) {
  if (!attackerTribeId || !defenderTribeId) return;
  if (attackerTribeId === defenderTribeId) return; // ignore self
  if (damage !== undefined && damage < RAID_MIN_DAMAGE) return; // ignore trivial

  const timestamp = now();
  let state = _raidAlertState.get(defenderTribeId);
  if (!state) {
    state = { lastAlertAt: 0, hits: [] };
    _raidAlertState.set(defenderTribeId, state);
  }

  // Cooldown check — skip if recently alerted
  if (timestamp - state.lastAlertAt < RAID_ALERT_COOLDOWN_MS) return;

  // Instant trigger for structure/turret destruction
  const instantTrigger = (eventType === 'structure' || eventType === 'turret'
    || eventType === 'structure_destroy' || eventType === 'turret_destroy');

  if (!instantTrigger) {
    // Cluster detection: track hits and check threshold
    state.hits = state.hits.filter(h => timestamp - h < RAID_DETECT_WINDOW_MS);
    state.hits.push(timestamp);
    if (state.hits.length < RAID_DETECT_THRESHOLD) return;
  }

  // Fire alert
  state.lastAlertAt = timestamp;
  state.hits = [];
  _ctx.log(`[trenchesRaid] RAID ALERT triggered for tribe ${defenderTribeId}`, 'info');

  // In-game message
  if (serverName) {
    sendChat(serverName, `🚨 [RAID ALERT] Your base is under attack!`);
  }

  // Discord alert
  forwardToDiscord('raidAlert', { attackerTribeId, defenderTribeId });
}

// Cap raid alert state memory
function cleanRaidAlertState() {
  if (_raidAlertState.size > MEMORY_CAP_TRIBES) {
    const cutoff = now() - RAID_ALERT_COOLDOWN_MS * 10;
    for (const [key, state] of _raidAlertState) {
      if (state.lastAlertAt < cutoff) _raidAlertState.delete(key);
    }
  }
}

// ─── Event Handlers ───

function handleDamageEvent(event) {
  try {
    const { attackerTribeId: rawAttacker, defenderTribeId: rawDefender, type, damage, serverName, structureId, structureType } = event || {};
    if (!rawAttacker || !rawDefender) return { allowed: true };

    // Resolve to cluster-wide tribe IDs
    const attackerTribeId = resolveClusterTribeId(rawAttacker);
    const defenderTribeId = resolveClusterTribeId(rawDefender);

    // Purge bypass — skip all zone/bracket checks
    if (isPurgeActive()) {
      return { allowed: true, reason: 'purge_active' };
    }

    // White flag check (global, before everything — cluster-wide)
    const raidZones = _ctx && _ctx.features ? _ctx.features.raidZones : null;
    if (raidZones) {
      if (raidZones.hasWhiteFlag(attackerTribeId)) {
        return { allowed: false, reason: 'attacker_white_flag' };
      }
      if (raidZones.hasWhiteFlag(defenderTribeId)) {
        return { allowed: false, reason: 'defender_white_flag' };
      }

      // Raid Zone protection + tracking (runs BEFORE bracket system)
      const zoneResult = raidZones.evaluateZoneDamage(attackerTribeId, defenderTribeId, structureId, structureType);
      if (!zoneResult.allowed) {
        return { allowed: false, reason: zoneResult.reason };
      }
    }

    const result = evaluateRaidPermission(attackerTribeId, defenderTribeId);
    // Check raid alert (non-blocking, runs after permission check)
    if (result.allowed) {
      checkRaidAlert(attackerTribeId, defenderTribeId, type, serverName, damage);
    }
    return result;
  } catch (err) {
    _ctx.log(`[trenchesRaid] damage event error: ${err.message}`, 'error');
    return { allowed: true }; // fail-open
  }
}

function handleKillEvent(event) {
  try {
    const { killerTribeId: rawKiller, victimTribeId: rawVictim, killType, serverName,
            killerEosId, killerName, victimEosId, victimName } = event || {};
    if (!rawKiller) return;

    // Resolve to cluster-wide tribe IDs
    const killerTribeId = resolveClusterTribeId(rawKiller);
    const victimTribeId = resolveClusterTribeId(rawVictim);

    const permission = evaluateRaidPermission(killerTribeId, victimTribeId || killerTribeId);
    if (!permission.allowed) return;

    // Map kill types to XP events
    const xpType = {
      player: 'player_kill',
      dino: 'dino_kill',
      structure: 'structure_destroy',
      turret: 'turret_destroy',
    }[killType] || null;

    if (xpType) {
      awardXp(killerTribeId, xpType, victimTribeId);
    }

    // Forward to playerStats for leaderboard tracking (use cluster tribe IDs)
    forwardToStats(killType, killerEosId, killerName, killerTribeId, victimEosId, victimName || '', victimTribeId);

    // Trigger raid alert for structure/turret destroys
    if (killType === 'structure' || killType === 'turret') {
      checkRaidAlert(killerTribeId, victimTribeId, killType, serverName);
    }
  } catch (err) {
    _ctx.log(`[trenchesRaid] kill event error: ${err.message}`, 'error');
  }
}

function handleRaidComplete(event) {
  try {
    const { attackerTribeId, defenderTribeId, success } = event || {};
    if (!attackerTribeId) return;

    if (success) {
      awardXp(attackerTribeId, 'raid_success', defenderTribeId);
    } else {
      // Defense success for the defender
      if (defenderTribeId) {
        awardXp(defenderTribeId, 'defense_success', attackerTribeId);
      }
    }
  } catch (err) {
    _ctx.log(`[trenchesRaid] raid complete error: ${err.message}`, 'error');
  }
}

// ─── DB Persistence ───

function persistTribeData() {
  if (!_ctx) return;
  try {
    _ctx.db.run(`
      CREATE TABLE IF NOT EXISTS raid_tribe_data (
        tribe_id TEXT PRIMARY KEY,
        xp INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        bracket TEXT DEFAULT 'Bronze',
        members TEXT DEFAULT '[]',
        last_attack INTEGER DEFAULT 0,
        retaliation_targets TEXT DEFAULT '{}',
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    for (const [tribeId, data] of _tribeRaidData) {
      const membersJson = JSON.stringify([...data.members]);
      const retaliationJson = JSON.stringify(Object.fromEntries(data.retaliationTargets));
      _ctx.db.run(`
        INSERT INTO raid_tribe_data (tribe_id, xp, level, bracket, members, last_attack, retaliation_targets, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(tribe_id) DO UPDATE SET
          xp = excluded.xp,
          level = excluded.level,
          bracket = excluded.bracket,
          members = excluded.members,
          last_attack = excluded.last_attack,
          retaliation_targets = excluded.retaliation_targets,
          updated_at = datetime('now')
      `, tribeId, data.xp, data.level, data.bracket.name, membersJson, data.last_attack, retaliationJson);
    }
  } catch (err) {
    _ctx.log(`[trenchesRaid] persist error: ${err.message}`, 'error');
  }
}

function loadTribeData() {
  if (!_ctx) return;
  try {
    _ctx.db.run(`
      CREATE TABLE IF NOT EXISTS raid_tribe_data (
        tribe_id TEXT PRIMARY KEY,
        xp INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        bracket TEXT DEFAULT 'Bronze',
        members TEXT DEFAULT '[]',
        last_attack INTEGER DEFAULT 0,
        retaliation_targets TEXT DEFAULT '{}',
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    const rows = _ctx.db.query('SELECT * FROM raid_tribe_data');
    for (const row of rows) {
      let members;
      try { members = new Set(JSON.parse(row.members || '[]')); } catch { members = new Set(); }

      let retaliationTargets;
      try {
        const parsed = JSON.parse(row.retaliation_targets || '{}');
        retaliationTargets = new Map(Object.entries(parsed).map(([k, v]) => [k, Number(v)]));
      } catch { retaliationTargets = new Map(); }

      _tribeRaidData.set(row.tribe_id, {
        xp: row.xp || 0,
        level: row.level || 1,
        bracket: bracketFromLevel(row.level || 1),
        members,
        lastAttack: row.last_attack || 0,
        retaliationTargets,
      });
    }
    _ctx.log(`[trenchesRaid] loaded ${_tribeRaidData.size} tribe records from DB`, 'info');
  } catch (err) {
    _ctx.log(`[trenchesRaid] load error: ${err.message}`, 'error');
  }
}

// ─── Periodic tasks ───

let _persistInterval = null;
let _cleanupInterval = null;

function startPeriodicTasks() {
  // Persist every 60s
  _persistInterval = setInterval(() => {
    persistTribeData();
    enforceMemoryCaps();
  }, 60000);

  // Clean expired retaliations + raid alert state + tribe ID cache every 5 min
  _cleanupInterval = setInterval(() => {
    cleanExpiredRetaliations();
    cleanRaidAlertState();
    clearClusterTribeIdCache();
  }, 300000);
}

function stopPeriodicTasks() {
  if (_persistInterval) { clearInterval(_persistInterval); _persistInterval = null; }
  if (_cleanupInterval) { clearInterval(_cleanupInterval); _cleanupInterval = null; }
}

// ─── Diagnostics ───

function getRaidStatus() {
  const tribes = [];
  for (const [tribeId, data] of _tribeRaidData) {
    tribes.push({
      tribeId,
      xp: data.xp,
      level: data.level,
      bracket: data.bracket.name,
      members: data.members.size,
      lastAttack: data.lastAttack,
      activeRetaliations: data.retaliationTargets.size,
    });
  }
  return {
    totalTribes: _tribeRaidData.size,
    purgeActive: isPurgeActive(),
    pairCooldowns: _pairCooldowns.size,
    tribes: tribes.sort((a, b) => b.xp - a.xp).slice(0, 50),
  };
}

function getTribeRaidInfo(tribeId) {
  const data = getTribeData(tribeId);
  if (!data) return null;
  return {
    tribeId,
    xp: data.xp,
    level: data.level,
    bracket: data.bracket.name,
    members: [...data.members],
    lastAttack: data.lastAttack,
    retaliationTargets: Object.fromEntries(
      [...data.retaliationTargets.entries()].map(([k, v]) => [k, { expiresAt: v, remainingMs: Math.max(0, v - now()) }])
    ),
    nextLevelXp: data.level < LEVEL_THRESHOLDS.length
      ? LEVEL_THRESHOLDS[data.level] - data.xp
      : 0,
  };
}

// ─── Chat Commands ───

function sendChat(serverName, message) {
  try {
    if (_ctx && _ctx.runtime && typeof _ctx.runtime.getChatClient === 'function') {
      const client = _ctx.runtime.getChatClient(serverName);
      if (client && client.connected) {
        client.execute(`ServerChat ${message}`);
        return true;
      }
    }
  } catch (e) {
    _ctx.log(`[trenchesRaid] chat send error: ${e.message}`, 'warn');
  }
  return false;
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return 'expired';
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Handle in-game chat commands for raid system.
 * Returns true if command was handled, false otherwise.
 */
function handleRaidChat(playerId, playerName, message, serverName) {
  const cmd = (message || '').trim().toLowerCase();

  if (cmd === '/tribe') {
    return handleTribeCommand(playerId, playerName, serverName);
  }
  if (cmd === '/tribetop') {
    return handleTribeTopCommand(serverName);
  }
  if (cmd.startsWith('/raidstatus')) {
    return handleRaidStatusCommand(playerId, playerName, cmd, serverName);
  }

  // Forward zone commands to raidZones
  if (cmd === '/nwf' || cmd === '/anchor' || cmd === '/raidzone') {
    const raidZones = _ctx && _ctx.features ? _ctx.features.raidZones : null;
    if (raidZones && typeof raidZones.handleZoneChat === 'function') {
      return raidZones.handleZoneChat(playerId, playerName, message, serverName);
    }
  }

  return false;
}

function handleTribeCommand(playerId, playerName, serverName) {
  // Find tribe for this player
  let playerTribeId = null;
  for (const [tribeId, data] of _tribeRaidData) {
    if (data.members.has(playerId)) {
      playerTribeId = tribeId;
      break;
    }
  }

  if (!playerTribeId) {
    sendChat(serverName, `[Raid] ${playerName}: No tribe data found.`);
    return true;
  }

  const info = getTribeRaidInfo(playerTribeId);
  if (!info) {
    sendChat(serverName, `[Raid] ${playerName}: No raid data for your tribe.`);
    return true;
  }

  const nextXp = info.nextLevelXp > 0 ? `${info.nextLevelXp} XP to next level` : 'MAX LEVEL';
  sendChat(serverName, `[Raid] ${playerName}'s Tribe: Level ${info.level} (${info.bracket}) | ${info.xp} XP | ${nextXp}`);

  // Show retaliations
  const retKeys = Object.keys(info.retaliationTargets || {});
  if (retKeys.length > 0) {
    const retList = retKeys.slice(0, 3).map(t => {
      const r = info.retaliationTargets[t];
      return `${t} (${formatTimeRemaining(r.remainingMs)})`;
    }).join(', ');
    sendChat(serverName, `[Raid] Active retaliations: ${retList}`);
  }

  return true;
}

function handleTribeTopCommand(serverName) {
  const status = getRaidStatus();
  if (!status || status.tribes.length === 0) {
    sendChat(serverName, '[Raid] No tribes ranked yet.');
    return true;
  }

  const top = status.tribes.slice(0, 10);
  sendChat(serverName, `[Raid] === Top ${top.length} Tribes ===`);
  top.forEach((t, i) => {
    sendChat(serverName, `[Raid] #${i + 1} ${t.tribeId} — Lvl ${t.level} (${t.bracket}) ${t.xp} XP`);
  });

  return true;
}

function handleRaidStatusCommand(playerId, playerName, cmd, serverName) {
  // Find player's tribe
  let playerTribeId = null;
  for (const [tribeId, data] of _tribeRaidData) {
    if (data.members.has(playerId)) {
      playerTribeId = tribeId;
      break;
    }
  }

  if (!playerTribeId) {
    sendChat(serverName, `[Raid] ${playerName}: No tribe data found.`);
    return true;
  }

  if (isPurgeActive()) {
    sendChat(serverName, `[Raid] PURGE ACTIVE — All raids allowed!`);
    return true;
  }

  const myData = getTribeData(playerTribeId);
  if (!myData) {
    sendChat(serverName, `[Raid] ${playerName}: No bracket data.`);
    return true;
  }

  sendChat(serverName, `[Raid] Your tribe: Level ${myData.level} (${myData.bracket.name})`);
  sendChat(serverName, `[Raid] Can attack: Same bracket or ±1 bracket`);

  const retCount = myData.retaliationTargets.size;
  if (retCount > 0) {
    sendChat(serverName, `[Raid] ${retCount} active retaliation target(s) — attack freely`);
  }

  return true;
}

// ─── Damage Feedback ───

/**
 * Send in-game feedback when a raid is blocked or retaliation is active.
 * Called by external damage handler with server context.
 */
function sendDamageFeedback(serverName, attackerName, result) {
  if (!result || !serverName) return;

  if (!result.allowed && result.reason && result.reason.startsWith('bracket_diff')) {
    sendChat(serverName, `[Raid] ${attackerName}: Target is protected (lower bracket). Raid blocked.`);
  } else if (result.allowed && result.reason === 'retaliation') {
    sendChat(serverName, `[Raid] ${attackerName}: Retaliation active — raid allowed!`);
  }
}

// ─── Stats Forwarding ───

function forwardToStats(killType, killerEosId, killerName, killerTribeId, victimEosId, victimName, victimTribeId) {
  if (!_ctx || !_ctx.features || !_ctx.features.playerStats) return;
  const stats = _ctx.features.playerStats;
  try {
    if (killType === 'player') {
      // recordKill now handles both killer stats AND victim death in one call
      stats.recordKill(killerEosId, killerName, killerTribeId, victimEosId, victimName, victimTribeId);
    } else if (killType === 'dino') {
      stats.recordDinoKill(killerEosId, killerName, killerTribeId);
    } else if (killType === 'structure' || killType === 'turret') {
      stats.recordStructureDestroy(killerEosId, killerName, killerTribeId);
    }
  } catch (err) {
    _ctx.log(`[trenchesRaid] stats forward error: ${err.message}`, 'warn');
  }
}

// ─── Discord Event Forwarding ───

function forwardToDiscord(eventType, data) {
  if (!_ctx || !_ctx.features) return;
  const raidDiscord = _ctx.features.raidDiscord;
  if (!raidDiscord) return;

  try {
    switch (eventType) {
      case 'levelup':
        raidDiscord.onLevelUp(data.tribeId, data.level, data.bracket, data.xp);
        break;
      case 'blocked':
        raidDiscord.onRaidBlocked(data.attackerTribeId, data.defenderTribeId, data.attackerBracket, data.defenderBracket);
        break;
      case 'retaliation':
        raidDiscord.onRetaliationGranted(data.defenderTribeId, data.attackerTribeId);
        break;
      case 'raidAlert':
        if (typeof raidDiscord.onRaidAlert === 'function') {
          raidDiscord.onRaidAlert(data.attackerTribeId, data.defenderTribeId);
        }
        break;
      case 'raidStarted':
      case 'raidResolved':
      case 'whiteFlag':
        if (typeof raidDiscord.onRaidZoneEvent === 'function') {
          raidDiscord.onRaidZoneEvent(eventType, data);
        }
        break;
    }
  } catch (err) {
    _ctx.log(`[trenchesRaid] discord forward error: ${err.message}`, 'warn');
  }
}

// ─── Lifecycle ───

async function init(ctx) {
  _ctx = ctx;
  _tribeEnforcer = ctx.features.tribeEnforcer || null;

  // Load persisted data
  loadTribeData();

  // Start periodic tasks
  startPeriodicTasks();

  _ctx.log('[trenchesRaid] initialized', 'info');
}

async function postInit(runtimeRefs) {
  // Grab purgeWeekend if available
  if (_ctx && _ctx.features && _ctx.features.purgeWeekend) {
    _purgeWeekend = _ctx.features.purgeWeekend;
    _ctx.log('[trenchesRaid] purgeWeekend integration active', 'info');
  }

  if (!_tribeEnforcer && _ctx && _ctx.features && _ctx.features.tribeEnforcer) {
    _tribeEnforcer = _ctx.features.tribeEnforcer;
  }

  // Listen for raidZone events — trenchesRaid is the single controller
  if (_ctx && _ctx.events) {
    _ctx.events.on('raid:zone_started', (msg, data) => {
      try {
        forwardToDiscord('raidStarted', data);
        _ctx.log(`[trenchesRaid] zone raid started: ${data.attackerTribeId} → ${data.defenderTribeId}`, 'info');
      } catch (err) {
        _ctx.log(`[trenchesRaid] zone_started handler error: ${err.message}`, 'warn');
      }
    });

    _ctx.events.on('raid:zone_resolved', (msg, data) => {
      try {
        const { outcome, attackerTribeId, defenderTribeId, percentDestroyed } = data;

        // XP via handleRaidComplete
        handleRaidComplete({
          attackerTribeId,
          defenderTribeId,
          success: outcome === 'attacker_win',
        });

        // White flag on defender loss
        if (outcome === 'attacker_win') {
          const raidZones = _ctx.features ? _ctx.features.raidZones : null;
          if (raidZones) raidZones.activateWhiteFlag(defenderTribeId);
        }

        // Discord
        forwardToDiscord('raidResolved', data);

        _ctx.log(`[trenchesRaid] zone raid resolved: ${outcome} (${percentDestroyed}% destroyed)`, 'info');
      } catch (err) {
        _ctx.log(`[trenchesRaid] zone_resolved handler error: ${err.message}`, 'warn');
      }
    });

    _ctx.events.on('raid:white_flag', (msg, data) => {
      try {
        forwardToDiscord('whiteFlag', data);
      } catch (err) {
        _ctx.log(`[trenchesRaid] white_flag handler error: ${err.message}`, 'warn');
      }
    });

    _ctx.log('[trenchesRaid] raidZone event listeners registered', 'info');
  }
}

async function shutdown() {
  stopPeriodicTasks();
  persistTribeData();
  _tribeRaidData.clear();
  _pairCooldowns.clear();
  _recentXpEvents.clear();
  _raidAlertState.clear();
  _clusterTribeIdCache.clear();
  _ctx = null;
  _tribeEnforcer = null;
  _purgeWeekend = null;
}

// ─── Exports ───

module.exports = {
  name,
  core,
  requires,
  init,
  postInit,
  shutdown,
  // Damage gate
  evaluateRaidPermission,
  handleDamageEvent,
  handleKillEvent,
  handleRaidComplete,
  // Chat commands
  handleRaidChat,
  // Damage feedback
  sendDamageFeedback,
  // Discord forwarding
  forwardToDiscord,
  // XP
  awardXp,
  // Cluster identity
  resolveClusterTribeId,
  // Data access
  getTribeRaidInfo,
  getRaidStatus,
  ensureTribe,
  getTribeData,
  // Retaliation
  grantRetaliation,
  hasRetaliation,
  // Purge check
  isPurgeActive,
  // Level helpers
  levelFromXp,
  bracketFromLevel,
  LEVEL_THRESHOLDS,
  BRACKETS,
  XP_VALUES,
};
