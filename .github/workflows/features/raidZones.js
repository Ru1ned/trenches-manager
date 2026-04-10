/**
 * Feature: Raid Zones — Tek Forcefield Base Anchor System
 *
 * Server-authoritative raid zone system using Tek Forcefields as base anchors.
 * Determines raid protection eligibility, tracks raid sessions, enforces
 * real base destruction, and manages white flags.
 *
 * Dependencies: trenchesRaid, tribeEnforcer
 */
'use strict';

const name = 'raidZones';
const core = false;
const requires = ['trenchesRaid', 'tribeEnforcer'];

// ─── Constants ───

const ANCHOR_RADIUS = 3000;                          // unit radius around forcefield
const MIN_BASE_VALUE = 500;                           // minimum weighted value
const MIN_STRUCTURE_COUNT = 25;                       // minimum structures inside radius
const CLUSTER_COVERAGE_REQUIRED = 0.70;               // 70% of main cluster inside anchor
const ANCHOR_PLACEMENT_COOLDOWN_MS = 30 * 60 * 1000;  // 30 min after removal
const RAID_FORFEIT_MS = 2 * 60 * 60 * 1000;           // 2 hours no activity → defender wins
const ATTACKER_WIN_THRESHOLD = 0.80;                  // 80% destruction → attacker wins
const WHITE_FLAG_DURATION_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

// Structure weights (anti-spam)
const STRUCTURE_WEIGHTS = {
  foundation:  1,
  ceiling:     1,
  wall:        1,
  door:        1,
  doorframe:   1,
  window:      1,
  ramp:        0,
  pillar:      0,
  fence:       1,
  turret:      25,
  turret_heavy: 25,
  turret_tek:  25,
  bed:         100,
  sleeping_bag: 10,
  generator:   150,
  tek_generator: 150,
  vault:       200,
  fabricator:  10,
  forge:       10,
  smithy:      10,
  mortar:      5,
  trough:      10,
  fridge:      10,
  storage:     5,
  default:     1,
};

const CRITICAL_TYPES = new Set([
  'generator', 'tek_generator', 'turret', 'turret_heavy', 'turret_tek',
  'bed',
]);

const ANCHOR_HEALTH_CHECK_MS = 3 * 60 * 1000; // 3 min periodic validation
const ANCHOR_SPAM_WINDOW_MS = 10 * 60 * 1000; // 10 min window for spam detection
const ANCHOR_SPAM_MAX = 3; // max placements per window

// ─── State ───

let _ctx = null;

// tribeId → { anchorId, position, registeredAt, valid, snapshot, raidSession, whiteFlag, validationReasons }
const _anchors = new Map();

// tribeId → lastRemovedAt (cooldown tracking)
const _anchorCooldowns = new Map();

// tribeId → [timestamps] for placement spam tracking
const _anchorPlacementHistory = new Map();

// Memory cap
const MEMORY_CAP = 500;

// ─── Helpers ───

function now() { return Date.now(); }

