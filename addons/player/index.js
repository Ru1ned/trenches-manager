/**
 * Addon: Player Registry
 * Live player tracking and resolution across all servers.
 */
'use strict';

const path = require('path');
const playerRegistry = require(path.join(__dirname, 'playerRegistry.js'));

module.exports = {
  name: 'playerRegistry',
  displayName: 'Player Registry',
  description: 'Live player tracking and name/EOS ID resolution across all servers.',
  category: 'Players',
  version: '1.0.0',
  author: 'Trenches',
  core: false,
  enabledByDefault: true,

  async init(ctx) {
    await playerRegistry.init(ctx);
    ctx.features['playerRegistry'] = playerRegistry;
  },

  async postInit(runtimeRefs) {
    if (typeof playerRegistry.postInit === 'function') {
      await playerRegistry.postInit(runtimeRefs);
    }
  },

  async shutdown() {
    if (typeof playerRegistry.shutdown === 'function') {
      await playerRegistry.shutdown();
    }
  },
};
