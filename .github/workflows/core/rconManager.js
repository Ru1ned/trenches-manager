/**
 * RCON Manager Module — extracted from trenches-agent.js
 * 
 * This is a PLACEHOLDER module for future extraction.
 * The RCON logic in trenches-agent.js is tightly coupled to
 * server state and the command handler. This module documents
 * the interface for when a full extraction is safe.
 * 
 * Current RCON functions in the main agent:
 *   - rconConnect(host, port, password)
 *   - rconSend(connection, command)
 *   - broadcastRcon(ctx, message)
 *   - Various rcon_command handlers in the switch
 * 
 * ZERO new logic — interface definition only.
 */
'use strict';

/**
 * Broadcast a message to all running servers via RCON.
 * This is a thin wrapper — actual implementation stays in main agent.
 * @param {object} ctx - { servers, rconSend, rconConnect, log }
 * @param {string} message - Message to broadcast
 */
function broadcastMessage(ctx, message) {
  // Placeholder — will delegate to main agent's broadcastRcon()
  if (ctx && ctx.log) {
    ctx.log(`[RCON] Broadcast: ${message}`, 'info');
  }
}

module.exports = {
  broadcastMessage,
};
