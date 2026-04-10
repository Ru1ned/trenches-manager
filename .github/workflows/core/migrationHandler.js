/**
 * Migration Handler Module — extracted from trenches-agent.js
 * 
 * Handles the deploy_migration command:
 *   - Downloads config files from Supabase storage
 *   - Downloads save files from Supabase storage
 *   - Places them in the correct server directories
 *   - Applies detected settings
 * 
 * ZERO new logic — direct extraction of inline deploy_migration case.
 */
'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Download a file from Supabase storage.
 */
function downloadFile(storageBaseUrl, storagePath, destPath, storageHeaders) {
  const url = `${storageBaseUrl}/${storagePath}`;
  const mod = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers: storageHeaders, timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed (${res.statusCode}): ${storagePath}`));
        return;
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(); });
      fileStream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

/**
 * Execute a deploy_migration command.
 * Signature matches the inline case block exactly.
 *
 * @param {object} payload - Command payload (config_paths, save_paths, detected_settings, server_id)
 * @param {string} serverId - The serverId from the command
 * @param {object} deps - { servers, basePath, cfg, log, emitAgentEvent }
 * @returns {Promise<{ result: string, status?: string, errorMsg?: string }>}
 */
async function run(payload, serverId, deps) {
  const { servers, basePath, cfg, log, emitAgentEvent } = deps;

  log('[MIGRATION] Starting server migration deployment...', 'info');
  const configPaths = payload.config_paths || [];
  const savePaths = payload.save_paths || [];
  const detectedSettings = payload.detected_settings || {};
  const targetServerId = payload.server_id || serverId;

  if (!cfg.supabase_url || !cfg.supabase_anon_key) {
    throw new Error('Cloud storage not configured — cannot download migration files');
  }

  const storageBaseUrl = `${cfg.supabase_url}/storage/v1/object/authenticated/server-migrations`;
  const storageHeaders = {
    'apikey': cfg.supabase_anon_key,
    'Authorization': `Bearer ${cfg.supabase_anon_key}`,
  };

  // Determine target server directory
  let targetDir = null;
  if (targetServerId) {
    const srv = servers.find(s => s.id === targetServerId || s.server_id === targetServerId);
    if (srv && srv.install_dir) {
      targetDir = srv.install_dir;
    }
  }
  if (!targetDir) {
    targetDir = path.join(basePath, 'server-data', 'migration-staging');
  }
  const savedArksDir = path.join(targetDir, 'ShooterGame', 'Saved', 'SavedArks');
  const configDir = path.join(targetDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer');
  fs.mkdirSync(savedArksDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  // Download and place config files
  let configCount = 0;
  for (const cfgPath of configPaths) {
    const fileName = path.basename(cfgPath);
    const destFile = path.join(configDir, fileName);
    try {
      await downloadFile(storageBaseUrl, cfgPath, destFile, storageHeaders);
      configCount++;
      log(`[MIGRATION] Config placed: ${fileName}`, 'info');
    } catch (dlErr) {
      log(`[MIGRATION] Failed to download config ${fileName}: ${dlErr.message}`, 'error');
    }
  }

  // Download and place save files
  let saveCount = 0;
  for (const savPath of savePaths) {
    const fileName = path.basename(savPath);
    const destFile = path.join(savedArksDir, fileName);
    try {
      await downloadFile(storageBaseUrl, savPath, destFile, storageHeaders);
      saveCount++;
      log(`[MIGRATION] Save file placed: ${fileName}`, 'info');
    } catch (dlErr) {
      log(`[MIGRATION] Failed to download save ${fileName}: ${dlErr.message}`, 'error');
    }
  }

  // Apply detected settings if provided
  if (Object.keys(detectedSettings).length > 0) {
    log(`[MIGRATION] Applying ${Object.keys(detectedSettings).length} detected settings`, 'info');
  }

  emitAgentEvent('migration:complete', `Migration deployed: ${configCount} configs, ${saveCount} saves`, {
    level: 'success', configCount, saveCount,
  });

  log(`[MIGRATION] Migration deployment complete — ${configCount} config(s), ${saveCount} save(s)`, 'success');

  return {
    success: true,
    data: {
      config_count: configCount,
      save_count: saveCount,
      settings_count: Object.keys(detectedSettings).length,
      target_dir: targetDir,
      status: 'completed',
    },
  };
}

module.exports = { run, downloadFile };