function distance3D(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getWeight(structureType) {
  const key = (structureType || '').toLowerCase().replace(/\s+/g, '_');
  return STRUCTURE_WEIGHTS[key] !== undefined ? STRUCTURE_WEIGHTS[key] : STRUCTURE_WEIGHTS.default;
}

// ─── Base Cluster Detection ───

/**
 * Group tribe structures by proximity, return the largest cluster.
 * Uses simple grid-based clustering (fast, deterministic).
 */
function findPrimaryCluster(structures) {
  if (!structures || structures.length === 0) return { structures: [], center: { x: 0, y: 0, z: 0 } };

  const GRID_SIZE = 1500; // cluster grouping radius
  const buckets = new Map();

  for (const s of structures) {
    const gx = Math.floor((s.x || 0) / GRID_SIZE);
    const gy = Math.floor((s.y || 0) / GRID_SIZE);
    const key = `${gx}:${gy}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }

  // Merge adjacent grid cells
  const clusters = [];
  const visited = new Set();

  for (const [key, items] of buckets) {
    if (visited.has(key)) continue;
    const cluster = [...items];
    visited.add(key);

    const [gx, gy] = key.split(':').map(Number);
    // Check 8 neighbors
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nKey = `${gx + dx}:${gy + dy}`;
        if (buckets.has(nKey) && !visited.has(nKey)) {
          cluster.push(...buckets.get(nKey));
          visited.add(nKey);
        }
      }
    }
    clusters.push(cluster);
  }

  // Pick largest by weighted value
  let best = clusters[0] || [];
  let bestValue = 0;
  for (const c of clusters) {
    const val = c.reduce((sum, s) => sum + getWeight(s.type), 0);
    if (val > bestValue) { bestValue = val; best = c; }
  }

  // Compute center
  const center = { x: 0, y: 0, z: 0 };
  if (best.length > 0) {
    for (const s of best) {
      center.x += (s.x || 0);
      center.y += (s.y || 0);
      center.z += (s.z || 0);
    }
    center.x /= best.length;
    center.y /= best.length;
    center.z /= best.length;
  }

  return { structures: best, center };
}

// ─── Anchor Validation ───

/**
 * Build a snapshot of structures inside anchor radius and validate.
 * @param {object} anchorPos - { x, y, z }
 * @param {Array} tribeStructures - all structures belonging to tribe
 * @returns {{ valid, snapshot, reason }}
 */
function buildAndValidateSnapshot(anchorPos, tribeStructures) {
  const reasons = []; // collect ALL validation issues

  if (!tribeStructures || tribeStructures.length === 0) {
    return { valid: false, snapshot: null, reason: 'no_structures', reasons: ['No tribe structures found'] };
  }

  // 1. Find primary base cluster
  const primaryCluster = findPrimaryCluster(tribeStructures);

  // 2. Structures inside anchor radius
  const insideAnchor = tribeStructures.filter(s => distance3D(anchorPos, s) <= ANCHOR_RADIUS);

  // 3. How many primary cluster structures are inside anchor?
  const primaryInsideAnchor = primaryCluster.structures.filter(s => distance3D(anchorPos, s) <= ANCHOR_RADIUS);
  const coverage = primaryCluster.structures.length > 0
    ? primaryInsideAnchor.length / primaryCluster.structures.length
    : 0;

  // 4. Weighted value of structures inside anchor
  let totalWeightedValue = 0;
  const structureList = [];
  const typeCounts = {};

  for (const s of insideAnchor) {
    const weight = getWeight(s.type);
    if (weight <= 0) continue; // ignore zero-weight spam
    totalWeightedValue += weight;
    structureList.push({
      id: s.id,
      type: s.type,
      weight,
      x: s.x || 0, y: s.y || 0, z: s.z || 0,
    });
    typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
  }

  // 5. Check critical structures
  let hasCritical = false;
  const missingCritical = [];
  for (const t of CRITICAL_TYPES) {
    if ((typeCounts[t] || 0) > 0) { hasCritical = true; }
    else { missingCritical.push(t); }
  }

  // 6. Collect ALL validation failures (don't short-circuit)
  if (structureList.length < MIN_STRUCTURE_COUNT) {
    reasons.push(`Insufficient structures: ${structureList.length}/${MIN_STRUCTURE_COUNT}`);
  }
  if (totalWeightedValue < MIN_BASE_VALUE) {
    reasons.push(`Insufficient base value: ${totalWeightedValue}/${MIN_BASE_VALUE}`);
  }
  if (!hasCritical) {
    reasons.push(`Missing critical structures (need generator, turret, or bed). Missing: ${missingCritical.join(', ')}`);
  }
  if (coverage < CLUSTER_COVERAGE_REQUIRED) {
    reasons.push(`Low cluster coverage: ${(coverage * 100).toFixed(0)}%/${(CLUSTER_COVERAGE_REQUIRED * 100).toFixed(0)}% required`);
  }

  if (reasons.length > 0) {
    return { valid: false, snapshot: null, reason: reasons[0], reasons };
  }

  const snapshot = {
    structures: structureList,
    structureCount: structureList.length,
    totalWeightedValue,
    coverage: Math.round(coverage * 100),
    typeCounts,
    createdAt: now(),
    destroyedValue: 0,
    destroyedIds: new Set(),
  };

  return { valid: true, snapshot, reason: 'ok', reasons: [] };
}

// ─── Anchor Registration ───

/**
 * Register a Tek Forcefield as a tribe's anchor.
 * Called when a forcefield is placed.
 */
function registerAnchor(tribeId, anchorId, position, tribeStructures) {
  if (!tribeId || !anchorId) return { success: false, reason: 'missing_ids', reasons: ['Missing tribe or anchor ID'] };

  // Anti-spam: check placement frequency
  const history = _anchorPlacementHistory.get(tribeId) || [];
  const cutoff = now() - ANCHOR_SPAM_WINDOW_MS;
  const recentPlacements = history.filter(ts => ts > cutoff);
  if (recentPlacements.length >= ANCHOR_SPAM_MAX) {
    _ctx.log(`[raidZones] anchor placement SPAM blocked for tribe ${tribeId} (${recentPlacements.length} in ${ANCHOR_SPAM_WINDOW_MS / 60000}m)`, 'warn');
    return { success: false, reason: 'spam_blocked', reasons: [`Too many anchor placements (${recentPlacements.length}/${ANCHOR_SPAM_MAX} in ${ANCHOR_SPAM_WINDOW_MS / 60000}m)`] };
  }

  // Cooldown check
  const lastRemoved = _anchorCooldowns.get(tribeId);
  if (lastRemoved && (now() - lastRemoved) < ANCHOR_PLACEMENT_COOLDOWN_MS) {
    const remaining = Math.ceil((ANCHOR_PLACEMENT_COOLDOWN_MS - (now() - lastRemoved)) / 60000);
    _ctx.log(`[raidZones] anchor placement on cooldown for tribe ${tribeId} (${remaining}m remaining)`, 'warn');
    return { success: false, reason: `cooldown_${remaining}m`, reasons: [`Anchor on cooldown: ${remaining} minutes remaining`] };
  }

  // Check for active raid — block replacement during raid
  const existing = _anchors.get(tribeId);
  if (existing && existing.raidSession && existing.raidSession.active) {
    _ctx.log(`[raidZones] anchor replacement BLOCKED during active raid for tribe ${tribeId}`, 'warn');
    return { success: false, reason: 'raid_active', reasons: ['Cannot place anchor during an active raid'] };
  }

  // Build and validate snapshot
  const result = buildAndValidateSnapshot(position, tribeStructures);

  const anchorData = {
    anchorId,
    position,
    registeredAt: now(),
    valid: result.valid,
    snapshot: result.snapshot,
    validationReasons: result.reasons || [],
    raidSession: null,
    whiteFlag: existing ? existing.whiteFlag : null,
  };

  _anchors.set(tribeId, anchorData);

  // Track placement for spam detection
  recentPlacements.push(now());
  _anchorPlacementHistory.set(tribeId, recentPlacements);

  if (result.valid) {
    _ctx.log(`[raidZones] anchor registered for tribe ${tribeId} — value: ${result.snapshot.totalWeightedValue}, structures: ${result.snapshot.structureCount}, coverage: ${result.snapshot.coverage}%`, 'info');
    _ctx.events.emit('raidZone:anchorRegistered', `Anchor registered for tribe ${tribeId}`, { tribeId, value: result.snapshot.totalWeightedValue });
  } else {
    _ctx.log(`[raidZones] invalid base marker placement — ${result.reasons.join('; ')}`, 'warn');
  }

  return { success: result.valid, reason: result.reason, reasons: result.reasons, value: result.snapshot?.totalWeightedValue || 0 };
}

/**
 * Remove a tribe's anchor (forcefield destroyed or picked up).
 */
function removeAnchor(tribeId) {
  const existing = _anchors.get(tribeId);
  if (!existing) return;

  // Don't remove snapshot if raid is active — anchor destruction doesn't reset raid
  if (existing.raidSession && existing.raidSession.active) {
    existing.anchorId = null; // mark anchor as destroyed but keep session
    _ctx.log(`[raidZones] anchor destroyed during active raid for tribe ${tribeId} — raid continues`, 'info');
    return;
  }

  _anchorCooldowns.set(tribeId, now());
  _anchors.delete(tribeId);
  _ctx.log(`[raidZones] anchor removed for tribe ${tribeId} — 30min cooldown started`, 'info');
}

// ─── Raid Protection Check ───

/**
 * Check if a tribe has valid raid protection.
 * Returns { protected, reason }
 */
function hasProtection(tribeId) {
  const anchor = _anchors.get(tribeId);

  if (!anchor) return { protected: false, reason: 'no_anchor' };
  if (!anchor.valid) return { protected: false, reason: 'invalid_anchor' };

  // White flag active = protected (cannot take or deal damage)
  if (anchor.whiteFlag && anchor.whiteFlag.active && now() < anchor.whiteFlag.expiresAt) {
    return { protected: true, reason: 'white_flag' };
  }

  return { protected: true, reason: 'valid_anchor' };
}

/**
 * Check if a tribe is under white flag (cannot deal damage either).
 */
function hasWhiteFlag(tribeId) {
  const anchor = _anchors.get(tribeId);
  if (!anchor || !anchor.whiteFlag) return false;
  if (!anchor.whiteFlag.active) return false;
  if (now() > anchor.whiteFlag.expiresAt) {
    anchor.whiteFlag.active = false;
    return false;
  }
  return true;
}

// ─── Raid Zone Damage Gate ───

/**
 * Evaluate whether damage should be allowed based on raid zones.
 * This runs BEFORE bracket checks.
 * @returns {{ allowed, reason, raidStarted }}
 */
function evaluateZoneDamage(attackerTribeId, defenderTribeId, structureId, structureType) {
  // Same tribe → always allow
  if (attackerTribeId === defenderTribeId) {
    return { allowed: true, reason: 'same_tribe' };
  }

  // White flag on attacker → cannot deal damage
  if (hasWhiteFlag(attackerTribeId)) {
    return { allowed: false, reason: 'attacker_white_flag' };
  }

  // White flag on defender → cannot take damage
  if (hasWhiteFlag(defenderTribeId)) {
    return { allowed: false, reason: 'defender_white_flag' };
  }

  // Check defender protection
  const defenderProtection = hasProtection(defenderTribeId);
  if (!defenderProtection.protected) {
    // No valid anchor = no protection, anyone can raid
    return { allowed: true, reason: 'no_protection' };
  }

  // Defender has valid anchor — check if this is inside the anchor zone
  const defenderAnchor = _anchors.get(defenderTribeId);
  if (!defenderAnchor || !defenderAnchor.snapshot) {
    return { allowed: true, reason: 'no_snapshot' };
  }

  // If raid session is active, track destruction
  if (defenderAnchor.raidSession && defenderAnchor.raidSession.active) {
    trackDestruction(defenderTribeId, structureId, structureType);
    return { allowed: true, reason: 'raid_active' };
  }

  // If structure is inside snapshot → start a raid session
  const inSnapshot = defenderAnchor.snapshot.structures.some(s => s.id === structureId);
  if (inSnapshot) {
    startRaidSession(attackerTribeId, defenderTribeId);
    trackDestruction(defenderTribeId, structureId, structureType);
    return { allowed: true, reason: 'raid_started', raidStarted: true };
  }

  // Structure not in snapshot — still allow (outpost or new build)
  return { allowed: true, reason: 'outside_snapshot' };
}

// ─── Raid Sessions ───

function startRaidSession(attackerTribeId, defenderTribeId) {
  const anchor = _anchors.get(defenderTribeId);
  if (!anchor || !anchor.snapshot) return;
  if (anchor.raidSession && anchor.raidSession.active) return; // already active

  anchor.raidSession = {
    active: true,
    attackerTribeId,
    defenderTribeId,
    startedAt: now(),
    lastActivityAt: now(),
    snapshotLocked: true,
  };

  _ctx.log(`[raidZones] raid started: ${attackerTribeId} → ${defenderTribeId}`, 'info');

  // Emit event — trenchesRaid handles discord and stats
  _ctx.events.emit('raid:zone_started', `Raid started: ${attackerTribeId} → ${defenderTribeId}`, {
    attackerTribeId, defenderTribeId, baseValue: anchor.snapshot.totalWeightedValue,
  });
}

function trackDestruction(defenderTribeId, structureId, structureType) {
  const anchor = _anchors.get(defenderTribeId);
  if (!anchor || !anchor.snapshot || !anchor.raidSession) return;

  // Only count snapshot structures
  if (anchor.snapshot.destroyedIds.has(structureId)) return; // already counted

  const snapshotEntry = anchor.snapshot.structures.find(s => s.id === structureId);
  if (!snapshotEntry) return; // not in snapshot — ignore

  anchor.snapshot.destroyedIds.add(structureId);
  anchor.snapshot.destroyedValue += snapshotEntry.weight;
  anchor.raidSession.lastActivityAt = now();

  const percent = anchor.snapshot.destroyedValue / anchor.snapshot.totalWeightedValue;
  _ctx.log(`[raidZones] destruction updated for tribe ${defenderTribeId}: ${(percent * 100).toFixed(1)}%`, 'info');

  // Check attacker win
  if (percent >= ATTACKER_WIN_THRESHOLD) {
    resolveRaid(defenderTribeId, 'attacker_win');
  }
}

function resolveRaid(defenderTribeId, outcome) {
  const anchor = _anchors.get(defenderTribeId);
  if (!anchor || !anchor.raidSession) return;

  const session = anchor.raidSession;
  session.active = false;

  const attackerTribeId = session.attackerTribeId;
  const percent = anchor.snapshot
    ? ((anchor.snapshot.destroyedValue / anchor.snapshot.totalWeightedValue) * 100).toFixed(1)
    : '0';

  _ctx.log(`[raidZones] raid resolved: ${outcome} (attacker: ${attackerTribeId}, defender: ${defenderTribeId}, destroyed: ${percent}%)`, 'info');

  // Emit event — trenchesRaid handles XP, stats, discord, white flag
  _ctx.events.emit('raid:zone_resolved', `Raid resolved: ${outcome}`, {
    outcome, attackerTribeId, defenderTribeId, percentDestroyed: percent,
  });

  // Clear snapshot for fresh state after raid
  if (anchor.snapshot) {
    anchor.snapshot.destroyedIds.clear();
    anchor.snapshot.destroyedValue = 0;
  }
  anchor.raidSession = null;
}

// ─── White Flag ───

function activateWhiteFlag(tribeId) {
  let anchor = _anchors.get(tribeId);
  if (!anchor) {
    anchor = { anchorId: null, position: null, registeredAt: 0, valid: false, snapshot: null, raidSession: null, whiteFlag: null };
    _anchors.set(tribeId, anchor);
  }

  anchor.whiteFlag = {
    active: true,
    activatedAt: now(),
    expiresAt: now() + WHITE_FLAG_DURATION_MS,
  };

  _ctx.log(`[raidZones] white flag activated for tribe ${tribeId} (5 days)`, 'info');
  _ctx.events.emit('raid:white_flag', `White flag activated for tribe ${tribeId}`, { tribeId, active: true });
}

/**
 * /nwf command — disable white flag early.
 */
function disableWhiteFlag(tribeId) {
  const anchor = _anchors.get(tribeId);
  if (!anchor || !anchor.whiteFlag || !anchor.whiteFlag.active) {
    return { success: false, reason: 'no_active_white_flag' };
  }

  anchor.whiteFlag.active = false;
  _ctx.log(`[raidZones] white flag disabled early for tribe ${tribeId}`, 'info');
  _ctx.events.emit('raid:white_flag', `White flag disabled for tribe ${tribeId}`, { tribeId, active: false });
  return { success: true };
}

// ─── Forfeit Check (periodic) ───

function checkForfeitedRaids() {
  const timestamp = now();
  for (const [tribeId, anchor] of _anchors) {
    if (!anchor.raidSession || !anchor.raidSession.active) continue;
    const inactivity = timestamp - anchor.raidSession.lastActivityAt;
    if (inactivity >= RAID_FORFEIT_MS) {
      _ctx.log(`[raidZones] raid forfeited by attacker (no activity for 2h) — defender: ${tribeId}`, 'info');
      resolveRaid(tribeId, 'defender_win');
    }
  }
}

// (XP, Discord, and white flag actions removed — trenchesRaid handles all outcomes via events)

// ─── Chat Commands ───

function handleZoneChat(playerId, playerName, message, serverName) {
  const cmd = (message || '').trim().toLowerCase();

  if (cmd === '/nwf') {
    return handleNwfCommand(playerId, playerName, serverName);
  }
  if (cmd === '/anchor') {
    return handleAnchorCommand(playerId, playerName, serverName);
  }
  if (cmd === '/raidzone') {
    return handleRaidZoneCommand(playerId, playerName, serverName);
  }
  return false;
}

function findPlayerTribe(playerId) {
  if (!_ctx || !_ctx.features || !_ctx.features.trenchesRaid) return null;
  const raid = _ctx.features.trenchesRaid;
  const status = raid.getRaidStatus();
  if (!status || !status.tribes) return null;
  // Check trenchesRaid tribe membership
  for (const t of status.tribes) {
    const data = raid.getTribeData(t.tribeId);
    if (data && data.members && data.members.has(playerId)) return t.tribeId;
  }
  return null;
}

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
    _ctx.log(`[raidZones] chat send error: ${e.message}`, 'warn');
  }
  return false;
}

function handleNwfCommand(playerId, playerName, serverName) {
  const tribeId = findPlayerTribe(playerId);
  if (!tribeId) {
    sendChat(serverName, `[Raid] ${playerName}: No tribe data found.`);
    return true;
  }
  const result = disableWhiteFlag(tribeId);
  if (result.success) {
    sendChat(serverName, `[Raid] ${playerName}: White flag DISABLED. You can now be raided.`);
  } else {
    sendChat(serverName, `[Raid] ${playerName}: No active white flag to disable.`);
  }
  return true;
}

function handleAnchorCommand(playerId, playerName, serverName) {
  const tribeId = findPlayerTribe(playerId);
  if (!tribeId) {
    sendChat(serverName, `[Raid] ${playerName}: No tribe data found.`);
    return true;
  }

  const anchor = _anchors.get(tribeId);
  if (!anchor) {
    sendChat(serverName, `[Raid] ${playerName}: No anchor placed. Place a Tek Forcefield to protect your base.`);
    return true;
  }

  if (!anchor.valid) {
    sendChat(serverName, `[Raid] ${playerName}: Anchor INVALID — base requirements not met.`);
    // Show detailed reasons
    if (anchor.validationReasons && anchor.validationReasons.length > 0) {
      for (const reason of anchor.validationReasons) {
        sendChat(serverName, `[Raid] ❌ ${reason}`);
      }
    }
    return true;
  }

  const snap = anchor.snapshot;
  sendChat(serverName, `[Raid] ${playerName}: Anchor VALID ✅ — Value: ${snap.totalWeightedValue}, Structures: ${snap.structureCount}, Coverage: ${snap.coverage}%`);

  if (anchor.raidSession && anchor.raidSession.active) {
    const percent = ((snap.destroyedValue / snap.totalWeightedValue) * 100).toFixed(1);
    sendChat(serverName, `[Raid] ⚔️ ACTIVE RAID — ${percent}% destroyed by tribe ${anchor.raidSession.attackerTribeId}`);
  }

  if (anchor.whiteFlag && anchor.whiteFlag.active && now() < anchor.whiteFlag.expiresAt) {
    const remaining = Math.ceil((anchor.whiteFlag.expiresAt - now()) / 3600000);
    sendChat(serverName, `[Raid] 🏳️ WHITE FLAG active (${remaining}h remaining). Use /nwf to disable.`);
  }

  return true;
}

function handleRaidZoneCommand(playerId, playerName, serverName) {
  const tribeId = findPlayerTribe(playerId);
  if (!tribeId) {
    sendChat(serverName, `[Raid] ${playerName}: No tribe data found.`);
    return true;
  }

  const prot = hasProtection(tribeId);
  if (prot.protected) {
    sendChat(serverName, `[Raid] ${playerName}: Your base is PROTECTED (${prot.reason}).`);
  } else {
    sendChat(serverName, `[Raid] ${playerName}: Your base is UNPROTECTED (${prot.reason}). Anyone can raid you!`);
  }
  return true;
}

// ─── Data Access ───

function getAnchorStatus(tribeId) {
  const anchor = _anchors.get(tribeId);
  if (!anchor) return { hasAnchor: false, valid: false, protected: false };

  const prot = hasProtection(tribeId);
  const result = {
    hasAnchor: true,
    valid: anchor.valid,
    protected: prot.protected,
    protectionReason: prot.reason,
  };

  if (anchor.snapshot) {
    result.baseValue = anchor.snapshot.totalWeightedValue;
    result.structureCount = anchor.snapshot.structureCount;
    result.coverage = anchor.snapshot.coverage;
  }

  if (anchor.raidSession && anchor.raidSession.active) {
    result.activeRaid = {
      attackerTribeId: anchor.raidSession.attackerTribeId,
      startedAt: anchor.raidSession.startedAt,
      percentDestroyed: anchor.snapshot
        ? ((anchor.snapshot.destroyedValue / anchor.snapshot.totalWeightedValue) * 100).toFixed(1)
        : '0',
    };
  }

  if (anchor.whiteFlag && anchor.whiteFlag.active && now() < anchor.whiteFlag.expiresAt) {
    result.whiteFlag = {
      active: true,
      expiresAt: anchor.whiteFlag.expiresAt,
      remainingMs: anchor.whiteFlag.expiresAt - now(),
    };
  }

  return result;
}

function getAllZoneStatus() {
  const zones = [];
  for (const [tribeId, anchor] of _anchors) {
    zones.push({ tribeId, ...getAnchorStatus(tribeId) });
  }
  return { totalAnchors: zones.length, zones };
}

// ─── DB Persistence ───

function persistZoneData() {
  if (!_ctx) return;
  try {
    _ctx.db.run(`
      CREATE TABLE IF NOT EXISTS raid_zones (
        tribe_id TEXT PRIMARY KEY,
        anchor_id TEXT,
        position TEXT DEFAULT '{}',
        valid INTEGER DEFAULT 0,
        snapshot TEXT DEFAULT '{}',
        raid_session TEXT,
        white_flag TEXT,
        registered_at INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    for (const [tribeId, data] of _anchors) {
      const snapshot = data.snapshot ? {
        ...data.snapshot,
        destroyedIds: [...(data.snapshot.destroyedIds || [])],
      } : null;

      _ctx.db.run(`
        INSERT INTO raid_zones (tribe_id, anchor_id, position, valid, snapshot, raid_session, white_flag, registered_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(tribe_id) DO UPDATE SET
          anchor_id = excluded.anchor_id,
          position = excluded.position,
          valid = excluded.valid,
          snapshot = excluded.snapshot,
          raid_session = excluded.raid_session,
          white_flag = excluded.white_flag,
          registered_at = excluded.registered_at,
          updated_at = datetime('now')
      `,
        tribeId,
        data.anchorId || null,
        JSON.stringify(data.position || {}),
        data.valid ? 1 : 0,
        JSON.stringify(snapshot),
        data.raidSession ? JSON.stringify(data.raidSession) : null,
        data.whiteFlag ? JSON.stringify(data.whiteFlag) : null,
        data.registeredAt || 0
      );
    }
  } catch (err) {
    _ctx.log(`[raidZones] persist error: ${err.message}`, 'error');
  }
}

function loadZoneData() {
  if (!_ctx) return;
  try {
    _ctx.db.run(`
      CREATE TABLE IF NOT EXISTS raid_zones (
        tribe_id TEXT PRIMARY KEY,
        anchor_id TEXT,
        position TEXT DEFAULT '{}',
        valid INTEGER DEFAULT 0,
        snapshot TEXT DEFAULT '{}',
        raid_session TEXT,
        white_flag TEXT,
        registered_at INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    const rows = _ctx.db.query('SELECT * FROM raid_zones');
    for (const row of rows) {
      let position, snapshot, raidSession, whiteFlag;
      try { position = JSON.parse(row.position || '{}'); } catch { position = {}; }
      try {
        snapshot = JSON.parse(row.snapshot || '{}');
        if (snapshot && snapshot.destroyedIds) {
          snapshot.destroyedIds = new Set(snapshot.destroyedIds);
        } else if (snapshot) {
          snapshot.destroyedIds = new Set();
        }
      } catch { snapshot = null; }
      try { raidSession = row.raid_session ? JSON.parse(row.raid_session) : null; } catch { raidSession = null; }
      try { whiteFlag = row.white_flag ? JSON.parse(row.white_flag) : null; } catch { whiteFlag = null; }

      _anchors.set(row.tribe_id, {
        anchorId: row.anchor_id,
        position,
        registeredAt: row.registered_at || 0,
        valid: row.valid === 1,
        snapshot,
        raidSession,
        whiteFlag,
      });
    }

    _ctx.log(`[raidZones] loaded ${_anchors.size} zone records from DB`, 'info');
  } catch (err) {
    _ctx.log(`[raidZones] load error: ${err.message}`, 'error');
  }
}

// ─── Anchor Health Monitoring ───

/**
 * Periodically re-validate all anchors.
 * If a valid anchor becomes invalid (e.g. structures destroyed outside raid),
 * mark it invalid and warn the tribe via chat.
 */
function checkAnchorHealth() {
  for (const [tribeId, anchor] of _anchors) {
    if (!anchor.valid || !anchor.position) continue;
    // Skip if raid is active — don't invalidate mid-raid
    if (anchor.raidSession && anchor.raidSession.active) continue;

    try {
      // Re-fetch tribe structures from game state
      const tribeStructures = getTribeStructuresFromGame(tribeId);
      if (!tribeStructures || tribeStructures.length === 0) continue;

      const result = buildAndValidateSnapshot(anchor.position, tribeStructures);
      if (!result.valid && anchor.valid) {
        // Was valid, now invalid — warn
        anchor.valid = false;
        anchor.validationReasons = result.reasons || [];
        anchor.snapshot = null;
        _ctx.log(`[raidZones] anchor INVALIDATED for tribe ${tribeId}: ${result.reasons.join('; ')}`, 'warn');

        // Send warning to all servers
        try {
          const servers = _ctx.servers ? _ctx.servers.list() : [];
          for (const srv of servers) {
            if (srv.status === 'running') {
              sendChat(srv.name, `⚠️ [RAID] Tribe ${tribeId}: Your base anchor is no longer valid!`);
              for (const reason of result.reasons) {
                sendChat(srv.name, `[Raid] ❌ ${reason}`);
              }
            }
          }
        } catch (chatErr) {
          _ctx.log(`[raidZones] health warning chat error: ${chatErr.message}`, 'warn');
        }

        _ctx.events.emit('raidZone:anchorInvalidated', `Anchor invalidated for tribe ${tribeId}`, { tribeId, reasons: result.reasons });
      } else if (result.valid && !anchor.valid) {
        // Was invalid, now valid — auto-restore
        anchor.valid = true;
        anchor.snapshot = result.snapshot;
        anchor.validationReasons = [];
        _ctx.log(`[raidZones] anchor auto-restored for tribe ${tribeId}`, 'info');
      }
    } catch (err) {
      _ctx.log(`[raidZones] health check error for tribe ${tribeId}: ${err.message}`, 'warn');
    }
  }
}

/**
 * Get tribe structures from game state — wrapper for runtime API.
 * Returns null if unavailable (graceful degradation).
 */
function getTribeStructuresFromGame(tribeId) {
  try {
    if (_ctx && _ctx.runtime && typeof _ctx.runtime.getTribeStructures === 'function') {
      return _ctx.runtime.getTribeStructures(tribeId);
    }
  } catch (err) {
    _ctx.log(`[raidZones] getTribeStructures error: ${err.message}`, 'debug');
  }
  return null;
}

// ─── Periodic Tasks ───

let _persistInterval = null;
let _forfeitInterval = null;
let _healthInterval = null;

function startPeriodicTasks() {
  _persistInterval = setInterval(() => { persistZoneData(); }, 60000);
  _forfeitInterval = setInterval(() => { checkForfeitedRaids(); }, 60000);
  _healthInterval = setInterval(() => { checkAnchorHealth(); }, ANCHOR_HEALTH_CHECK_MS);
}

function stopPeriodicTasks() {
  if (_persistInterval) { clearInterval(_persistInterval); _persistInterval = null; }
  if (_forfeitInterval) { clearInterval(_forfeitInterval); _forfeitInterval = null; }
  if (_healthInterval) { clearInterval(_healthInterval); _healthInterval = null; }
}

// ─── Memory Safety ───

function enforceMemoryCaps() {
  if (_anchors.size > MEMORY_CAP) {
    const entries = [..._anchors.entries()]
      .filter(([, a]) => !a.raidSession || !a.raidSession.active)
      .sort((a, b) => (a[1].registeredAt || 0) - (b[1].registeredAt || 0));
    const toRemove = entries.slice(0, _anchors.size - MEMORY_CAP);
    for (const [key] of toRemove) _anchors.delete(key);
  }
  if (_anchorCooldowns.size > MEMORY_CAP) {
    const cutoff = now() - ANCHOR_PLACEMENT_COOLDOWN_MS;
    for (const [key, ts] of _anchorCooldowns) {
      if (ts < cutoff) _anchorCooldowns.delete(key);
    }
  }
  // Clean spam history
  if (_anchorPlacementHistory.size > MEMORY_CAP) {
    const cutoff = now() - ANCHOR_SPAM_WINDOW_MS;
    for (const [key, history] of _anchorPlacementHistory) {
      const recent = history.filter(ts => ts > cutoff);
      if (recent.length === 0) _anchorPlacementHistory.delete(key);
      else _anchorPlacementHistory.set(key, recent);
    }
  }
}

// ─── Lifecycle ───

async function init(ctx) {
  _ctx = ctx;
  loadZoneData();
  startPeriodicTasks();
  _ctx.log('[raidZones] initialized', 'info');
}

async function postInit() {
  // Nothing needed — dependencies resolved by loader
}

async function shutdown() {
  stopPeriodicTasks();
  persistZoneData();
  _anchors.clear();
  _anchorCooldowns.clear();
  _anchorPlacementHistory.clear();
  _ctx = null;
}

// ─── Exports ───

module.exports = {
  name,
  core,
  requires,
  init,
  postInit,
  shutdown,
  // Anchor management
  registerAnchor,
  removeAnchor,
  // Damage gate
  evaluateZoneDamage,
  // Protection checks
  hasProtection,
  hasWhiteFlag,
  // White flag
  activateWhiteFlag,
  disableWhiteFlag,
  // Chat commands
  handleZoneChat,
  // Data access
  getAnchorStatus,
  getAllZoneStatus,
  // Constants (for external reference)
  ANCHOR_RADIUS,
  STRUCTURE_WEIGHTS,
  MIN_BASE_VALUE,
  MIN_STRUCTURE_COUNT,
};
