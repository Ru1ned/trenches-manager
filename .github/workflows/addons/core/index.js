/**
 * Addon: Core Systems
 * Bundles the three required core features: transferProtection, tribeEnforcer, trenchesChat.
 */
'use strict';

const path = require('path');
const transferProtection = require(path.join(__dirname, 'transferProtection.js'));
const tribeEnforcer = require(path.join(__dirname, 'tribeEnforcer.js'));
const trenchesChat = require(path.join(__dirname, 'trenchesChat.js'));

const submodules = [tribeEnforcer, transferProtection, trenchesChat]; // order matters: tribeEnforcer first (dependency)

module.exports = {
  name: 'core',
  displayName: 'Core Systems',
  description: 'Transfer protection, tribe enforcement, and admin chat — required for all clusters.',
  category: 'Core',
  version: '1.0.0',
  author: 'Trenches',
  core: true,
  enabledByDefault: true,

  // Expose sub-modules so loader can register them individually on ctx.features
  _submodules: submodules,

  async init(ctx) {
    let loaded = 0;
    for (const mod of submodules) {
      try {
        ctx.log(`[core] initializing ${mod.name}...`, 'info');
        await mod.init(ctx);
        ctx.features[mod.name] = mod;
        ctx.log(`[core] ✓ ${mod.name} initialized`, 'success');
        loaded++;
      } catch (err) {
        ctx.log(`[core] ✗ ${mod.name} init failed (non-fatal): ${err.message}`, 'error');
      }
    }
    ctx.log(`[core] ${loaded}/${submodules.length} core submodules loaded`, loaded === submodules.length ? 'success' : 'warn');
  },

  async postInit(runtimeRefs) {
    for (const mod of submodules) {
      if (typeof mod.postInit === 'function') {
        await mod.postInit(runtimeRefs);
      }
    }
  },

  async shutdown() {
    for (const mod of [...submodules].reverse()) {
      if (typeof mod.shutdown === 'function') {
        await mod.shutdown();
      }
    }
  },
};
