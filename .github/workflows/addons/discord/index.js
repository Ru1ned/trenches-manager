/**
 * Addon: Discord Alerts
 * Sends critical agent events to Discord via webhook.
 */
'use strict';

const path = require('path');
const discordAlerts = require(path.join(__dirname, 'discordAlerts.js'));

module.exports = {
  name: 'discordAlerts',
  displayName: 'Discord Alerts',
  description: 'Sends critical system events, restarts, and warnings to Discord via webhook.',
  category: 'Discord',
  version: '1.0.0',
  author: 'Trenches',
  core: false,
  enabledByDefault: true,

  configSchema: {
    webhookUrl: {
      type: 'string', default: '', label: 'Discord Webhook URL', description: 'The Discord webhook URL for sending alerts.',
    },
    alertOnRestart: {
      type: 'boolean', default: true, label: 'Alert on Restart', description: 'Send notification when a server restarts.',
    },
    alertOnCrash: {
      type: 'boolean', default: true, label: 'Alert on Crash', description: 'Send notification when a server crashes.',
    },
    mentionRole: {
      type: 'string', default: '', label: 'Mention Role ID', description: 'Discord role ID to mention in critical alerts (leave empty to disable).',
    },
  },

  async init(ctx) {
    await discordAlerts.init(ctx);
    ctx.features['discordAlerts'] = discordAlerts;
  },

  async postInit(runtimeRefs) {
    if (typeof discordAlerts.postInit === 'function') {
      await discordAlerts.postInit(runtimeRefs);
    }
  },

  async shutdown() {
    if (typeof discordAlerts.shutdown === 'function') {
      await discordAlerts.shutdown();
    }
  },
};
