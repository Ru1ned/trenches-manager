/**
 * Addon: Trenches Raid System
 * Bracket-based raid protection, XP progression, base anchors, stats, and Discord output.
 */
'use strict';

const path = require('path');
const trenchesRaid = require(path.join(__dirname, 'trenchesRaid.js'));
const raidZones = require(path.join(__dirname, 'raidZones.js'));
const playerStats = require(path.join(__dirname, 'playerStats.js'));
const raidDiscord = require(path.join(__dirname, 'raidDiscord.js'));

const submodules = [trenchesRaid, raidZones, playerStats, raidDiscord];

module.exports = {
  name: 'trenchesRaid',
  displayName: 'Trenches Raid System',
  description: 'Advanced raid progression with base detection, brackets, retaliation, and anti-exploit protection.',
  category: 'PvP',
  version: '1.0.0',
  author: 'Trenches',
  core: false,
  requires: ['tribeEnforcer'],
  enabledByDefault: true,

  configSchema: {
    retaliationDurationMinutes: {
      type: 'number', default: 30, label: 'Retaliation Duration', description: 'How long (minutes) a tribe can retaliate after being raided.', min: 5, max: 120,
    },
    raidAlertCooldownSeconds: {
      type: 'number', default: 180, label: 'Raid Alert Cooldown', description: 'Minimum seconds between raid alerts for the same tribe.', min: 30, max: 600,
    },
    whiteFlagDurationMinutes: {
      type: 'number', default: 60, label: 'White Flag Duration', description: 'Protection time (minutes) after losing a raid.', min: 10, max: 360,
    },
    minAnchorStructures: {
      type: 'number', default: 50, label: 'Min Anchor Structures', description: 'Minimum structures required for a valid base anchor.', min: 10, max: 500,
    },
    enableDiscordRaidAlerts: {
      type: 'boolean', default: true, label: 'Discord Raid Alerts', description: 'Post raid events to Discord.',
    },
    statsFlushIntervalSeconds: {
      type: 'number', default: 10, label: 'Stats Flush Interval', description: 'How often (seconds) buffered stats are written to database.', min: 5, max: 60,
    },
    raidWinThreshold: {
      type: 'number', default: 60, label: 'Raid Win Threshold %', description: 'Percentage of structures destroyed to count as a raid win.', min: 30, max: 100,
    },
    bracketMode: {
      type: 'select', default: 'strict', label: 'Bracket Mode', description: 'How bracket raid restrictions are enforced.', options: ['strict', 'relaxed', 'off'],
    },
  },

  _submodules: submodules,

  async init(ctx) {
    for (const mod of submodules) {
      ctx.log(`[trenchesRaid] initializing ${mod.name}...`, 'info');
      await mod.init(ctx);
      ctx.features[mod.name] = mod;
      ctx.log(`[trenchesRaid] ✓ ${mod.name} initialized`, 'success');
    }
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
