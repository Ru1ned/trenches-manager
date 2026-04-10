/**
 * Feature: Reward Delivery System
 * Handles /link and /redeem in-game commands.
 * Manages reward state machine: pending → delivering → delivered → failed.
 *
 * v61.0: Unified feature system — uses structured ctx namespaces.
 */
'use strict';

const crypto = require('crypto');

const name = 'rewardSystem';
const core = false;
const requires = ['playerRegistry'];

// ─── State ───
let _ctx = null;
let _deliveryCooldowns = new Map(); // eosId → timestamp
const DELIVERY_COOLDOWN_MS = 5000; // 5 seconds per player
const TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// ─── SQLite Schema ───

function ensureTables() {
  const db = _ctx.db.instance();

  db.exec(`
    CREATE TABLE IF NOT EXISTS link_tokens (
      id TEXT PRIMARY KEY,
      eos_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      server_name TEXT,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      claimed INTEGER DEFAULT 0,
      claimed_by TEXT,
      claimed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reward_queue (
      id TEXT PRIMARY KEY,
      eos_id TEXT NOT NULL,
      player_name TEXT,
      reward_type TEXT NOT NULL DEFAULT 'item',
      item_name TEXT NOT NULL,
      blueprint_path TEXT,
      dino_blueprint TEXT,
      quantity INTEGER DEFAULT 1,
      quality INTEGER DEFAULT 0,
      is_blueprint INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 5,
      last_attempt_at TEXT,
      delivered_at TEXT,
      delivery_server TEXT,
      rcon_response TEXT,
      source TEXT DEFAULT 'donation',
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reward_queue_status ON reward_queue(status);
    CREATE INDEX IF NOT EXISTS idx_reward_queue_eos ON reward_queue(eos_id);
    CREATE INDEX IF NOT EXISTS idx_link_tokens_token ON link_tokens(token);
  `);
}

// ─── Linking System ───

function isPlayerLinked(eosId) {
  const db = _ctx.db.instance();
  const row = db.prepare('SELECT id FROM link_tokens WHERE eos_id = ? AND claimed = 1').get(eosId);
  return !!row;
}

function generateLinkToken(eosId, playerName, serverName) {
  const db = _ctx.db.instance();

  // Check if already linked
  if (isPlayerLinked(eosId)) {
    return { already_linked: true, player_name: playerName };
  }

  // Clear expired tokens for this player
  db.prepare('DELETE FROM link_tokens WHERE eos_id = ? AND claimed = 0 AND expires_at < datetime(\'now\')').run(eosId);

  // Check for existing valid token
  const existing = db.prepare(
    'SELECT token, expires_at FROM link_tokens WHERE eos_id = ? AND claimed = 0 AND expires_at > datetime(\'now\')'
  ).get(eosId);

  if (existing) {
    return { token: existing.token, expires_in_minutes: 10, reused: true };
  }

  // Generate new 5-digit code
  const token = String(10000 + Math.floor(Math.random() * 90000));
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();

  db.prepare(
    'INSERT INTO link_tokens (id, eos_id, player_name, server_name, token, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, eosId, playerName, serverName, token, expiresAt);

  // Sync token to cloud (player_link_tokens) so edge functions can verify
  syncLinkTokenToCloud(id, eosId, playerName, serverName, token, expiresAt);

  _ctx.log(`[RewardSystem] Link token generated for ${playerName} (${eosId}): ${token}`, 'info');
  _ctx.events.emit('player:link_requested', `Link token generated for ${playerName}`, {
    level: 'info', eosId, playerName, serverName,
  });

  return { token, expires_in_minutes: 10 };
}

function verifyLinkToken(token, userId) {
  const db = _ctx.db.instance();

  const row = db.prepare(
    'SELECT * FROM link_tokens WHERE token = ? AND claimed = 0'
  ).get(token);

  if (!row) {
    return { error: 'Invalid or already used link code' };
  }

  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM link_tokens WHERE id = ?').run(row.id);
    return { error: 'Link code expired. Use /link in-game to get a new one.' };
  }

  // Mark as claimed
  db.prepare(
    'UPDATE link_tokens SET claimed = 1, claimed_by = ?, claimed_at = datetime(\'now\') WHERE id = ?'
  ).run(userId || 'website', row.id);

  // Sync claim status to cloud
  syncLinkClaimToCloud(row.id, userId || 'website');

  _ctx.log(`[RewardSystem] Account linked: ${row.player_name} (${row.eos_id}) → ${userId || 'website'}`, 'success');
  _ctx.events.emit('player:linked', `${row.player_name} linked their account`, {
    level: 'success', eosId: row.eos_id, playerName: row.player_name,
  });

  return {
    success: true,
    player_name: row.player_name,
    eos_id: row.eos_id,
    server_name: row.server_name,
  };
}

