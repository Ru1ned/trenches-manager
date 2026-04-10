/**
 * Discord Alerts Feature Module v1.0
 * Sends critical agent events to a Discord channel via webhook or bot.
 * 
 * Supports:
 *   - Event filtering (only important events)
 *   - Message queue with batching
 *   - Cooldown (anti-spam)
 *   - Retry on failure
 *   - Rich embeds
 *   - Future: slash commands, shop integration
 * 
 * Config (settings table):
 *   discord_webhook_url  — Discord webhook URL
 *   discord_bot_token    — (future) Bot token for discord.js
 *   discord_channel_id   — (future) Channel ID for bot mode
 *   discord_alerts_enabled — 'true'/'false'
 *   discord_cooldown_ms  — Minimum ms between messages (default: 5000)
 *   discord_batch_delay_ms — Batch window before flush (default: 3000)
 */
'use strict';

const name = 'discordAlerts';
const core = false;
const requires = [];

// ─── State ───
let _ctx = null;
let _webhookUrl = null;
let _cooldownMs = 5000;
let _batchDelayMs = 3000;
let _maxRetries = 3;
let _queue = [];       // { embed, timestamp }
let _flushTimer = null;
let _lastSentAt = 0;
let _stats = { sent: 0, failed: 0, dropped: 0, batched: 0 };

// ─── Event filter — only forward important events ───
const ALERT_EVENT_TYPES = new Set([
  'system:critical',
  'system:degraded',
  'command:failed',
  'reward:failed',
  'migration:failed',
  'server:crash',
  'server:create:error',
  'server:auto_fix_failed',
  'server:start:failed',
]);

// Severity colors for Discord embeds
const SEVERITY_COLORS = {
  critical: 0xFF0000,  // Red
  error:    0xFF4444,  // Light red
  warning:  0xFFA500,  // Orange
  info:     0x3498DB,  // Blue
  success:  0x2ECC71,  // Green
};

/**
 * Build a Discord embed from an agent event.
 */
function buildEmbed(eventType, message, meta = {}) {
  const level = meta.level || 'error';
  const color = SEVERITY_COLORS[level] || SEVERITY_COLORS.error;

  const embed = {
    title: `⚠️ ${eventType}`,
    description: String(message).slice(0, 2000),
    color,
    timestamp: new Date().toISOString(),
    footer: { text: 'Trenches Server Manager' },
    fields: [],
  };

  if (meta.serverName) {
    embed.fields.push({ name: 'Server', value: String(meta.serverName), inline: true });
  }
  if (meta.error) {
    embed.fields.push({ name: 'Error', value: String(meta.error).slice(0, 1024), inline: false });
  }
  if (meta.feature) {
    embed.fields.push({ name: 'Feature', value: String(meta.feature), inline: true });
  }

  return embed;
}

/**
 * Send embeds to Discord webhook with retry.
 */
async function sendWebhook(embeds, attempt = 1) {
  if (!_webhookUrl) return;

  const body = JSON.stringify({ embeds: embeds.slice(0, 10) }); // Discord limit: 10 embeds

  try {
    const url = new URL(_webhookUrl);
    const mod = url.protocol === 'https:' ? require('https') : require('http');

    await new Promise((resolve, reject) => {
      const req = mod.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 429) {
            // Rate limited — extract retry_after
            try {
              const parsed = JSON.parse(data);
              const retryAfter = (parsed.retry_after || 5) * 1000;
              if (_ctx && _ctx.log) _ctx.log(`[Discord] Rate limited — retrying in ${retryAfter}ms`, 'warn');
              setTimeout(() => sendWebhook(embeds, attempt + 1).catch(() => {}), retryAfter);
            } catch {
              reject(new Error('Rate limited'));
            }
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Discord webhook returned ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Webhook timeout')); });
      req.write(body);
      req.end();
    });

    _stats.sent += embeds.length;
    _lastSentAt = Date.now();
  } catch (err) {
    if (attempt < _maxRetries) {
      const backoff = Math.min(attempt * 2000, 10000);
      if (_ctx && _ctx.log) _ctx.log(`[Discord] Send failed (attempt ${attempt}/${_maxRetries}), retrying in ${backoff}ms: ${err.message}`, 'warn');
      await new Promise(r => setTimeout(r, backoff));
      return sendWebhook(embeds, attempt + 1);
    }
    _stats.failed += embeds.length;
    if (_ctx && _ctx.log) _ctx.log(`[Discord] Send failed after ${_maxRetries} attempts: ${err.message}`, 'error');
  }
}

