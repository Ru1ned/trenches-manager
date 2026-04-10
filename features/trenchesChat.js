/**
 * Feature: Admin Assist System (TrenchesChat bridge)
 * Extracted from agent v51.1
 * v60.0: Unified feature system — uses structured ctx namespaces. — behavior-identical.
 *
 * Multi-level menu + validation layer for in-game chat commands.
 */
'use strict';

const name = 'trenchesChat';
const core = true;
const requires = ['tribeEnforcer'];

// ─── State ───
const _adminSessions = new Map(); // playerId -> { step, main, sub, type, serverName, playerName, startedAt }
const _adminCooldown = new Map(); // playerId -> timestamp
const _adminUsage = new Map(); // playerId -> { count, ts }
const _recentTeleports = new Map(); // playerId -> timestamp
const ADMIN_COOLDOWN_MS = 60000;
const MAX_ADMIN_SESSIONS = 200;
const ADMIN_HOURLY_LIMIT = 5;

// ─── Context refs ───
let _ctx = null;

function checkAdminCooldown(playerId) {
  const last = _adminCooldown.get(playerId) || 0;
  if (Date.now() - last < ADMIN_COOLDOWN_MS) return false;
  _adminCooldown.set(playerId, Date.now());
  if (_adminCooldown.size > 500) {
    const oldest = [..._adminCooldown.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < 100; i++) _adminCooldown.delete(oldest[i][0]);
  }
  return true;
}

function checkUsageLimits(playerId) {
  const data = _adminUsage.get(playerId) || { count: 0, ts: Date.now() };
  if (Date.now() - data.ts > 3600000) {
    data.count = 0;
    data.ts = Date.now();
  }
  if (data.count >= ADMIN_HOURLY_LIMIT) return false;
  data.count++;
  _adminUsage.set(playerId, data);
  if (_adminUsage.size > 500) {
    const oldest = [..._adminUsage.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < 100; i++) _adminUsage.delete(oldest[i][0]);
  }
  return true;
}

function validateTeleport(playerId) {
  const lastTp = _recentTeleports.get(playerId) || 0;
  if (Date.now() - lastTp < 60000) return false;
  return true;
}

function sendPlayerChat(serverName, message) {
  try {
    const client = _ctx.runtime.getChatClient(serverName);
    if (client && client.connected) {
      client.execute(`ServerChat ${message}`);
      return true;
    }
  } catch (e) {
    _ctx.log(`[AdminAssist] Failed to send chat on ${serverName}: ${e.message}`, 'warn');
  }
  return false;
}

function handleAdminChat(playerId, playerName, message, serverName) {
  const trimmed = (message || '').trim();
  const session = _adminSessions.get(playerId);

  // Start new session
  if (!session && trimmed.toLowerCase() === '/admin') {
    if (!checkAdminCooldown(playerId)) {
      sendPlayerChat(serverName, 'Please wait before using /admin again.');
      return true;
    }
    if (_adminSessions.size >= MAX_ADMIN_SESSIONS) {
      const oldest = [..._adminSessions.entries()].sort((a, b) => (a[1].startedAt || 0) - (b[1].startedAt || 0));
      _adminSessions.delete(oldest[0][0]);
    }
    _adminSessions.set(playerId, { step: 1, serverName, playerName, startedAt: Date.now() });
    sendPlayerChat(serverName,
      'Admin Assist: 1) Stuck/Movement 2) Tribe Issues 3) Donation Issues 4) Player Report 5) Other — Reply with number'
    );
    _ctx.log(`[AdminAssist] Session started for ${playerName} (${playerId}) on ${serverName}`, 'info');
    return true;
  }

  if (!session) return false;

  // Step 1: Main category
  if (session.step === 1) {
    session.main = trimmed;
    session.step = 2;

    if (trimmed === '1') {
      sendPlayerChat(session.serverName, 'Stuck Help: 1) Teleport me 2) Under map 3) Cannot move — Reply with number');
    } else if (trimmed === '2') {
      sendPlayerChat(session.serverName, 'Tribe Issues: 1) Missing tribe 2) Cannot join tribe 3) Not synced across maps 4) Removed incorrectly — Reply with number');
    } else if (trimmed === '3') {
      sendPlayerChat(session.serverName, 'Donation Issues: 1) Did not receive purchase 2) Wrong item 3) Duplicate issue — Reply with number');
    } else if (trimmed === '4') {
      sendPlayerChat(session.serverName, 'Report: 1) Cheating 2) Griefing 3) Exploit abuse — Reply with number');
    } else if (trimmed === '5') {
      session.type = 'other';
      session.step = 3;
      sendPlayerChat(session.serverName, 'Describe your issue:');
    } else {
      sendPlayerChat(session.serverName, 'Invalid option. Reply 1-5.');
      session.step = 1;
    }
    return true;
  }

  // Step 2: Sub-category
  if (session.step === 2) {
    session.sub = trimmed;
    session.step = 3;
    sendPlayerChat(session.serverName, 'Describe your issue (or type "auto" for automatic fix):');
    return true;
  }

  // Step 3: Description → process
  if (session.step === 3) {
    processAdminRequest(playerId, session, trimmed);
    _adminSessions.delete(playerId);
    return true;
  }

  return false;
}

