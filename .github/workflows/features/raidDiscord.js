/**
 * Feature: Raid Discord — Leaderboard + Raid Alerts
 *
 * Posts TrenchesRaid leaderboard to Discord and forwards raid events
 * (level-ups, blocks, retaliations) as rich embeds.
 *
 * Uses the existing discordAlerts webhook infrastructure for sending.
 * Leaderboard uses a separate webhook URL (or same) with message edit
 * pattern to avoid spam.
 *
 * Config (settings table):
 *   raid_leaderboard_channel_webhook — Discord webhook URL for leaderboard channel
 *   raid_alerts_channel_webhook      — Discord webhook URL for alerts channel (optional, falls back to main)
 *   raid_leaderboard_interval_ms     — Post interval (default: 300000 = 5 min)
 *   raid_alerts_enabled              — 'true'/'false' (default: true)
 *   raid_leaderboard_enabled         — 'true'/'false' (default: true)
 *
 * Dependencies: trenchesRaid, discordAlerts (optional)
 */
'use strict';

const name = 'raidDiscord';
const core = false;
const requires = ['trenchesRaid'];

// ─── State ───
let _ctx = null;
let _trenchesRaid = null;
let _discordAlerts = null;
let _leaderboardTimer = null;
let _lastLeaderboardMessageId = null; // For edit-in-place
let _leaderboardWebhook = null;
let _alertsWebhook = null;
let _intervalMs = 300000; // 5 min default
let _stats = { leaderboardPosts: 0, alertsSent: 0, errors: 0 };

// ─── Discord HTTP helpers ───

function httpRequest(url, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? require('https') : require('http');
    const payload = body ? JSON.stringify(body) : null;

    const opts = {
      method,
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: 15000,
    };

    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          // Rate limited — retry after delay
          try {
            const parsed = JSON.parse(data);
            const retryAfter = (parsed.retry_after || 5) * 1000;
            setTimeout(() => httpRequest(url, method, body, headers).then(resolve).catch(reject), retryAfter);
          } catch { reject(new Error('Discord rate limited')); }
          return;
        }
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function isValidWebhookUrl(url) {
  return url && typeof url === 'string' && url.startsWith('https://discord.com/api/webhooks/');
}

// ─── Leaderboard Generator ───

function buildLeaderboardEmbed() {
  if (!_trenchesRaid) return null;

  const status = _trenchesRaid.getRaidStatus();
  if (!status || status.totalTribes === 0) {
    return {
      title: '🏆 Trenches Raid Rankings',
      description: 'No tribes have earned XP yet. Get raiding!',
      color: 0xFFD700,
      timestamp: new Date().toISOString(),
      footer: { text: 'Trenches Raid System' },
    };
  }

  // Top tribes by XP (already sorted by getRaidStatus)
  const top = status.tribes.slice(0, 15);
  const bracketEmojis = { Bronze: '🥉', Silver: '🥈', Gold: '🥇', Alpha: '👑' };

  let description = '';
  top.forEach((t, i) => {
    const emoji = bracketEmojis[t.bracket] || '⚔️';
    const pos = i < 3 ? ['🥇', '🥈', '🥉'][i] : `**${i + 1}.**`;
    description += `${pos} ${emoji} **${t.tribeId}** — Level ${t.level} (${t.bracket}) • ${t.xp} XP\n`;
  });

  // Active retaliations
  const retaliations = [];
  for (const t of status.tribes) {
    if (t.activeRetaliations > 0) {
      const info = _trenchesRaid.getTribeRaidInfo(t.tribeId);
      if (info && info.retaliationTargets) {
        for (const [target, data] of Object.entries(info.retaliationTargets)) {
          const hours = Math.round(data.remainingMs / 3600000 * 10) / 10;
          retaliations.push(`⚔️ **${t.tribeId}** → **${target}** (${hours}h remaining)`);
        }
      }
    }
  }

  const fields = [
    { name: '📊 Stats', value: `Total Tribes: ${status.totalTribes} | Purge: ${status.purgeActive ? '🔴 ACTIVE' : '🟢 Off'}`, inline: false },
  ];

  if (retaliations.length > 0) {
    fields.push({
      name: '⚔️ Active Retaliations',
      value: retaliations.slice(0, 10).join('\n') || 'None',
      inline: false,
    });
  }

  return {
    title: '🏆 Trenches Raid Rankings',
    description: description.trim(),
    color: 0xFFD700,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: `Updated • Trenches Raid System` },
  };
}

