/**
 * Feature: playerStats — Buffered stats tracking for players & tribes
 *
 * Anti-exploit, non-blocking, flush-safe stat tracking.
 * Buffers deltas in memory and flushes to Supabase every 10s.
 *
 * Dependencies: none (trenchesRaid integration is optional)
 */
'use strict';

const name = 'playerStats';
const core = false;
const requires = [];

// ─── State ───
let _ctx = null;
let _flushTimer = null;
let _countTimer = null;

const FLUSH_INTERVAL_MS = 10000; // 10s

// Anti-exploit constants
const PAIR_COOLDOWN_MS = 60 * 1000;       // 60s between same killer→victim
const SAME_TRIBE_IGNORE = true;            // ignore same-tribe kills entirely

// Cooldown tracker: "killerEos:victimEos" → lastTimestamp
const _pairCooldowns = new Map();

// Buffers: keyed by eos_id / tribe_id — values are DELTAS since last flush
const _playerBuf = new Map();
const _tribeBuf = new Map();

// ─── Buffer Helpers ───

function getPlayer(eosId) {
  if (!_playerBuf.has(eosId)) {
    _playerBuf.set(eosId, {
      kills: 0, deaths: 0, dino_kills: 0, structures_destroyed: 0,
      player_name: '', tribe_id: null,
    });
  }
  return _playerBuf.get(eosId);
}

function getTribe(tribeId) {
  if (!_tribeBuf.has(tribeId)) {
    _tribeBuf.set(tribeId, {
      total_kills: 0, total_deaths: 0, total_dino_kills: 0, total_structures_destroyed: 0,
      tribe_name: '', xp: 0, level: 1, bracket: 'Bronze',
    });
  }
  return _tribeBuf.get(tribeId);
}

// ─── Anti-Exploit ───

function isPairOnCooldown(killerEosId, victimEosId) {
  if (!killerEosId || !victimEosId) return false;
  const key = `${killerEosId}:${victimEosId}`;
  const last = _pairCooldowns.get(key);
  const now = Date.now();
  if (last && (now - last) < PAIR_COOLDOWN_MS) return true;
  _pairCooldowns.set(key, now);
  return false;
}

function cleanPairCooldowns() {
  const cutoff = Date.now() - PAIR_COOLDOWN_MS * 2;
  for (const [key, ts] of _pairCooldowns) {
    if (ts < cutoff) _pairCooldowns.delete(key);
  }
}

// ─── Event Recording (non-blocking) ───

function recordKill(killerEosId, killerName, killerTribeId, victimEosId, victimName, victimTribeId) {
  try {
    // Anti-exploit: ignore same-tribe kills
    if (SAME_TRIBE_IGNORE && killerTribeId && victimTribeId && killerTribeId === victimTribeId) {
      return;
    }
    // Anti-exploit: pair cooldown
    if (isPairOnCooldown(killerEosId, victimEosId)) {
      if (_ctx) _ctx.log('[stats] kill ignored (pair cooldown)', 'debug');
      return;
    }

    // Update killer
    if (killerEosId) {
      const p = getPlayer(killerEosId);
      p.kills++;
      if (killerName) p.player_name = killerName;
      if (killerTribeId) p.tribe_id = killerTribeId;
    }
    if (killerTribeId) {
      getTribe(killerTribeId).total_kills++;
    }

    // Update victim (death)
    if (victimEosId) {
      const v = getPlayer(victimEosId);
      v.deaths++;
      if (victimName) v.player_name = victimName;
      if (victimTribeId) v.tribe_id = victimTribeId;
    }
    if (victimTribeId) {
      getTribe(victimTribeId).total_deaths++;
    }

    if (_ctx) _ctx.log('[stats] kill recorded', 'debug');
  } catch (err) {
    if (_ctx) _ctx.log(`[stats] recordKill error: ${err.message}`, 'warn');
  }
}

