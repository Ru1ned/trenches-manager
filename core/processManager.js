/**
 * Process Manager Module — extracted from trenches-agent.js
 * 
 * Phase 2: Port utility functions only.
 * Process registry remains inline (too many direct global references).
 * 
 * Contains:
 *   - isPortInUseAsync (socket-based port check)
 *   - validatePortsPreStartAsync (pre-start port validation)
 * 
 * ZERO new logic — direct extraction.
 */
'use strict';

const net = require('net');

/**
 * v42.0: Socket-based port check — fast, async, no shell dependencies.
 * @param {number} port
 * @param {Set} systemReservedPorts
 * @param {Set} reservedPorts - agent's pending-start reserved ports
 * @returns {Promise<boolean>}
 */
function isPortInUseAsync(port, systemReservedPorts, reservedPorts) {
  return new Promise((resolve) => {
    if (systemReservedPorts.has(port) || reservedPorts.has(port)) return resolve(true);
    const server = net.createServer();
    server.once('error', (err) => {
      server.close();
      resolve(err.code === 'EADDRINUSE');
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    // Timeout safety — if socket hangs, assume free
    const timer = setTimeout(() => { try { server.close(); } catch {} resolve(false); }, 2000);
    server.once('close', () => clearTimeout(timer));
    try { server.listen(port, '127.0.0.1'); }
    catch { resolve(true); }
  });
}

/**
 * v42.0: Async pre-start port validation using socket probing.
 * @param {object} srv - server object with game_port, query_port, rcon_port
 * @param {Map} spawnedPids
 * @param {Set} systemReservedPorts
 * @param {Set} reservedPorts
 * @returns {Promise<string|null>} error message or null if all clear
 */
async function validatePortsPreStartAsync(srv, spawnedPids, systemReservedPorts, reservedPorts) {
  const ports = [
    { port: srv.game_port || srv.port, type: 'game' },
    { port: srv.query_port, type: 'query' },
    { port: srv.rcon_port, type: 'rcon' },
  ];
  const sid = srv.server_id || srv.id || srv.name;
  const ownPid = spawnedPids.get(sid) || spawnedPids.get(srv.name);

  for (const p of ports) {
    if (!p.port) continue;
    if (systemReservedPorts.has(p.port)) return `${p.type} port ${p.port} is a reserved system port`;
    if (!ownPid) {
      const inUse = await isPortInUseAsync(p.port, systemReservedPorts, reservedPorts);
      if (inUse) return `${p.type} port ${p.port} already in use`;
    }
  }
  return null;
}

module.exports = {
  isPortInUseAsync,
  validatePortsPreStartAsync,
};