async function processAdminRequest(playerId, session, description) {
  const playerName = session.playerName || playerId;
  const serverName = session.serverName || 'unknown';
  const typeLabel = `${session.main || '?'}:${session.sub || '?'}`;

  if (!checkUsageLimits(playerId)) {
    sendPlayerChat(serverName, 'Hourly limit reached. Try again later.');
    logAdminRequest(playerId, playerName, serverName, typeLabel, description, 'rate_limited');
    return;
  }

  _ctx.log(`[AdminAssist] ${playerName} (${playerId}) → ${typeLabel}: ${description}`, 'info');
  let result = 'unknown';

  try {
    if (session.main === '1') {
      if (!validateTeleport(playerId)) {
        sendPlayerChat(serverName, 'Cannot teleport right now. Please wait 60 seconds between teleports.');
        result = 'blocked_teleport';
      } else {
        await handleStuckPlayer(playerId, playerName, serverName);
        _recentTeleports.set(playerId, Date.now());
        result = 'teleported';
      }
    } else if (session.main === '2') {
      await handleTribeIssue(playerId, playerName, serverName);
      result = 'tribe_checked';
    } else if (session.main === '3') {
      await handleDonationIssue(playerId, playerName, serverName);
      result = 'donation_checked';
    } else if (session.main === '4') {
      const reportTypes = { '1': 'cheating', '2': 'griefing', '3': 'exploit' };
      const reportType = reportTypes[session.sub] || 'general';
      _ctx.events.emit('admin:report', `Player report (${reportType}) from ${playerName}: ${description}`, {
        level: 'warning', playerId, playerName, serverName, reportType, description,
      });
      sendPlayerChat(serverName, 'Your report has been submitted. Thank you.');
      result = 'report_logged';
    } else {
      _ctx.events.emit('admin:manual_review', `Manual review needed: ${playerName} — ${description}`, {
        level: 'warning', playerId, playerName, serverName, description,
      });
      sendPlayerChat(serverName, 'Your issue has been forwarded to an admin.');
      result = 'escalated';
    }
  } catch (e) {
    _ctx.log(`[AdminAssist] ERROR processing ${typeLabel} for ${playerName}: ${e.message}`, 'error');
    sendPlayerChat(serverName, 'An error occurred. Admin has been notified.');
    result = 'error';
  }

  logAdminRequest(playerId, playerName, serverName, typeLabel, description, result);
}

async function handleStuckPlayer(playerId, playerName, serverName) {
  _ctx.log(`[AdminAssist] Teleporting stuck player ${playerName} on ${serverName}`, 'info');
  await _ctx.commands.enqueue(
    async () => {
      const client = _ctx.runtime.getChatClient(serverName);
      if (client && client.connected) {
        await client.execute(`ScriptCommand TeleportPlayerIDToMe ${playerId}`);
      }
      return { action: 'teleport_safe', player_id: playerId };
    },
    `AdminAssist: teleport ${playerName}`,
    { commandType: 'admin_assist', priority: 90, serverId: serverName, serverName }
  );
  sendPlayerChat(serverName, `${playerName}, you have been moved to a safe location.`);
}

async function handleTribeIssue(playerId, playerName, serverName) {
  // Delegate to tribeEnforcer module through context
  const tribe = _ctx.features.tribeEnforcer.getClusterTribeForPlayer(playerId);
  if (!tribe) {
    sendPlayerChat(serverName, 'No tribe detected for your account. Contact admin for manual help.');
    _ctx.log(`[AdminAssist] No tribe found for ${playerName} (${playerId})`, 'warn');
    return;
  }

  const links = _ctx.features.tribeEnforcer.dbGetTribeMapLinks().filter(m => m.cluster_tribe_id === tribe.cluster_tribe_id);
  if (links.length === 0) {
    sendPlayerChat(serverName, 'Rebuilding your tribe across the cluster...');
  }

  await _ctx.features.tribeEnforcer.handlePlayerJoinTribeEnforcement(
    { id: playerId, name: playerName },
    serverName,
    serverName
  );
  sendPlayerChat(serverName, `${playerName}, tribe sync complete.`);
}

async function handleDonationIssue(playerId, playerName, serverName) {
  sendPlayerChat(serverName, 'Checking your recent purchases...');
  _ctx.events.emit('admin:donation_check', `Donation check requested by ${playerName}`, {
    level: 'info', playerId, playerName, serverName,
  });
  sendPlayerChat(serverName, `${playerName}, your donation status has been queued for review.`);
}

function logAdminRequest(playerId, playerName, serverName, type, desc, result) {
  try {
    _ctx.db.instance().prepare(
      'INSERT INTO admin_requests (player_id, player_name, server_name, type, description, result) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(playerId, playerName, serverName, type, desc, result);
  } catch (e) {
    _ctx.log(`[AdminAssist] Failed to log request: ${e.message}`, 'warn');
  }
}

// ─── Session cleanup (runs every 60s) ───
let _cleanupTimer = null;

function startCleanup() {
  _cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [pid, session] of _adminSessions) {
      if (now - (session.startedAt || 0) > 300000) _adminSessions.delete(pid);
    }
    for (const [pid, data] of _adminUsage) {
      if (now - data.ts > 7200000) _adminUsage.delete(pid);
    }
    for (const [pid, ts] of _recentTeleports) {
      if (now - ts > 300000) _recentTeleports.delete(pid);
    }
  }, 60000);
}

// ─── Init ───
function init(ctx) {
  _ctx = ctx;
  startCleanup();
  _ctx.log('[TrenchesChat] Feature initialized', 'info');
}

function postInit(runtimeRefs) {
  if (runtimeRefs.chatMonitor) {
    _ctx.runtime.getChatClient = (serverName) => {
      try { return runtimeRefs.chatMonitor.clients?.get(serverName) || null; } catch { return null; }
    };
  }
  _ctx.log("[TrenchesChat] postInit complete (chatMonitor bound)", "info");
}

function shutdown() {
  if (_cleanupTimer) clearInterval(_cleanupTimer);
  _adminSessions.clear();
  _adminCooldown.clear();
  _adminUsage.clear();
  _recentTeleports.clear();
}

module.exports = {
  core,
  requires,
  name,
  init,
  postInit,
  shutdown,
  handleAdminChat,
};