function recordDeath(victimEosId, victimName, victimTribeId) {
  try {
    if (victimEosId) {
      const v = getPlayer(victimEosId);
      v.deaths++;
      if (victimName) v.player_name = victimName;
      if (victimTribeId) v.tribe_id = victimTribeId;
    }
    if (victimTribeId) {
      getTribe(victimTribeId).total_deaths++;
    }
    if (_ctx) _ctx.log('[stats] death recorded', 'debug');
  } catch (err) {
    if (_ctx) _ctx.log(`[stats] recordDeath error: ${err.message}`, 'warn');
  }
}

function recordDinoKill(killerEosId, killerName, killerTribeId) {
  try {
    if (killerEosId) {
      const p = getPlayer(killerEosId);
      p.dino_kills++;
      if (killerName) p.player_name = killerName;
      if (killerTribeId) p.tribe_id = killerTribeId;
    }
    if (killerTribeId) {
      getTribe(killerTribeId).total_dino_kills++;
    }
    if (_ctx) _ctx.log('[stats] dino kill recorded', 'debug');
  } catch (err) {
    if (_ctx) _ctx.log(`[stats] recordDinoKill error: ${err.message}`, 'warn');
  }
}

function recordStructureDestroy(killerEosId, killerName, killerTribeId) {
  try {
    if (killerEosId) {
      const p = getPlayer(killerEosId);
      p.structures_destroyed++;
      if (killerName) p.player_name = killerName;
      if (killerTribeId) p.tribe_id = killerTribeId;
    }
    if (killerTribeId) {
      getTribe(killerTribeId).total_structures_destroyed++;
    }
    if (_ctx) _ctx.log('[stats] structure destroy recorded', 'debug');
  } catch (err) {
    if (_ctx) _ctx.log(`[stats] recordStructureDestroy error: ${err.message}`, 'warn');
  }
}

/**
 * Scaffold for future damage tracking.
 * Not fully implemented — records nothing yet.
 */
function recordDamage(attackerTribeId, defenderTribeId, amount) {
  // Future: track per-tribe damage dealt/received for raid contribution
  // and advanced leaderboards. No-op for now.
  void attackerTribeId; void defenderTribeId; void amount;
}

// ─── Raid Data Sync ───

function syncRaidData() {
  try {
    if (!_ctx || !_ctx.features || !_ctx.features.trenchesRaid) return;
    const raid = _ctx.features.trenchesRaid;
    const status = raid.getRaidStatus();
    if (!status || !status.tribes) return;

    for (const t of status.tribes) {
      const buf = getTribe(t.tribeId);
      buf.xp = t.xp;
      buf.level = t.level;
      buf.bracket = t.bracket;
      if (t.tribeName) buf.tribe_name = t.tribeName;
    }
  } catch (err) {
    if (_ctx) _ctx.log(`[stats] syncRaidData error: ${err.message}`, 'warn');
  }
}

// ─── Flush to Supabase ───

async function flush() {
  if (!_ctx) return;

  const playerCount = _playerBuf.size;
  const tribeCount = _tribeBuf.size;
  if (playerCount === 0 && tribeCount === 0) return;

  syncRaidData();

  const clusterId = _ctx.clusterId || null;
  if (!clusterId) return;

  // Snapshot and clear
  const players = new Map(_playerBuf);
  const tribes = new Map(_tribeBuf);
  _playerBuf.clear();
  _tribeBuf.clear();

  try {
    if (_ctx.supabase) {
      await flushPlayers(players, clusterId);
      await flushTribes(tribes, clusterId);
    }
    _ctx.log(`[stats] flush success — ${players.size} players, ${tribes.size} tribes`, 'info');
  } catch (err) {
    // Re-merge failed deltas back for retry (idempotent — additive deltas)
    for (const [k, v] of players) {
      const e = getPlayer(k);
      e.kills += v.kills; e.deaths += v.deaths;
      e.dino_kills += v.dino_kills; e.structures_destroyed += v.structures_destroyed;
      if (v.player_name) e.player_name = v.player_name;
      if (v.tribe_id) e.tribe_id = v.tribe_id;
    }
    for (const [k, v] of tribes) {
      const e = getTribe(k);
      e.total_kills += v.total_kills; e.total_deaths += v.total_deaths;
      e.total_dino_kills += v.total_dino_kills;
      e.total_structures_destroyed += v.total_structures_destroyed;
      if (v.xp) e.xp = v.xp;
      if (v.level) e.level = v.level;
      if (v.bracket) e.bracket = v.bracket;
    }
    _ctx.log(`[stats] flush retry queued: ${err.message}`, 'warn');
  }
}