async function postLeaderboard() {
  if (!_leaderboardWebhook) return;

  const embed = buildLeaderboardEmbed();
  if (!embed) return;

  try {
    if (_lastLeaderboardMessageId) {
      // Try to edit existing message
      const editUrl = `${_leaderboardWebhook}/messages/${_lastLeaderboardMessageId}`;
      const res = await httpRequest(editUrl, 'PATCH', { embeds: [embed] });
      if (res.status >= 200 && res.status < 300) {
        _stats.leaderboardPosts++;
        return;
      }
      // If edit fails (message deleted etc.), fall through to new post
      _lastLeaderboardMessageId = null;
    }

    // Post new message with ?wait=true to get message ID
    const postUrl = `${_leaderboardWebhook}?wait=true`;
    const res = await httpRequest(postUrl, 'POST', { embeds: [embed] });
    if (res.status >= 200 && res.status < 300 && res.data && res.data.id) {
      _lastLeaderboardMessageId = res.data.id;
      _stats.leaderboardPosts++;
      _ctx.log('[raidDiscord] leaderboard posted', 'info');
    }
  } catch (err) {
    _stats.errors++;
    _ctx.log(`[raidDiscord] leaderboard post error: ${err.message}`, 'warn');
  }
}

// ─── Raid Alerts ───

function sendRaidAlert(title, description, color = 0x3498DB, fields = []) {
  const webhook = _alertsWebhook || _leaderboardWebhook;
  if (!webhook) return;

  if (_ctx && _ctx.settings) {
    const enabled = _ctx.settings.get('raid_alerts_enabled', 'true');
    if (enabled !== 'true') return;
  }

  const embed = {
    title,
    description,
    color,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'Trenches Raid System' },
  };

  // Fire and forget — non-blocking
  httpRequest(`${webhook}?wait=false`, 'POST', { embeds: [embed] }).then(() => {
    _stats.alertsSent++;
  }).catch((err) => {
    _stats.errors++;
    _ctx.log(`[raidDiscord] alert send error: ${err.message}`, 'warn');
  });
}

function onLevelUp(tribeId, level, bracket, xp) {
  const bracketEmojis = { Bronze: '🥉', Silver: '🥈', Gold: '🥇', Alpha: '👑' };
  const emoji = bracketEmojis[bracket] || '⬆️';
  sendRaidAlert(
    `${emoji} Tribe Level Up!`,
    `**${tribeId}** reached **Level ${level}** (${bracket})`,
    bracket === 'Alpha' ? 0xFF0000 : bracket === 'Gold' ? 0xFFD700 : 0x3498DB,
    [{ name: 'XP', value: String(xp), inline: true }, { name: 'Bracket', value: bracket, inline: true }]
  );
}

function onRaidBlocked(attackerTribeId, defenderTribeId, attackerBracket, defenderBracket) {
  if (_ctx && _ctx.settings) {
    const toggle = _ctx.settings.get('raid_block_alerts_enabled', 'true');
    if (toggle !== 'true') return;
  }
  sendRaidAlert(
    '🛡️ Raid Blocked',
    `**${attackerTribeId}** (${attackerBracket}) attempted to raid **${defenderTribeId}** (${defenderBracket})`,
    0xFF4444,
    [{ name: 'Reason', value: 'Bracket mismatch — too far apart', inline: false }]
  );
}

function onRetaliationGranted(defenderTribeId, attackerTribeId) {
  sendRaidAlert(
    '⚔️ Retaliation Granted',
    `**${defenderTribeId}** can now retaliate against **${attackerTribeId}** for 48 hours`,
    0xFFA500
  );
}

function onRaidAlert(attackerTribeId, defenderTribeId) {
  sendRaidAlert(
    '🚨 Raid Alert',
    `**${defenderTribeId}** is being raided by **${attackerTribeId}**!`,
    0xFF0000,
    [{ name: 'Attacker', value: String(attackerTribeId), inline: true }, { name: 'Defender', value: String(defenderTribeId), inline: true }]
  );
}

// ─── Event Hooks ───

function hookEvents() {
  if (!_ctx || !_ctx.events) return;

  // These events are emitted by trenchesRaid.js
  // We listen on the shared event bus

  // Note: trenchesRaid emits 'raid:levelup' and 'raid:blocked'
  // We'll also register for the retaliation event pattern
}

// ─── Diagnostics ───

function getRaidDiscordStatus() {
  return {
    leaderboard_webhook: _leaderboardWebhook ? 'configured' : 'not set',
    alerts_webhook: _alertsWebhook ? 'configured' : 'not set',
    interval_ms: _intervalMs,
    last_message_id: _lastLeaderboardMessageId,
    stats: { ..._stats },
  };
}

// ─── Lifecycle ───

