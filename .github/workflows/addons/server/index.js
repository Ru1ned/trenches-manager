/**
 * Addon: Auto Restart
 * Monitors server processes and restarts crashed servers automatically.
 */
'use strict';

const path = require('path');
const autoRestart = require(path.join(__dirname, 'autoRestart.js'));

module.exports = {
  name: 'autoRestart',
  displayName: 'Auto Restart',
  description: 'Monitors server processes and automatically restarts crashed or stopped servers.',
  category: 'Server',
  version: '1.0.0',
  author: 'Trenches',
  core: false,
  enabledByDefault: true,

  async init(ctx) {
    await autoRestart.init(ctx);
    ctx.features['autoRestart'] = autoRestart;
  },

  async postInit(runtimeRefs) {
    if (typeof autoRestart.postInit === 'function') {
      await autoRestart.postInit(runtimeRefs);
    }
  },

  async shutdown() {
    if (typeof autoRestart.shutdown === 'function') {
      await autoRestart.shutdown();
    }
  },
};