/**
 * Flush the message queue — batches embeds into a single webhook call.
 */
async function flushQueue() {
  _flushTimer = null;
  if (_queue.length === 0) return;

  // Cooldown check
  const elapsed = Date.now() - _lastSentAt;
  if (elapsed < _cooldownMs) {
    const wait = _cooldownMs - elapsed;
    _flushTimer = setTimeout(() => flushQueue(), wait);
    return;
  }

  // Take up to 10 embeds (Discord limit)
  const batch = _queue.splice(0, 10);
  _stats.batched++;

  const embeds = batch.map(item => item.embed);
  await sendWebhook(embeds);

  // If more items remain, schedule another flush
  if (_queue.length > 0) {
    _flushTimer = setTimeout(() => flushQueue(), _cooldownMs);
  }
}

/**
 * Enqueue an event for Discord delivery.
 */
function enqueueAlert(eventType, message, meta = {}) {
  if (!_webhookUrl) return;

  // Check if this event type should be forwarded
  if (!ALERT_EVENT_TYPES.has(eventType)) return;

  // Check enabled
  if (_ctx && _ctx.settings) {
    const enabled = _ctx.settings.get('discord_alerts_enabled', 'true');
    if (enabled !== 'true') return;
  }

  // Queue cap — drop oldest if full
  if (_queue.length >= 50) {
    _queue.shift();
    _stats.dropped++;
  }

  const embed = buildEmbed(eventType, message, meta);
  _queue.push({ embed, timestamp: Date.now() });

  // Schedule flush if not already pending
  if (!_flushTimer) {
    _flushTimer = setTimeout(() => flushQueue(), _batchDelayMs);
  }
}

/**
 * Get alert system status for diagnostics.
 */
function getAlertStatus() {
  return {
    enabled: !!_webhookUrl,
    webhook_configured: !!_webhookUrl,
    queue_size: _queue.length,
    cooldown_ms: _cooldownMs,
    batch_delay_ms: _batchDelayMs,
    stats: { ..._stats },
    last_sent_at: _lastSentAt ? new Date(_lastSentAt).toISOString() : null,
    monitored_events: Array.from(ALERT_EVENT_TYPES),
  };
}

/**
 * Update webhook URL at runtime.
 */
function setWebhookUrl(url) {
  if (url && typeof url === 'string' && url.startsWith('https://discord.com/api/webhooks/')) {
    _webhookUrl = url;
    if (_ctx && _ctx.settings) _ctx.settings.set('discord_webhook_url', url);
    if (_ctx && _ctx.log) _ctx.log('[Discord] Webhook URL updated', 'success');
    return true;
  }
  return false;
}

/**
 * Send a test alert to verify webhook configuration.
 */
async function sendTestAlert() {
  if (!_webhookUrl) return { success: false, error: 'No webhook URL configured' };
  const embed = buildEmbed('test:alert', 'This is a test alert from Trenches Server Manager.', { level: 'info' });
  try {
    await sendWebhook([embed]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Lifecycle ───

function init(ctx) {
  _ctx = ctx;

  // Load config from settings
  _webhookUrl = ctx.settings.get('discord_webhook_url', null);
  _cooldownMs = parseInt(ctx.settings.get('discord_cooldown_ms', '5000')) || 5000;
  _batchDelayMs = parseInt(ctx.settings.get('discord_batch_delay_ms', '3000')) || 3000;

  ctx.log(`[Discord] Alerts initialized — webhook=${_webhookUrl ? 'configured' : 'not set'}`, 'info');
}

function postInit(runtimeRefs) {
  // Hook into the agent's event system if available
  // The main agent calls enqueueAlert() when emitAgentEvent fires
}

function shutdown() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  // Flush remaining
  if (_queue.length > 0 && _webhookUrl) {
    const embeds = _queue.splice(0, 10).map(i => i.embed);
    sendWebhook(embeds).catch(() => {});
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
  enqueueAlert,
  getAlertStatus,
  setWebhookUrl,
  sendTestAlert,
  buildEmbed,

  // For external integration
  ALERT_EVENT_TYPES,
};