async function flushPlayers(players, clusterId) {
  for (const [eosId, d] of players) {
    const { data: existing } = await _ctx.supabase
      .from('player_stats')
      .select('kills,deaths,dino_kills,structures_destroyed')
      .eq('cluster_id', clusterId)
      .eq('eos_id', eosId)
      .maybeSingle();

    const row = {
      cluster_id: clusterId,
      eos_id: eosId,
      player_name: d.player_name || '',
      tribe_id: d.tribe_id || null,
      kills: (existing?.kills || 0) + d.kills,
      deaths: (existing?.deaths || 0) + d.deaths,
      dino_kills: (existing?.dino_kills || 0) + d.dino_kills,
      structures_destroyed: (existing?.structures_destroyed || 0) + d.structures_destroyed,
      updated_at: new Date().toISOString(),
    };

    const { error } = await _ctx.supabase
      .from('player_stats')
      .upsert(row, { onConflict: 'cluster_id,eos_id' });

    if (error) throw new Error(`player upsert: ${error.message}`);
  }
}

async function flushTribes(tribes, clusterId) {
  for (const [tribeId, d] of tribes) {
    const { data: existing } = await _ctx.supabase
      .from('tribe_stats')
      .select('total_kills,total_deaths,total_dino_kills,total_structures_destroyed')
      .eq('cluster_id', clusterId)
      .eq('tribe_id', tribeId)
      .maybeSingle();

    const row = {
      cluster_id: clusterId,
      tribe_id: tribeId,
      tribe_name: d.tribe_name || '',
      total_kills: (existing?.total_kills || 0) + d.total_kills,
      total_deaths: (existing?.total_deaths || 0) + d.total_deaths,
      total_dino_kills: (existing?.total_dino_kills || 0) + d.total_dino_kills,
      total_structures_destroyed: (existing?.total_structures_destroyed || 0) + d.total_structures_destroyed,
      xp: d.xp,
      level: d.level,
      bracket: d.bracket || 'Bronze',
      updated_at: new Date().toISOString(),
    };

    const { error } = await _ctx.supabase
      .from('tribe_stats')
      .upsert(row, { onConflict: 'cluster_id,tribe_id' });

    if (error) throw new Error(`tribe upsert: ${error.message}`);
  }
}

// ─── Player count logging ───

function startCountLogging(ctx) {
  _countTimer = setInterval(() => {
    try {
      const servers = ctx.servers.list();
      let total = 0, online = 0;
      for (const srv of servers) {
        if (srv.status === 'running') { online++; total += (srv.player_count || 0); }
      }
      if (online > 0) {
        ctx.log(`[playerStats] ${total} players across ${online} online servers`, 'info');
      }
    } catch (err) {
      ctx.log(`[playerStats] count error: ${err.message}`, 'warn');
    }
  }, 60000);
}

// ─── Lifecycle ───

function init(ctx) {
  _ctx = ctx;

  _flushTimer = setInterval(() => {
    flush().catch(() => {});
  }, FLUSH_INTERVAL_MS);

  // Periodic cooldown cleanup (every 2 min)
  setInterval(() => { cleanPairCooldowns(); }, 120000);

  startCountLogging(ctx);
  _ctx.log('[stats] initialized — flush every 10s, anti-exploit active', 'info');
}

function postInit() {
  syncRaidData();
  _ctx.log('[stats] postInit complete', 'info');
}

function shutdown() {
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
  if (_countTimer) { clearInterval(_countTimer); _countTimer = null; }
  flush().catch(() => {});
  _playerBuf.clear();
  _tribeBuf.clear();
  _pairCooldowns.clear();
  _ctx = null;
}

module.exports = {
  name,
  core,
  requires,
  init,
  postInit,
  shutdown,
  recordKill,
  recordDeath,
  recordDinoKill,
  recordStructureDestroy,
  recordDamage,
  syncRaidData,
  flush,
};