function init(ctx) {
  _ctx = ctx;

  // Load config
  _leaderboardWebhook = ctx.settings.get('raid_leaderboard_channel_webhook', null);
  _alertsWebhook = ctx.settings.get('raid_alerts_channel_webhook', null);
  _intervalMs = parseInt(ctx.settings.get('raid_leaderboard_interval_ms', '300000')) || 300000;

  // Clamp interval: 60s min, 30min max
  _intervalMs = Math.max(60000, Math.min(_intervalMs, 1800000));

  if (!isValidWebhookUrl(_leaderboardWebhook)) {
    _leaderboardWebhook = null;
    ctx.log('[raidDiscord] leaderboard webhook not configured — leaderboard disabled', 'warn');
  }
  if (_alertsWebhook && !isValidWebhookUrl(_alertsWebhook)) {
    _alertsWebhook = null;
  }

  ctx.log(`[raidDiscord] initialized — leaderboard=${_leaderboardWebhook ? 'ON' : 'OFF'}, alerts=${(_alertsWebhook || _leaderboardWebhook) ? 'ON' : 'OFF'}, interval=${_intervalMs}ms`, 'info');
}

function postInit(runtimeRefs) {
  // Grab trenchesRaid ref
  if (_ctx && _ctx.features && _ctx.features.trenchesRaid) {
    _trenchesRaid = _ctx.features.trenchesRaid;
  }

  // Grab discordAlerts if available
  if (_ctx && _ctx.features && _ctx.features.discordAlerts) {
    _discordAlerts = _ctx.features.discordAlerts;
  }

  // Start leaderboard timer
  if (_leaderboardWebhook) {
    const leaderboardEnabled = _ctx.settings.get('raid_leaderboard_enabled', 'true');
    if (leaderboardEnabled === 'true') {
      // Post initial leaderboard after 10s delay
      setTimeout(() => postLeaderboard().catch(() => {}), 10000);

      _leaderboardTimer = setInterval(() => {
        postLeaderboard().catch(() => {});
      }, _intervalMs);

      _ctx.log(`[raidDiscord] leaderboard posting every ${_intervalMs / 1000}s`, 'info');
    }
  }

  hookEvents();
  _ctx.log('[raidDiscord] postInit complete', 'info');
}

function shutdown() {
  if (_leaderboardTimer) { clearInterval(_leaderboardTimer); _leaderboardTimer = null; }
  _ctx = null;
  _trenchesRaid = null;
  _discordAlerts = null;
  _lastLeaderboardMessageId = null;
}

// ─── Raid Zone Event Handler ───

function onRaidZoneEvent(eventType, data) {
  if (!_alertsWebhook && !_leaderboardWebhook) return;
  const webhook = _alertsWebhook || _leaderboardWebhook;
  const alertsEnabled = _ctx ? _ctx.settings.get('raid_alerts_enabled', 'true') === 'true' : true;
  if (!alertsEnabled) return;

  let embed = null;

  switch (eventType) {
    case 'raidStarted':
      embed = {
        title: '⚔️ Raid Zone Breach',
        description: `Tribe **${data.attackerTribeId}** has begun raiding tribe **${data.defenderTribeId}**!`,
        color: 0xff4444,
        fields: [
          { name: 'Base Value', value: `${data.baseValue}`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      };
      break;
    case 'raidResolved':
      embed = {
        title: data.outcome === 'attacker_win' ? '🏴 Base Destroyed' : '🛡️ Raid Defended',
        description: data.outcome === 'attacker_win'
          ? `Tribe **${data.attackerTribeId}** destroyed **${data.percentDestroyed}%** of tribe **${data.defenderTribeId}**'s base!`
          : `Tribe **${data.defenderTribeId}** successfully defended! Attacker forfeited.`,
        color: data.outcome === 'attacker_win' ? 0xff0000 : 0x00ff00,
        fields: [
          { name: 'Destroyed', value: `${data.percentDestroyed}%`, inline: true },
          { name: 'Outcome', value: data.outcome === 'attacker_win' ? 'Attacker Win' : 'Defender Win', inline: true },
        ],
        timestamp: new Date().toISOString(),
      };
      break;
    case 'whiteFlag':
      embed = {
        title: data.active ? '🏳️ White Flag Activated' : '🏳️ White Flag Removed',
        description: data.active
          ? `Tribe **${data.tribeId}** is now under white flag protection (5 days).`
          : `Tribe **${data.tribeId}** removed their white flag. They can be raided again.`,
        color: data.active ? 0xcccccc : 0xffaa00,
        timestamp: new Date().toISOString(),
      };
      break;
    default:
      return;
  }

  if (embed) {
    postWebhook(webhook, { embeds: [embed] }).catch(() => { _stats.errors++; });
    _stats.alertsSent++;
  }
}

module.exports = {
  name,
  core,
  requires,
  init,
  postInit,
  shutdown,

  // Public API
  postLeaderboard,
  sendRaidAlert,
  getRaidDiscordStatus,

  // Event handlers (called by trenchesRaid or event bus)
  onLevelUp,
  onRaidBlocked,
  onRetaliationGranted,
  onRaidAlert,
  onRaidZoneEvent,
};
