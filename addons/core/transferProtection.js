/**
 * Feature: Transfer Protection + Anti-Dupe Risk Scoring
 * Extracted from agent v50.0 — behavior-identical.
 * v60.0: Unified feature system — uses structured ctx namespaces.
 * 
 * Snapshot-based inventory comparison on transfer/join events.
 * In-memory only, persists only on anomaly detection.
 */
'use strict';

const name = 'transferProtection';
const core = true;

// ─── State ───
const _transferSnapshots = new Map(); // playerId -> { items, hash, timestamp, serverId, serverName }
const TRANSFER_BUFFER_MS = 5000;
const TRANSFER_SNAPSHOT_TTL_MS = 300000; // 5 min
const RISK_ALERT_THRESHOLD = 10;

// Important item categories to track
const TRACKED_ITEM_PATTERNS = [
  /weapon|rifle|shotgun|pistol|longneck|fabricated|pump/i,
  /armor|flak|riot|tek.*(?:helm|chest|gaunt|leg|boot)/i,
  /blueprint|bp/i,
  /c4|rocket|grenade|explosive|det.*charge/i,
  /element|dust|shard/i,
];

// ─── Context ref ───
let _ctx = null;

function isTrackedItem(itemName) {
  if (!itemName) return false;
  return TRACKED_ITEM_PATTERNS.some(p => p.test(itemName));
}

function hashItems(items) {
  if (!items || items.length === 0) return 'empty';
  return items.map(i => `${i.name}:${i.qty}`).sort().join('|');
}

function captureTransferSnapshot(playerId, playerName, serverId, serverName, items) {
  if (!_ctx.settings.isEnabled('transfer_protection')) return;
  const tracked = (items || []).filter(i => isTrackedItem(i.name || i.item_name));
  _transferSnapshots.set(playerId, {
    items: tracked,
    hash: hashItems(tracked),
    timestamp: Date.now(),
    serverId, serverName, playerName,
  });
  _ctx.log(`[TransferProtection] Snapshot captured for ${playerName} (${tracked.length} tracked items)`, 'info');
}

async function compareTransferSnapshot(playerId, playerName, serverId, serverName, currentItems) {
  if (!_ctx.settings.isEnabled('transfer_protection')) return null;
  const snapshot = _transferSnapshots.get(playerId);
  if (!snapshot) return null;

  const tracked = (currentItems || []).filter(i => isTrackedItem(i.name || i.item_name));
  const currentHash = hashItems(tracked);

  // Fast path: no change
  if (snapshot.hash === currentHash) {
    _transferSnapshots.delete(playerId);
    return null;
  }

  // Detailed diff
  const beforeMap = new Map(snapshot.items.map(i => [i.name, i.qty || 1]));
  const afterMap = new Map(tracked.map(i => [i.name, i.qty || 1]));
  const lost = [];
  const gained = [];

  for (const [name, qty] of beforeMap) {
    const afterQty = afterMap.get(name) || 0;
    if (afterQty < qty) lost.push({ name, before: qty, after: afterQty, diff: qty - afterQty });
  }
  for (const [name, qty] of afterMap) {
    const beforeQty = beforeMap.get(name) || 0;
    if (qty > beforeQty) gained.push({ name, before: beforeQty, after: qty, diff: qty - beforeQty });
  }

  if (lost.length === 0 && gained.length === 0) {
    _transferSnapshots.delete(playerId);
    return null;
  }

  const diff = { lost, gained };

  // Persist anomaly
  try {
    _ctx.db.run(
      `INSERT INTO transfer_logs (player_id, player_name, server_id, server_name, event_type, items_before, items_after, diff, risk_score)
       VALUES (?, ?, ?, ?, 'transfer_anomaly', ?, ?, ?, ?)`,
      playerId, playerName, serverId, serverName,
      JSON.stringify(snapshot.items), JSON.stringify(tracked), JSON.stringify(diff),
      lost.length * 2 + gained.length * 3
    );
  } catch (e) { _ctx.log('[TransferProtection] DB write failed: ' + e.message, 'warn'); }

  // Update anti-dupe risk
  if (_ctx.settings.isEnabled('anti_dupe')) {
    for (const g of gained) {
      const points = g.diff > 5 ? 5 : 3;
      updatePlayerRisk(playerId, playerName, points, 'item_gain');
    }
    for (const l of lost) {
      updatePlayerRisk(playerId, playerName, 2, 'item_loss');
    }
  }

  _ctx.events.emit('system:decision', `Transfer anomaly detected for ${playerName}: ${lost.length} items lost, ${gained.length} items gained`, {
    level: 'warning', serverName, serverId,
  });

  _transferSnapshots.delete(playerId);
  return diff;
}

