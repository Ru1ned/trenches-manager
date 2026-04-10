/**
 * RCON Queue Module — Global rate-limited command queue
 * 
 * Intercepts all outgoing RCON commands by wrapping getChatClient().
 * Addons require ZERO changes — the queue is fully transparent.
 */
'use strict';

const PRIORITIES = { HIGH: 3, NORMAL: 2, LOW: 1 };
const MAX_QUEUE_SIZE = 500;
const BATCH_SIZE = 4;           // commands per tick
const TICK_MS = 100;            // process interval
const MAX_RETRIES = 2;

// ─── State ───
let _queue = [];
let _timer = null;
let _log = () => {};
let _stats = { sent: 0, dropped: 0, retries: 0, startedAt: Date.now() };

// ─── Queue Item ───
function enqueue(client, command, serverName, priority = 'NORMAL') {
  const p = PRIORITIES[priority] || PRIORITIES.NORMAL;

  // Overflow protection — drop LOW first
  if (_queue.length >= MAX_QUEUE_SIZE) {
    const lowIdx = _queue.findIndex(i => i.priority === PRIORITIES.LOW);
    if (lowIdx !== -1) {
      _queue.splice(lowIdx, 1);
      _stats.dropped++;
      _log('[RCONQueue] overflow — dropped LOW priority command', 'warn');
    } else {
      // Queue full with no LOW items — drop incoming if LOW
      if (p === PRIORITIES.LOW) {
        _stats.dropped++;
        return Promise.resolve();
      }
      // Otherwise drop oldest NORMAL
      const normIdx = _queue.findIndex(i => i.priority === PRIORITIES.NORMAL);
      if (normIdx !== -1) {
        _queue.splice(normIdx, 1);
        _stats.dropped++;
        _log('[RCONQueue] overflow — dropped NORMAL priority command', 'warn');
      }
    }
  }

  return new Promise((resolve) => {
    _queue.push({
      client,
      command,
      serverName,
      priority: p,
      retries: 0,
      timestamp: Date.now(),
      resolve,
    });
    // Keep sorted: HIGH first, then by timestamp
    _queue.sort((a, b) => b.priority - a.priority || a.timestamp - b.timestamp);
  });
}

// ─── Tick processor ───
async function processTick() {
  if (_queue.length === 0) return;

  const batch = _queue.splice(0, BATCH_SIZE);

  for (const item of batch) {
    try {
      if (item.client && item.client.connected) {
        await item.client._originalExecute(item.command);
        _stats.sent++;
      }
      item.resolve();
    } catch (err) {
      item.retries++;
      if (item.retries <= MAX_RETRIES) {
        _stats.retries++;
        _queue.push(item); // re-enqueue for retry
      } else {
        _stats.dropped++;
        _log(`[RCONQueue] command dropped after ${MAX_RETRIES} retries: ${item.command} → ${item.serverName}`, 'warn');
        item.resolve(); // never block
      }
    }
  }
}

// ─── Client wrapper ───
// Wraps a chat client so .execute() goes through the queue
function wrapClient(client, serverName) {
  if (!client || client._rconQueueWrapped) return client;

  // Preserve original execute
  client._originalExecute = client.execute.bind(client);

  // Replace execute with queued version
  client.execute = function queuedExecute(command) {
    // Detect priority from command content
    let priority = 'NORMAL';
    if (/^ServerChat/i.test(command)) priority = 'NORMAL';
    if (/ScriptCommand.*Teleport|DestroyTribeStructures/i.test(command)) priority = 'HIGH';

    return enqueue(client, command, serverName, priority);
  };

  client._rconQueueWrapped = true;
  return client;
}

// ─── Intercept getChatClient ───
function install(ctx) {
  _log = ctx.log || (() => {});

  // Wait for getChatClient to be set (postInit), then wrap it
  const originalGetter = ctx.runtime.getChatClient;
  if (typeof originalGetter === 'function') {
    ctx.runtime.getChatClient = function (serverName) {
      const client = originalGetter(serverName);
      return client ? wrapClient(client, serverName) : null;
    };
    _log('[RCONQueue] installed — intercepting getChatClient', 'info');
  }

  // Also watch for future reassignment (trenchesChat postInit sets this)
  const runtimeProxy = new Proxy(ctx.runtime, {
    set(target, prop, value) {
      if (prop === 'getChatClient' && typeof value === 'function') {
        const wrapped = function (serverName) {
          const client = value(serverName);
          return client ? wrapClient(client, serverName) : null;
        };
        target[prop] = wrapped;
        _log('[RCONQueue] re-intercepted getChatClient after reassignment', 'info');
        return true;
      }
      target[prop] = value;
      return true;
    },
    get(target, prop) {
      return target[prop];
    }
  });

  // Replace ctx.runtime with proxy
  ctx.runtime = runtimeProxy;

  // Start processing
  _timer = setInterval(processTick, TICK_MS);
  _stats.startedAt = Date.now();
  _log('[RCONQueue] queue processor started', 'info');
}

// ─── Public API for sending with explicit priority ───
function sendHighPriority(ctx, serverName, command) {
  const client = ctx.runtime.getChatClient(serverName);
  if (!client) return Promise.resolve();
  return enqueue(client, command, serverName, 'HIGH');
}

// ─── Stats ───
function getStats() {
  const uptimeS = (Date.now() - _stats.startedAt) / 1000;
  return {
    queueSize: _queue.length,
    sent: _stats.sent,
    dropped: _stats.dropped,
    retries: _stats.retries,
    commandsPerSecond: uptimeS > 0 ? Math.round((_stats.sent / uptimeS) * 100) / 100 : 0,
  };
}

// ─── Shutdown ───
function shutdown() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _queue = [];
  _log('[RCONQueue] shutdown', 'info');
}

module.exports = {
  install,
  enqueue,
  sendHighPriority,
  getStats,
  shutdown,
  PRIORITIES,
};
