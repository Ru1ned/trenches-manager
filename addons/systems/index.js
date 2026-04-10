/**
 * Addon: Reward System
 * Handles /link and /redeem in-game commands and reward delivery.
 */
'use strict';

const path = require('path');
const rewardSystem = require(path.join(__dirname, 'rewardSystem.js'));

module.exports = {
  name: 'rewardSystem',
  displayName: 'Reward System',
  description: 'In-game /link and /redeem commands with automatic reward delivery and state tracking.',
  category: 'Economy',
  version: '1.0.0',
  author: 'Trenches',
  core: false,
  requires: ['playerRegistry'],
  enabledByDefault: true,

  async init(ctx) {
    await rewardSystem.init(ctx);
    ctx.features['rewardSystem'] = rewardSystem;
  },

  async postInit(runtimeRefs) {
    if (typeof rewardSystem.postInit === 'function') {
      await rewardSystem.postInit(runtimeRefs);
    }
  },

  getRewardStatus: (...args) => rewardSystem.getRewardStatus(...args),

  async shutdown() {
    if (typeof rewardSystem.shutdown === 'function') {
      await rewardSystem.shutdown();
    }
  },
};