// Cleanup stale snapshots every 5 min
function cleanTransferSnapshots() {
  const now = Date.now();
  for (const [pid, snap] of _transferSnapshots) {
    if (now - snap.timestamp > TRANSFER_SNAPSHOT_TTL_MS) _transferSnapshots.delete(pid);
  }
}

// ─── Anti-Dupe Risk Scoring ───

function updatePlayerRisk(playerId, playerName, points, eventType) {
  if (!_ctx.settings.isEnabled('anti_dupe')) return;
  try {
    const existing = _ctx.db.get('SELECT score, flags FROM player_risk WHERE player_id = ?', playerId);
    const newScore = (existing ? existing.score : 0) + points;
    const newFlags = (existing ? existing.flags : 0) + (newScore >= RISK_ALERT_THRESHOLD && (!existing || existing.score < RISK_ALERT_THRESHOLD) ? 1 : 0);
    _ctx.db.run(
      `INSERT OR REPLACE INTO player_risk (player_id, player_name, score, flags, last_event, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      playerId, playerName, newScore, newFlags, eventType
    );

    if (newScore >= RISK_ALERT_THRESHOLD && (!existing || existing.score < RISK_ALERT_THRESHOLD)) {
      _ctx.events.emit('system:decision', `Anti-dupe alert: Player ${playerName} risk score reached ${newScore} (threshold: ${RISK_ALERT_THRESHOLD}). Event: ${eventType}`, {
        level: 'error',
      });
      _ctx.log(`[AntiDupe] ALERT: ${playerName} risk=${newScore} event=${eventType}`, 'error');
    }
  } catch (e) { _ctx.log('[AntiDupe] Risk update failed: ' + e.message, 'warn'); }
}

function getPlayerRisk(playerId) {
  try {
    return _ctx.db.get('SELECT * FROM player_risk WHERE player_id = ?', playerId) || null;
  } catch { return null; }
}

function getHighRiskPlayers(limit = 20) {
  try {
    return _ctx.db.query('SELECT * FROM player_risk WHERE score >= ? ORDER BY score DESC LIMIT ?', RISK_ALERT_THRESHOLD, limit);
  } catch { return []; }
}

// Risk decay: reduce scores by 1 every 30 minutes
function decayPlayerRisk() {
  try {
    _ctx.db.run(`UPDATE player_risk SET score = MAX(0, score - 1), updated_at = datetime('now') WHERE score > 0`);
  } catch {}
}

// ─── Init ───

function init(ctx) {
  _ctx = ctx;
  _ctx.log('[TransferProtection] Feature initialized', 'info');
}

function shutdown() {
  _transferSnapshots.clear();
}

module.exports = {
  name,
  core,
  init,
  shutdown,
  // Exposed API for agent bridge calls
  captureTransferSnapshot,
  compareTransferSnapshot,
  cleanTransferSnapshots,
  updatePlayerRisk,
  getPlayerRisk,
  getHighRiskPlayers,
  decayPlayerRisk,
  getSnapshotCount: () => _transferSnapshots.size,
};
