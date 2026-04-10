/**
 * Addon: Purge Weekend
 * Toggles ORP based on configured purge days.
 */
'use strict';

const path = require('path');
const purgeWeekend = require(path.join(__dirname, 'purgeWeekend.js'));

module.exports = {
  name: 'purgeWeekend',
  displayName: 'Purge Weekend',
  description: 'Toggles Offline Raid Protection on/off based on configured purge schedule.',
  category: 'Events',
  version: '1.0.0',
  author: 'Trenches',
  core: false,
  enabledByDefault: true,

  configSchema: {
    purgeStartDay: {
      type: 'select', default: 'Friday', label: 'Purge Start Day', description: 'Day of the week when purge begins.', options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    },
    purgeEndDay: {
      type: 'select', default: 'Sunday', label: 'Purge End Day', description: 'Day of the week when purge ends.', options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    },
    purgeStartHour: {
      type: 'number', default: 18, label: 'Start Hour (24h)', description: 'Hour of the day purge starts (0-23).', min: 0, max: 23,
    },
    purgeEndHour: {
      type: 'number', default: 22, label: 'End Hour (24h)', description: 'Hour of the day purge ends (0-23).', min: 0, max: 23,
    },
    announceInChat: {
      type: 'boolean', default: true, label: 'In-Game Announcement', description: 'Send purge start/end messages in game chat.',
    },
  },

  async init(ctx) {
    await purgeWeekend.init(ctx);
    ctx.features['purgeWeekend'] = purgeWeekend;
  },

  async postInit(runtimeRefs) {
    if (typeof purgeWeekend.postInit === 'function') {
      await purgeWeekend.postInit(runtimeRefs);
    }
  },

  getPurgeStatus: (...args) => purgeWeekend.getPurgeStatus(...args),
  updateConfig: (...args) => purgeWeekend.updateConfig(...args),

  async shutdown() {
    if (typeof purgeWeekend.shutdown === 'function') {
      await purgeWeekend.shutdown();
    }
  },
};