// ─── Reward Queue ───

function getPendingRewards(eosId) {
  const db = _ctx.db.instance();
  return db.prepare(
    'SELECT * FROM reward_queue WHERE eos_id = ? AND status = \'pending\' ORDER BY created_at ASC'
  ).all(eosId);
}

function getAllPendingRewards() {
  const db = _ctx.db.instance();
  return db.prepare(
    'SELECT * FROM reward_queue WHERE status = \'pending\' ORDER BY created_at ASC LIMIT 100'
  ).all();
}

function queueReward(reward) {
  const db = _ctx.db.instance();
  const id = reward.id || crypto.randomUUID();

  db.prepare(`
    INSERT OR IGNORE INTO reward_queue (id, eos_id, player_name, reward_type, item_name, blueprint_path, dino_blueprint, quantity, quality, is_blueprint, source, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    reward.eos_id,
    reward.player_name || null,
    reward.reward_type || 'item',
    reward.item_name,
    reward.blueprint_path || null,
    reward.dino_blueprint || null,
    reward.quantity || 1,
    reward.quality || 0,
    reward.is_blueprint ? 1 : 0,
    reward.source || 'donation',
    JSON.stringify(reward.metadata || {}),
  );

  _ctx.log(`[RewardSystem] Reward queued: "${reward.item_name}" x${reward.quantity || 1} for ${reward.eos_id}`, 'info');
  _ctx.events.emit('reward:created', `Reward queued: ${reward.item_name}`, {
    level: 'info', eosId: reward.eos_id, item: reward.item_name,
  });

  return id;
}

// ─── Delivery Engine ───

async function executeReward(eosId, reward) {
  const db = _ctx.db.instance();

  // Check linking
  if (!isPlayerLinked(eosId)) {
    return { success: false, error: 'Account not linked. Use /link in-game first.' };
  }

  // Delivery locking — prevent double execution
  const current = db.prepare('SELECT status FROM reward_queue WHERE id = ?').get(reward.id);
  if (!current || current.status !== 'pending') {
    return { success: false, error: 'Reward is not in pending state' };
  }

  // Cooldown check
  const lastDelivery = _deliveryCooldowns.get(eosId) || 0;
  if (Date.now() - lastDelivery < DELIVERY_COOLDOWN_MS) {
    return { success: false, error: 'Please wait a few seconds between claims' };
  }

  // Resolve player — MUST be online
  const playerRegistry = _ctx.features.playerRegistry;
  if (!playerRegistry) {
    return { success: false, error: 'Player registry unavailable' };
  }

  const player = playerRegistry.resolvePlayerByEOSID(eosId);
  if (!player) {
    return { success: false, error: 'You must be online in-game to claim rewards' };
  }

  // Lock reward
  db.prepare(
    'UPDATE reward_queue SET status = \'delivering\', attempts = attempts + 1, last_attempt_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?'
  ).run(reward.id);

  _deliveryCooldowns.set(eosId, Date.now());

  try {
    // Get RCON client for the server the player is on
    const chatMonitor = _ctx.runtime.chatMonitor;
    if (!chatMonitor || !chatMonitor.clients) {
      throw new Error('RCON system unavailable');
    }

    const client = chatMonitor.clients.get(player.serverName);
    if (!client || !client.connected) {
      throw new Error(`No RCON connection to ${player.serverName}`);
    }

    let rconResponse = '';

    if (reward.reward_type === 'dino' || reward.dino_blueprint) {
      // Dino delivery — spawn near player, auto-tame, give empty cryopod
      const dinoBP = reward.dino_blueprint || reward.blueprint_path;
      const level = reward.quality || 150;
      const spawnCmd = `ES.SpawnDinoFor ${eosId} ${dinoBP} "" 0 ${level} 0 0 1 0 0 R`;
      const result = await client.execute(spawnCmd);
      rconResponse = String(result || '').trim();

      // Give empty cryopod
      try {
        await client.execute(`ES.SpawnItemFor ${eosId} "Blueprint'/Game/Extinction/CoreBlueprints/Weapons/PrimalItem_WeaponEmptyCryopod.PrimalItem_WeaponEmptyCryopod'" "" 0 0 1`);
      } catch (e) { /* non-critical */ }

    } else if (reward.reward_type === 'command_bundle') {
      // Execute raw commands from metadata
      const commands = reward.metadata ? (typeof reward.metadata === 'string' ? JSON.parse(reward.metadata) : reward.metadata).commands || [] : [];
      const responses = [];
      for (const cmd of commands) {
        const resolvedCmd = cmd.replace(/\{eosid\}/gi, eosId).replace(/\{player\}/gi, player.playerName);
        const result = await client.execute(resolvedCmd);
        responses.push(String(result || '').trim());
      }
      rconResponse = responses.join('; ');

    } else {
      // Standard item delivery
      const bp = reward.blueprint_path || reward.item_name;
      const isBP = reward.is_blueprint ? 1 : 0;
      const itemCmd = `ES.SpawnItemFor ${eosId} ${bp} "" ${reward.quality || 0} ${isBP} ${reward.quantity || 1}`;
      const result = await client.execute(itemCmd);
      rconResponse = String(result || '').trim();
    }

    // Check if delivery was successful
    const isError = /error|failed|invalid|denied|not found|unknown command/i.test(rconResponse);
    if (isError) {
      throw new Error(`RCON error: ${rconResponse}`);
    }

    // Mark as delivered
    db.prepare(
      'UPDATE reward_queue SET status = \'delivered\', delivered_at = datetime(\'now\'), delivery_server = ?, rcon_response = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(player.serverName, rconResponse, reward.id);

    // Sync delivery status back to Supabase
    syncDeliveryToCloud(reward.id, 'delivered', player.serverName, rconResponse);

    // Notify player
    try {
      await client.execute(`ServerChat ${player.playerName}, your reward "${reward.item_name}" has been delivered!`);
    } catch (e) { /* non-critical */ }

    _ctx.log(`[RewardSystem] Delivered "${reward.item_name}" to ${player.playerName} on ${player.serverName}`, 'success');
    _ctx.events.emit('reward:delivered', `Reward delivered: ${reward.item_name} → ${player.playerName}`, {
      level: 'success', eosId, item: reward.item_name, server: player.serverName,
    });

    return { success: true, rcon_response: rconResponse };

  } catch (err) {
    // Mark failed but keep as pending for retry (unless max attempts reached)
    const updated = db.prepare('SELECT attempts, max_attempts FROM reward_queue WHERE id = ?').get(reward.id);
    const newStatus = (updated && updated.attempts >= updated.max_attempts) ? 'failed' : 'pending';

    db.prepare(
      'UPDATE reward_queue SET status = ?, rcon_response = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(newStatus, err.message, reward.id);

    // Sync failure status to cloud
    if (newStatus === 'failed') {
      syncDeliveryToCloud(reward.id, 'failed', null, err.message);
    }

    _ctx.log(`[RewardSystem] Delivery failed for "${reward.item_name}": ${err.message}`, 'error');
    _ctx.events.emit('reward:failed', `Reward delivery failed: ${reward.item_name} — ${err.message}`, {
      level: 'error', eosId, item: reward.item_name, error: err.message,
    });

    return { success: false, error: err.message };
  }
}

// ─── Cloud Link Token Sync (via agent-api edge function) ───

function _getAgentApiConfig() {
  const supabaseUrl = _ctx.settings.get('supabase_url', '');
  const agentKey = _ctx.settings.get('agent_key', '');
  if (!supabaseUrl || !agentKey) return null;
  return { supabaseUrl, agentKey };
}

function _callAgentApi(action, body) {
  const config = _getAgentApiConfig();
  if (!config) return;

  try {
    const https = require('https');
    const http = require('http');
    const url = `${config.supabaseUrl}/functions/v1/agent-api?action=${action}`;
    const client = url.startsWith('https') ? https : http;

    const req = client.request(url, {
      method: 'POST',
      headers: {
        'x-agent-key': config.agentKey,
        'Content-Type': 'application/json',
      },
    }, () => {});
    req.on('error', () => {});
    req.write(JSON.stringify(body));
    req.end();
  } catch (e) {
    // Non-critical
  }
}

function syncLinkTokenToCloud(id, eosId, playerName, serverName, token, expiresAt) {
  _callAgentApi('sync-link-token', {
    id,
    eos_id: eosId,
    player_name: playerName,
    server_name: serverName || null,
    token,
    expires_at: expiresAt,
  });
  _ctx.log(`[RewardSystem] Link token synced to cloud: ${token} for ${playerName}`, 'info');
}

function syncLinkClaimToCloud(tokenId, claimedBy) {
  // Claim sync — use direct REST since agent-api validates the token locally
  const config = _getAgentApiConfig();
  if (!config) return;

  try {
    const https = require('https');
    const http = require('http');
    const supabaseKey = _ctx.settings.get('supabase_anon_key', '');
    if (!supabaseKey) return;
    const patchUrl = `${config.supabaseUrl}/rest/v1/player_link_tokens?id=eq.${tokenId}`;
    const client = patchUrl.startsWith('https') ? https : http;

    const req = client.request(patchUrl, {
      method: 'PATCH',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
    }, () => {});
    req.on('error', () => {});
    req.write(JSON.stringify({ claimed: true, claimed_by: claimedBy, claimed_at: new Date().toISOString() }));
    req.end();
  } catch (e) {
    // Non-critical
  }
}

// ─── Cloud Status Sync (via agent-api edge function) ───

function syncDeliveryToCloud(rewardId, status, deliveryServer, rconResponse) {
  _callAgentApi('report-delivery', {
    reward_id: rewardId,
    status,
    delivery_server: deliveryServer || null,
    rcon_response: rconResponse || null,
  });
}

// ─── Chat Command Handlers ───

function sendChat(serverName, message) {
  try {
    const client = _ctx.runtime.getChatClient(serverName);
    if (client && client.connected) {
      client.execute(`ServerChat ${message}`);
      return true;
    }
  } catch (e) {}
  return false;
}

function handleChatCommand(playerId, playerName, message, serverName) {
  const trimmed = (message || '').trim().toLowerCase();

  // /link command
  if (trimmed === '/link') {
    const playerRegistry = _ctx.features.playerRegistry;
    if (!playerRegistry) {
      sendChat(serverName, `${playerName}, linking system is currently unavailable.`);
      return true;
    }

    // Resolve player EOS ID from registry
    const player = playerRegistry.resolvePlayerByName(playerName);
    if (!player || !player.eosId || player.eosId.startsWith('pid_')) {
      sendChat(serverName, `${playerName}, could not resolve your EOS ID. Please try again in a moment.`);
      return true;
    }

    const result = generateLinkToken(player.eosId, playerName, serverName);

    if (result.already_linked) {
      sendChat(serverName, `${playerName}, your account is already linked!`);
    } else if (result.token) {
      sendChat(serverName, `${playerName}, go to the website and enter this code to link your account: ${result.token} (expires in 10 minutes)`);
    } else {
      sendChat(serverName, `${playerName}, failed to generate link code. Try again.`);
    }

    return true;
  }

  // /redeem command
  if (trimmed === '/redeem') {
    const playerRegistry = _ctx.features.playerRegistry;
    if (!playerRegistry) {
      sendChat(serverName, `${playerName}, reward system is currently unavailable.`);
      return true;
    }

    const player = playerRegistry.resolvePlayerByName(playerName);
    if (!player || !player.eosId || player.eosId.startsWith('pid_')) {
      sendChat(serverName, `${playerName}, could not resolve your account. Please try again.`);
      return true;
    }

    if (!isPlayerLinked(player.eosId)) {
      sendChat(serverName, `${playerName}, you must link your account using /link before claiming rewards.`);
      return true;
    }

    const pending = getPendingRewards(player.eosId);
    if (pending.length === 0) {
      sendChat(serverName, `${playerName}, you have no pending rewards.`);
      return true;
    }

    sendChat(serverName, `${playerName}, claiming ${pending.length} reward(s)...`);

    // Process rewards asynchronously
    (async () => {
      let delivered = 0;
      let failed = 0;
      for (const reward of pending) {
        const result = await executeReward(player.eosId, reward);
        if (result.success) delivered++;
        else failed++;
        // Cooldown between deliveries
        await new Promise(r => setTimeout(r, 3000));
      }
      if (delivered > 0) {
        sendChat(serverName, `${playerName}, ${delivered} reward(s) delivered!${failed > 0 ? ` ${failed} failed — try /redeem again.` : ''}`);
      } else {
        sendChat(serverName, `${playerName}, delivery failed. Make sure you stay online and try /redeem again.`);
      }
    })().catch(err => {
      _ctx.log(`[RewardSystem] Redeem batch error: ${err.message}`, 'error');
    });

    return true;
  }

  return false;
}

// ─── Status API ───

function getRewardStatus() {
  try {
    const db = _ctx.db.instance();
    const pending = db.prepare('SELECT COUNT(*) as c FROM reward_queue WHERE status = \'pending\'').get();
    const delivering = db.prepare('SELECT COUNT(*) as c FROM reward_queue WHERE status = \'delivering\'').get();
    const delivered = db.prepare('SELECT COUNT(*) as c FROM reward_queue WHERE status = \'delivered\'').get();
    const failed = db.prepare('SELECT COUNT(*) as c FROM reward_queue WHERE status = \'failed\'').get();
    const linkedPlayers = db.prepare('SELECT COUNT(*) as c FROM link_tokens WHERE claimed = 1').get();
    const pendingTokens = db.prepare('SELECT COUNT(*) as c FROM link_tokens WHERE claimed = 0 AND expires_at > datetime(\'now\')').get();

    return {
      rewards: {
        pending: pending?.c || 0,
        delivering: delivering?.c || 0,
        delivered: delivered?.c || 0,
        failed: failed?.c || 0,
      },
      linked_players: linkedPlayers?.c || 0,
      pending_link_tokens: pendingTokens?.c || 0,
    };
  } catch (e) {
    return { rewards: { pending: 0, delivering: 0, delivered: 0, failed: 0 }, linked_players: 0, pending_link_tokens: 0 };
  }
}

// ─── Supabase → Local Reward Bridge ───

let _syncInterval = null;
const SYNC_INTERVAL_MS = 30000; // Poll Supabase every 30 seconds

async function syncRewardsFromCloud() {
  if (!_ctx) return;

  try {
    const config = _getAgentApiConfig();
    if (!config) return;

    const https = require('https');
    const http = require('http');
    const url = `${config.supabaseUrl}/functions/v1/agent-api?action=fetch-pending-rewards`;
    const client = url.startsWith('https') ? https : http;

    const response = await new Promise((resolve, reject) => {
      const req = client.request(url, {
        method: 'POST',
        headers: {
          'x-agent-key': config.agentKey,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, data: {} }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write('{}');
      req.end();
    });

    if (response.status !== 200 || !response.data.rewards) return;

    const rewards = response.data.rewards;
    if (rewards.length === 0) return;

    let synced = 0;
    const db = _ctx.db.instance();

    for (const r of rewards) {
      // Check if already in local queue (dedup by cloud ID)
      const existing = db.prepare('SELECT id FROM reward_queue WHERE id = ?').get(r.id);
      if (existing) continue;

      // Insert into local reward_queue
      db.prepare(`
        INSERT OR IGNORE INTO reward_queue (id, eos_id, player_name, reward_type, item_name, blueprint_path, dino_blueprint, quantity, quality, is_blueprint, source, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        r.id,
        r.eos_id,
        r.player_name || null,
        r.reward_type || 'item',
        r.item_name,
        r.blueprint_path || null,
        r.dino_blueprint || null,
        r.quantity || 1,
        r.quality || 0,
        r.is_blueprint ? 1 : 0,
        r.source || 'donation',
        typeof r.metadata === 'string' ? r.metadata : JSON.stringify(r.metadata || {}),
      );

      synced++;
    }

    if (synced > 0) {
      _ctx.log(`[RewardSystem] Synced ${synced} reward(s) from cloud → local queue`, 'info');
      _ctx.events.emit('reward:synced', `${synced} reward(s) synced from cloud`, { level: 'info', count: synced });
    }
  } catch (err) {
    // Non-critical — will retry next cycle
    if (_ctx) _ctx.log(`[RewardSystem] Cloud sync error (non-fatal): ${err.message}`, 'warn');
  }
}

// ─── Lifecycle ───

function init(ctx) {
  _ctx = ctx;
  ensureTables();

  // Start cloud reward sync
  _syncInterval = setInterval(() => {
    syncRewardsFromCloud().catch(() => {});
  }, SYNC_INTERVAL_MS);

  // Initial sync after 10 seconds
  setTimeout(() => { syncRewardsFromCloud().catch(() => {}); }, 10000);

  _ctx.log('[RewardSystem] Feature initialized (cloud sync enabled)', 'info');
}

function postInit(runtimeRefs) {
  if (runtimeRefs.chatMonitor) {
    _ctx.runtime.chatMonitor = runtimeRefs.chatMonitor;
  }
  _ctx.log('[RewardSystem] postInit complete', 'info');
}

function shutdown() {
  _deliveryCooldowns.clear();
  if (_syncInterval) {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }
}

module.exports = {
  name,
  core,
  requires,
  init,
  postInit,
  shutdown,
  handleChatCommand,
  generateLinkToken,
  verifyLinkToken,
  isPlayerLinked,
  getPendingRewards,
  getAllPendingRewards,
  queueReward,
  executeReward,
  getRewardStatus,
};
