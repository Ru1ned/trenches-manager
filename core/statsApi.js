/**
 * Stats API — Read-only aggregation layer for external consumers (mods, web, Discord).
 * Pulls from playerStats + trenchesRaid without modifying any data.
 * Caches results for 3 seconds to prevent spam.
 */
'use strict';

const CACHE_TTL_MS = 3000;

let _cache = { player: new Map(), leaderboard: null, leaderboardAt: 0, health: null, healthAt: 0 };

function getFeatures(ctx) {
  if (!ctx || !ctx.features) return { stats: null, raid: null };
  const f = ctx.features;
  return {
    stats: f.playerStats || null,
    raid: f.trenchesRaid || null,
  };
}

function safeKd(kills, deaths) {
  if (!deaths || deaths === 0) return kills || 0;
  return Math.round((kills / deaths) * 100) / 100;
}

// ─── GET /stats/player/:playerId ───

function getPlayerProfile(ctx, playerId) {
  if (!playerId) return { error: 'playerId is required' };

  // Check cache
  const cached = _cache.player.get(playerId);
  if (cached && (Date.now() - cached._ts) < CACHE_TTL_MS) {
    const { _ts, ...rest } = cached;
    return rest;
  }

  const { stats, raid } = getFeatures(ctx);

  // Pull from playerStats buffers (in-memory current deltas)
  let kills = 0, deaths = 0, dinoKills = 0, structuresDestroyed = 0;
  let playerName = '';
  let tribeId = null;

  if (stats && stats._getPlayerBuf) {
    const buf = stats._getPlayerBuf(playerId);
    if (buf) {
      kills = buf.kills || 0;
      deaths = buf.deaths || 0;
      dinoKills = buf.dino_kills || 0;
      structuresDestroyed = buf.structures_destroyed || 0;
      playerName = buf.player_name || '';
      tribeId = buf.tribe_id || null;
    }
  }

  // Pull raid data from trenchesRaid
  let xp = 0, level = 1, bracket = 'Bronze';
  let raidWins = 0, raidLosses = 0, raidsParticipated = 0;

  if (raid && tribeId) {
    const tribeData = typeof raid.getTribeRaidInfo === 'function' ? raid.getTribeRaidInfo(tribeId) : null;
    if (tribeData) {
      xp = tribeData.xp || 0;
      level = tribeData.level || 1;
      bracket = tribeData.bracket || 'Bronze';
    }
  }

  const result = {
    playerId,
    playerName: playerName || null,
    kills,
    deaths,
    kd: safeKd(kills, deaths),
    dinoKills,
    structuresDestroyed,
    raidsParticipated,
    raidWins,
    raidLosses,
    xp,
    level,
    bracket,
    lastUpdated: new Date().toISOString(),
  };

  // Cache
  _cache.player.set(playerId, { ...result, _ts: Date.now() });
  // Cap cache size
  if (_cache.player.size > 500) {
    const oldest = _cache.player.keys().next().value;
    _cache.player.delete(oldest);
  }

  return result;
}

// ─── GET /stats/leaderboard ───

function getLeaderboard(ctx) {
  // Check cache
  if (_cache.leaderboard && (Date.now() - _cache.leaderboardAt) < CACHE_TTL_MS) {
    return _cache.leaderboard;
  }

  const { stats, raid } = getFeatures(ctx);
  const players = [];
  const tribes = [];

  // Build player leaderboard from playerStats buffers
  if (stats && stats._getPlayerMap) {
    const playerMap = stats._getPlayerMap();
    for (const [eosId, buf] of playerMap) {
      players.push({
        playerId: eosId,
        playerName: buf.player_name || null,
        kills: buf.kills || 0,
        deaths: buf.deaths || 0,
        kd: safeKd(buf.kills, buf.deaths),
        xp: 0,
        level: 1,
        bracket: 'Bronze',
        tribeId: buf.tribe_id || null,
      });
    }
  }

  // Build tribe leaderboard from trenchesRaid
  if (raid && typeof raid.getRaidStatus === 'function') {
    const status = raid.getRaidStatus();
    if (status && status.tribes) {
      for (const t of status.tribes) {
        tribes.push({
          tribeId: t.tribeId,
          tribeName: t.tribeName || null,
          xp: t.xp || 0,
          level: t.level || 1,
          bracket: t.bracket || 'Bronze',
          members: t.members || 0,
          raidWins: 0,
          raidLosses: 0,
        });
      }
    }
  }

  // Enrich player XP from raid tribe data
  if (raid) {
    for (const p of players) {
      if (p.tribeId) {
        const tribeData = typeof raid.getTribeRaidInfo === 'function' ? raid.getTribeRaidInfo(p.tribeId) : null;
        if (tribeData) {
          p.xp = tribeData.xp || 0;
          p.level = tribeData.level || 1;
          p.bracket = tribeData.bracket || 'Bronze';
        }
      }
    }
  }

  // Sort and limit
  players.sort((a, b) => b.xp - a.xp || b.kills - a.kills);
  tribes.sort((a, b) => b.xp - a.xp);

  const result = {
    players: players.slice(0, 50),
    tribes: tribes.slice(0, 50),
    generatedAt: new Date().toISOString(),
  };

  _cache.leaderboard = result;
  _cache.leaderboardAt = Date.now();
  return result;
}

// ─── GET /stats/health ───

function getStatsHealth(ctx) {
  if (_cache.health && (Date.now() - _cache.healthAt) < CACHE_TTL_MS) {
    return _cache.health;
  }

  const { stats, raid } = getFeatures(ctx);
  let totalPlayers = 0, totalTribes = 0;

  if (stats && stats._getPlayerMap) {
    totalPlayers = stats._getPlayerMap().size;
  }
  if (raid && typeof raid.getRaidStatus === 'function') {
    const status = raid.getRaidStatus();
    totalTribes = status ? status.totalTribes || 0 : 0;
  }

  const result = {
    totalPlayersTracked: totalPlayers,
    totalTribesTracked: totalTribes,
    lastUpdateTime: new Date().toISOString(),
    cacheEnabled: true,
    cacheTtlMs: CACHE_TTL_MS,
  };

  _cache.health = result;
  _cache.healthAt = Date.now();
  return result;
}

module.exports = { getPlayerProfile, getLeaderboard, getStatsHealth };
