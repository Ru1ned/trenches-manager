/**
 * Addon Loader v2.0
 * Production-ready addon platform with hot reload, enable/disable, and persistent config.
 *
 * Each addon exports: { name, displayName, description, category, version, author, core, enabledByDefault, init, postInit?, shutdown? }
 */
'use strict';

const path = require('path');
const fs = require('fs');

// ─── Registry & State ───
const _registry = new Map();       // name → { mod, started, phase, meta, dir, indexPath }
const _discovered = new Map();     // name → { dir, mod, indexPath } — all found addons (even disabled)
const _failedAddons = [];          // { name, reason }
const REQUIRED_CORE = ['core'];    // addon names that MUST load
const REQUIRED_FIELDS = ['name', 'init'];
const RECOMMENDED_FIELDS = ['displayName', 'description', 'category', 'version', 'author'];

let _agentRefs = null;
let _addonsDir = null;
let _configPath = null;
let _addonConfigDir = null;        // /config/addons/ — per-addon config files
let _ctx = null;
let _runtimeRefs = null;
let _log = console.log;

// ─── Per-Addon Config System ───

function _ensureAddonConfigDir() {
  if (!_addonConfigDir) return;
  try {
    if (!fs.existsSync(_addonConfigDir)) fs.mkdirSync(_addonConfigDir, { recursive: true });
  } catch {}
}

function _getAddonConfigPath(addonName) {
  if (!_addonConfigDir) return null;
  return path.join(_addonConfigDir, `${addonName}.json`);
}

function _loadAddonConfig(addonName) {
  const cfgPath = _getAddonConfigPath(addonName);
  if (!cfgPath) return {};
  try {
    if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  return {};
}

function _saveAddonConfig(addonName, values) {
  _ensureAddonConfigDir();
  const cfgPath = _getAddonConfigPath(addonName);
  if (!cfgPath) return;
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(values, null, 2), 'utf8');
  } catch (err) {
    _log(`[ADDONS] Failed to save config for ${addonName}: ${err.message}`, 'warn');
  }
}

/**
 * Merge schema defaults with saved config (saved values take precedence).
 */
function _resolveAddonConfig(addonName, schema) {
  if (!schema || typeof schema !== 'object') return {};
  const saved = _loadAddonConfig(addonName);
  const resolved = {};
  for (const [key, def] of Object.entries(schema)) {
    resolved[key] = saved.hasOwnProperty(key) ? saved[key] : def.default;
  }
  return resolved;
}

/**
 * Validate a value against a schema field definition.
 * Returns { valid, reason? }
 */
function _validateConfigValue(key, value, fieldDef) {
  if (!fieldDef) return { valid: false, reason: `Unknown config key: ${key}` };
  const t = fieldDef.type;
  if (t === 'boolean' && typeof value !== 'boolean') return { valid: false, reason: `${key} must be boolean` };
  if (t === 'number') {
    if (typeof value !== 'number' || isNaN(value)) return { valid: false, reason: `${key} must be a number` };
    if (fieldDef.min !== undefined && value < fieldDef.min) return { valid: false, reason: `${key} must be >= ${fieldDef.min}` };
    if (fieldDef.max !== undefined && value > fieldDef.max) return { valid: false, reason: `${key} must be <= ${fieldDef.max}` };
  }
  if (t === 'string' && typeof value !== 'string') return { valid: false, reason: `${key} must be a string` };
  if (t === 'select') {
    if (!fieldDef.options || !fieldDef.options.includes(value)) return { valid: false, reason: `${key} must be one of: ${(fieldDef.options || []).join(', ')}` };
  }
  return { valid: true };
}

/**
 * Build the ctx.config namespace for addon config access.
 */
function _buildConfigCtx() {
  return {
    get(addonName, key) {
      const entry = _registry.get(addonName) || _discovered.get(addonName);
      const mod = entry ? (entry.mod) : null;
      const schema = mod && mod.configSchema ? mod.configSchema : {};
      const resolved = _resolveAddonConfig(addonName, schema);
      return key ? resolved[key] : undefined;
    },
    set(addonName, key, value) {
      const entry = _registry.get(addonName) || _discovered.get(addonName);
      const mod = entry ? (entry.mod) : null;
      const schema = mod && mod.configSchema ? mod.configSchema : {};
      if (schema[key]) {
        const v = _validateConfigValue(key, value, schema[key]);
        if (!v.valid) { _log(`[ADDONS] config validation failed: ${v.reason}`, 'warn'); return false; }
      }
      const current = _loadAddonConfig(addonName);
      current[key] = value;
      _saveAddonConfig(addonName, current);
      return true;
    },
    getAll(addonName) {
      const entry = _registry.get(addonName) || _discovered.get(addonName);
      const mod = entry ? (entry.mod) : null;
      const schema = mod && mod.configSchema ? mod.configSchema : {};
      return _resolveAddonConfig(addonName, schema);
    },
  };
}

// ─── Persistent Config ───

function loadConfig() {
  if (!_configPath) return {};
  try {
    if (fs.existsSync(_configPath)) {
      return JSON.parse(fs.readFileSync(_configPath, 'utf8'));
    }
  } catch {}
  return {};
}

function saveConfig(cfg) {
  if (!_configPath) return;
  try {
    const dir = path.dirname(_configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(_configPath, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    _log(`[ADDONS] Failed to save config: ${err.message}`, 'warn');
  }
}

function getConfig() {
  const cfg = loadConfig();
  // Force core addons enabled
  for (const name of REQUIRED_CORE) {
    cfg[name] = true;
  }
  return cfg;
}

function setAddonEnabled(name, enabled) {
  const cfg = loadConfig();
  cfg[name] = enabled;
  // Never disable core
  for (const n of REQUIRED_CORE) cfg[n] = true;
  saveConfig(cfg);
}

function ensureDefaultConfig() {
  if (_configPath && !fs.existsSync(_configPath)) {
    const defaults = {};
    for (const [name, info] of _discovered) {
      defaults[name] = info.mod.core === true || info.mod.enabledByDefault !== false;
    }
    for (const n of REQUIRED_CORE) defaults[n] = true;
    saveConfig(defaults);
    _log('[ADDONS] created default addons.json config', 'info');
  }
}

// ─── Validation ───

function validateAddon(mod, dir) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (field === 'init' && typeof mod[field] !== 'function') errors.push(`missing ${field}()`);
    else if (field !== 'init' && !mod[field]) errors.push(`missing ${field}`);
  }
  const warnings = [];
  for (const field of RECOMMENDED_FIELDS) {
    if (!mod[field]) warnings.push(field);
  }
  return { valid: errors.length === 0, errors, warnings };
}

// ─── Context Builder ───

function buildStructuredCtx(raw) {
  return {
    db: {
      instance: () => raw.db(),
      query: (sql, ...params) => { const db = raw.db(); const stmt = db.prepare(sql); return params.length > 0 ? stmt.all(...params) : stmt.all(); },
      run: (sql, ...params) => raw.db().prepare(sql).run(...params),
      get: (sql, ...params) => raw.db().prepare(sql).get(...params),
    },
    commands: { enqueue: (fn, desc, opts) => raw.enqueueHeavyCommand(fn, desc, opts) },
    servers: { list: () => raw.getServers() },
    events: { emit: (event, message, meta) => raw.emitAgentEvent(event, message, meta) },
    settings: {
      get: (key, fallback) => raw.getSetting(key, fallback),
      set: (key, value) => raw.setSetting(key, value),
      isEnabled: (key) => raw.isFeatureEnabled(key),
    },
    system: {
      getPressure: () => raw.getSystemPressure(),
      isCircuitBreakerOpen: () => raw.isCircuitBreakerOpen(),
      isServerLocked: (serverId) => raw.isServerLocked(serverId),
    },
    log: raw.log,
    config: _buildConfigCtx(),
    features: _ctx ? _ctx.features : {},
    runtime: _ctx ? _ctx.runtime : {},
  };
}

// ─── Dependency Resolution ───

function getProvidedNames() {
  const provided = new Set();
  for (const [name, entry] of _registry) {
    provided.add(name);
    if (entry.mod._submodules) {
      for (const sub of entry.mod._submodules) provided.add(sub.name || sub);
    }
  }
  // Also include discovered (for enable checks)
  for (const [name, info] of _discovered) {
    provided.add(name);
    if (info.mod._submodules) {
      for (const sub of info.mod._submodules) provided.add(sub.name || sub);
    }
  }
  return provided;
}

function getActiveProvided() {
  const provided = new Set();
  for (const [name, entry] of _registry) {
    provided.add(name);
    if (entry.mod._submodules) {
      for (const sub of entry.mod._submodules) provided.add(sub.name || sub);
    }
  }
  return provided;
}

function getDependents(addonName) {
  const dependents = [];
  const entry = _registry.get(addonName);
  const providerNames = new Set([addonName]);
  if (entry && entry.mod._submodules) {
    for (const sub of entry.mod._submodules) providerNames.add(sub.name || sub);
  }
  for (const [name, reg] of _registry) {
    if (name === addonName) continue;
    const reqs = reg.mod.requires || [];
    for (const req of reqs) {
      if (providerNames.has(req)) {
        dependents.push(name);
        break;
      }
    }
  }
  return dependents;
}

function resolveOrder(addons, log) {
  const byName = new Map();
  const graph = new Map();
  const allNames = new Set();

  for (const a of addons) {
    byName.set(a.mod.name, a);
    allNames.add(a.mod.name);
    graph.set(a.mod.name, new Set(a.mod.requires || []));
  }

  const providedNames = new Set(allNames);
  for (const a of addons) {
    if (a.mod._submodules) {
      for (const sub of a.mod._submodules) providedNames.add(sub.name || sub);
    }
  }
  // Also include already-loaded addons as providers
  for (const [name, entry] of _registry) {
    providedNames.add(name);
    if (entry.mod._submodules) {
      for (const sub of entry.mod._submodules) providedNames.add(sub.name || sub);
    }
  }

  const excluded = new Set();
  for (const [name, deps] of graph) {
    for (const dep of deps) {
      if (!providedNames.has(dep)) {
        log(`[ADDONS] ✗ "${name}" disabled — missing dependency "${dep}"`, 'error');
        _failedAddons.push({ name, reason: `missing dependency: ${dep}` });
        excluded.add(name);
      }
    }
  }

  const sorted = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(name) {
    if (visited.has(name)) return true;
    if (visiting.has(name)) return false;
    if (excluded.has(name)) return false;
    visiting.add(name);
    for (const dep of (graph.get(name) || [])) {
      const provider = findProvider(dep, addons);
      if (provider && !visit(provider)) return false;
    }
    visiting.delete(name);
    visited.add(name);
    if (allNames.has(name)) sorted.push(name);
    return true;
  }

  for (const name of allNames) {
    if (!excluded.has(name)) visit(name);
  }

  return sorted;
}

function findProvider(depName, addons) {
  for (const a of addons) {
    if (a.mod.name === depName) return a.mod.name;
  }
  for (const a of addons) {
    if (a.mod._submodules) {
      for (const sub of a.mod._submodules) {
        if ((sub.name || sub) === depName) return a.mod.name;
      }
    }
  }
  return null;
}

// ─── Require Cache Clearing ───

function clearRequireCache(dirPath) {
  const resolved = path.resolve(dirPath);
  const toDelete = [];
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(resolved)) toDelete.push(key);
  }
  for (const key of toDelete) delete require.cache[key];
  return toDelete.length;
}

// ─── Core Lifecycle ───

async function loadAddons({ addonsDir, enabledAddons, agentRefs, log: logFn }) {
  _agentRefs = agentRefs;
  _addonsDir = addonsDir;
  _configPath = path.join(addonsDir, '..', 'config', 'addons.json');
  _addonConfigDir = path.join(addonsDir, '..', 'config', 'addons');
  _ensureAddonConfigDir();
  _log = logFn || console.log;
  _failedAddons.length = 0;
  _registry.clear();
  _discovered.clear();

  if (!fs.existsSync(addonsDir)) {
    _log('[ADDONS] Addons directory not found: ' + addonsDir, 'warn');
    return;
  }

  // Phase 1: DISCOVER
  const dirs = fs.readdirSync(addonsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  _log(`[ADDONS] scanning addons... found ${dirs.length} folders`, 'info');

  for (const dir of dirs) {
    const indexPath = path.join(addonsDir, dir, 'index.js');
    if (!fs.existsSync(indexPath)) {
      _log(`[ADDONS] skipping "${dir}" — no index.js`, 'warn');
      continue;
    }
    try {
      const mod = require(indexPath);
      const validation = validateAddon(mod, dir);
      if (!validation.valid) {
        _log(`[ADDONS] ✗ "${dir}" validation failed: ${validation.errors.join(', ')}`, 'error');
        _failedAddons.push({ name: dir, reason: `validation: ${validation.errors.join(', ')}` });
        continue;
      }
      if (validation.warnings.length) {
        _log(`[ADDONS] ⚠ "${dir}" missing recommended fields: ${validation.warnings.join(', ')}`, 'warn');
      }
      _discovered.set(mod.name, { dir, mod, indexPath });
      _log(`[ADDONS] found: ${mod.displayName || mod.name} (${mod.category || 'uncategorized'})`, 'info');
    } catch (err) {
      _log(`[ADDONS] ✗ "${dir}" require failed: ${err.message}`, 'error');
      _failedAddons.push({ name: dir, reason: `require error: ${err.message}` });
    }
  }

  // Ensure default config exists
  ensureDefaultConfig();

  // Phase 2: FILTER — merge persistent config + enabledAddons
  const config = getConfig();
  const enabledSet = new Set(enabledAddons || []);

  const toLoad = [];
  for (const [name, info] of _discovered) {
    if (info.mod.core === true) { toLoad.push(info); continue; }
    // Config takes priority, then enabledAddons param, then enabledByDefault
    if (config[name] === true) { toLoad.push(info); continue; }
    if (config[name] === false) continue;
    if (enabledSet.has(name) || info.mod.enabledByDefault !== false) { toLoad.push(info); continue; }
  }

  const skipped = [..._discovered.values()].filter(a => !toLoad.includes(a));
  if (skipped.length) {
    _log(`[ADDONS] skipped (disabled): ${skipped.map(a => a.mod.name).join(', ')}`, 'info');
  }

  // Phase 3: RESOLVE order
  const loadOrder = resolveOrder(toLoad, _log);

  // Phase 4: BUILD context
  _ctx = buildStructuredCtx(agentRefs);

  // Phase 5: INIT
  _log(`[ADDONS] loading ${loadOrder.length} addon(s)...`, 'info');
  for (const name of loadOrder) {
    const entry = toLoad.find(a => a.mod.name === name);
    if (!entry) continue;
    await _initSingleAddon(entry);
  }

  _log(`[ADDONS] ${_registry.size}/${toLoad.length} addon(s) loaded`, 'info');

  // Phase 6: CORE VALIDATION
  for (const req of REQUIRED_CORE) {
    if (!_registry.has(req)) {
      const msg = `CRITICAL: Required addon "${req}" failed to load`;
      _log(`[ADDONS] ✗ ${msg}`, 'error');
      try { agentRefs.emitAgentEvent('system:critical', msg, { level: 'error' }); } catch {}
    }
  }
}

async function _initSingleAddon(entry) {
  const name = entry.mod.name;
  try {
    _log(`[ADDONS] loading: ${entry.mod.displayName || name}...`, 'info');
    await entry.mod.init(_ctx);
    _registry.set(name, {
      mod: entry.mod,
      started: Date.now(),
      phase: 'initialized',
      dir: entry.dir,
      indexPath: entry.indexPath,
      meta: {
        displayName: entry.mod.displayName || name,
        description: entry.mod.description || '',
        category: entry.mod.category || 'Other',
        version: entry.mod.version || '0.0.0',
        author: entry.mod.author || 'Unknown',
        core: entry.mod.core === true,
        enabledByDefault: entry.mod.enabledByDefault !== false,
      },
    });
    _ctx.features[name] = entry.mod;
    _log(`[ADDONS] ✓ ${entry.mod.displayName || name} loaded`, 'success');
    return true;
  } catch (err) {
    _log(`[ADDONS] ✗ "${name}" init failed: ${err.message}`, 'error');
    _failedAddons.push({ name, reason: `init error: ${err.message}` });
    return false;
  }
}

// ─── Post-Init ───

async function postInitAddons(runtimeRefs, log) {
  _runtimeRefs = runtimeRefs;
  const logFn = log || _log;
  for (const [name, entry] of _registry) {
    if (typeof entry.mod.postInit === 'function') {
      try {
        await entry.mod.postInit(runtimeRefs);
        entry.phase = 'running';
        logFn(`[ADDONS] ✓ ${name} postInit complete`, 'success');
      } catch (err) {
        logFn(`[ADDONS] ✗ "${name}" postInit failed: ${err.message}`, 'error');
        _failedAddons.push({ name, reason: `postInit error: ${err.message}` });
      }
    } else {
      entry.phase = 'running';
    }
  }
}

// ─── Runtime Controls ───

async function enableAddon(name) {
  // Already loaded?
  if (_registry.has(name)) return { success: true, message: 'Already enabled' };

  // Core check
  if (REQUIRED_CORE.includes(name) && _registry.has(name)) return { success: true, message: 'Core addon always enabled' };

  // Check discovered
  const info = _discovered.get(name);
  if (!info) return { success: false, message: `Addon "${name}" not found` };

  // Check dependencies
  const requires = info.mod.requires || [];
  const active = getActiveProvided();
  for (const dep of requires) {
    if (!active.has(dep)) {
      return { success: false, message: `Cannot enable: dependency "${dep}" not active` };
    }
  }

  // Init
  const ok = await _initSingleAddon(info);
  if (!ok) return { success: false, message: `Init failed for "${name}"` };

  // PostInit if runtime is available
  if (_runtimeRefs && typeof info.mod.postInit === 'function') {
    try {
      await info.mod.postInit(_runtimeRefs);
      const entry = _registry.get(name);
      if (entry) entry.phase = 'running';
    } catch (err) {
      _log(`[ADDONS] ✗ "${name}" postInit failed: ${err.message}`, 'error');
    }
  } else {
    const entry = _registry.get(name);
    if (entry) entry.phase = 'running';
  }

  // Persist
  setAddonEnabled(name, true);
  _log(`[ADDONS] enabled: ${name}`, 'success');
  return { success: true, message: `Addon "${name}" enabled` };
}

async function disableAddon(name) {
  // Block core
  if (REQUIRED_CORE.includes(name)) {
    return { success: false, message: `Cannot disable core addon "${name}"` };
  }

  const entry = _registry.get(name);
  if (!entry) return { success: false, message: `Addon "${name}" not loaded` };

  // Block if dependents exist
  const dependents = getDependents(name);
  if (dependents.length > 0) {
    return { success: false, message: `Cannot disable: ${dependents.join(', ')} depend on it` };
  }

  // Shutdown
  if (typeof entry.mod.shutdown === 'function') {
    try { await entry.mod.shutdown(); } catch (err) {
      _log(`[ADDONS] ${name} shutdown error: ${err.message}`, 'warn');
    }
  }

  // Remove from registry and ctx.features
  _registry.delete(name);
  if (_ctx && _ctx.features[name]) delete _ctx.features[name];
  // Also remove sub-module features
  if (entry.mod._submodules) {
    for (const sub of entry.mod._submodules) {
      const subName = sub.name || sub;
      if (_ctx && _ctx.features[subName]) delete _ctx.features[subName];
    }
  }

  // Persist
  setAddonEnabled(name, false);
  _log(`[ADDONS] disabled: ${name}`, 'success');
  return { success: true, message: `Addon "${name}" disabled` };
}

async function reloadAddon(name) {
  // Block core reload
  if (REQUIRED_CORE.includes(name)) {
    return { success: false, message: `Cannot hot-reload core addon "${name}" — requires agent restart` };
  }

  const entry = _registry.get(name);
  const info = _discovered.get(name);
  if (!entry && !info) return { success: false, message: `Addon "${name}" not found` };

  const addonDir = entry ? path.join(_addonsDir, entry.dir) : path.join(_addonsDir, info.dir);
  const indexPath = entry ? entry.indexPath : info.indexPath;

  // Step 1: Shutdown existing
  if (entry) {
    if (typeof entry.mod.shutdown === 'function') {
      try { await entry.mod.shutdown(); } catch (err) {
        _log(`[ADDONS] ${name} shutdown error during reload: ${err.message}`, 'warn');
      }
    }
    _registry.delete(name);
    if (_ctx && _ctx.features[name]) delete _ctx.features[name];
    if (entry.mod._submodules) {
      for (const sub of entry.mod._submodules) {
        const subName = sub.name || sub;
        if (_ctx && _ctx.features[subName]) delete _ctx.features[subName];
      }
    }
  }

  // Step 2: Clear require cache
  const cleared = clearRequireCache(addonDir);
  _log(`[ADDONS] cleared ${cleared} cached module(s) for ${name}`, 'info');

  // Step 3: Re-require
  let newMod;
  try {
    newMod = require(indexPath);
  } catch (err) {
    _log(`[ADDONS] ✗ "${name}" reload require failed: ${err.message}`, 'error');
    return { success: false, message: `Require failed: ${err.message}` };
  }

  const validation = validateAddon(newMod, info ? info.dir : name);
  if (!validation.valid) {
    return { success: false, message: `Validation failed: ${validation.errors.join(', ')}` };
  }

  // Update discovered
  const dir = info ? info.dir : (entry ? entry.dir : name);
  _discovered.set(newMod.name, { dir, mod: newMod, indexPath });

  // Step 4: Init
  const ok = await _initSingleAddon({ dir, mod: newMod, indexPath });
  if (!ok) return { success: false, message: `Init failed for "${name}" during reload` };

  // Step 5: PostInit
  if (_runtimeRefs && typeof newMod.postInit === 'function') {
    try {
      await newMod.postInit(_runtimeRefs);
      const reloaded = _registry.get(name);
      if (reloaded) reloaded.phase = 'running';
    } catch (err) {
      _log(`[ADDONS] ✗ "${name}" postInit failed during reload: ${err.message}`, 'error');
    }
  } else {
    const reloaded = _registry.get(name);
    if (reloaded) reloaded.phase = 'running';
  }

  _log(`[ADDONS] reloaded: ${name}`, 'success');
  return { success: true, message: `Addon "${name}" reloaded` };
}

// ─── Install / Uninstall ───

async function installAddon(source) {
  if (!_addonsDir) return { success: false, message: 'Addons directory not configured' };

  // For now: source must be a local path or name with index.js already present
  // Future: git clone support
  const addonName = path.basename(source);
  const targetDir = path.join(_addonsDir, addonName);
  const indexPath = path.join(targetDir, 'index.js');

  if (!fs.existsSync(indexPath)) {
    return { success: false, message: `No index.js found at ${targetDir}` };
  }

  try {
    const mod = require(indexPath);
    const validation = validateAddon(mod, addonName);
    if (!validation.valid) {
      return { success: false, message: `Validation failed: ${validation.errors.join(', ')}` };
    }

    _discovered.set(mod.name, { dir: addonName, mod, indexPath });
    setAddonEnabled(mod.name, true);

    const result = await enableAddon(mod.name);
    _log(`[ADDONS] install success: ${mod.name}`, 'success');
    return result;
  } catch (err) {
    return { success: false, message: `Install failed: ${err.message}` };
  }
}

async function uninstallAddon(name) {
  if (REQUIRED_CORE.includes(name)) {
    return { success: false, message: `Cannot uninstall core addon "${name}"` };
  }

  // Disable first
  if (_registry.has(name)) {
    const disableResult = await disableAddon(name);
    if (!disableResult.success) return disableResult;
  }

  // Remove from discovered
  const info = _discovered.get(name);
  _discovered.delete(name);

  // Remove folder
  if (info && _addonsDir) {
    const targetDir = path.join(_addonsDir, info.dir);
    try {
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    } catch (err) {
      _log(`[ADDONS] Failed to remove folder for ${name}: ${err.message}`, 'warn');
    }
  }

  // Remove from config
  const cfg = loadConfig();
  delete cfg[name];
  saveConfig(cfg);

  clearRequireCache(info ? path.join(_addonsDir, info.dir) : '');

  _log(`[ADDONS] uninstall success: ${name}`, 'success');
  return { success: true, message: `Addon "${name}" uninstalled` };
}

// ─── Query APIs ───

function getFeature(name) {
  const entry = _registry.get(name);
  if (entry) return entry.mod;
  // Check sub-modules of loaded addons
  for (const [, reg] of _registry) {
    if (reg.mod._submodules) {
      for (const sub of reg.mod._submodules) {
        if ((sub.name || sub) === name) return sub;
      }
    }
  }
  return null;
}

function requireFeature(name) {
  const f = getFeature(name);
  if (!f && _agentRefs) {
    try { _agentRefs.log(`[ADDONS] Missing required feature: ${name}`, 'error'); } catch {}
    try { _agentRefs.emitAgentEvent('system:critical', `Missing feature: ${name}`, { level: 'error', feature: name }); } catch {}
  }
  return f;
}

function getAddonStatus() {
  const config = loadConfig();
  const result = [];

  // Loaded addons
  for (const [name, entry] of _registry) {
    const hasConfig = !!(entry.mod.configSchema && Object.keys(entry.mod.configSchema).length > 0);
    result.push({
      name,
      displayName: entry.meta.displayName,
      description: entry.meta.description,
      category: entry.meta.category,
      version: entry.meta.version,
      author: entry.meta.author,
      core: entry.meta.core,
      enabled: true,
      status: entry.phase,
      uptime_ms: Date.now() - entry.started,
      hasConfig,
    });
  }

  // Discovered but disabled
  for (const [name, info] of _discovered) {
    if (_registry.has(name)) continue;
    const isFailed = _failedAddons.some(f => f.name === name);
    const hasConfig = !!(info.mod.configSchema && Object.keys(info.mod.configSchema).length > 0);
    result.push({
      name,
      displayName: info.mod.displayName || name,
      description: info.mod.description || '',
      category: info.mod.category || 'Other',
      version: info.mod.version || '0.0.0',
      author: info.mod.author || 'Unknown',
      core: info.mod.core === true,
      enabled: config[name] === true,
      status: isFailed ? 'failed' : 'disabled',
      uptime_ms: 0,
      hasConfig,
    });
  }

  // Failed (not discovered)
  for (const f of _failedAddons) {
    if (!result.find(r => r.name === f.name)) {
      result.push({
        name: f.name,
        displayName: f.name,
        description: f.reason,
        category: 'Unknown',
        version: '-',
        author: '-',
        core: false,
        enabled: false,
        status: 'failed',
        uptime_ms: 0,
      });
    }
  }

  return result;
}

function getLoadedFeatures() {
  const result = [];
  for (const [name, entry] of _registry) {
    result.push({
      name,
      started: entry.started,
      uptime_ms: Date.now() - entry.started,
      phase: entry.phase,
      core: entry.meta.core,
      has_shutdown: typeof entry.mod.shutdown === 'function',
      has_postInit: typeof entry.mod.postInit === 'function',
      requires: entry.mod.requires || [],
    });
  }
  return result;
}

function getFeatureHealthStatus() {
  const loaded = getLoadedFeatures();
  const missingCore = REQUIRED_CORE.filter(n => !_registry.has(n));
  return {
    healthy: missingCore.length === 0 && _failedAddons.filter(f => REQUIRED_CORE.includes(f.name)).length === 0,
    loaded_features: loaded,
    missing_core_features: missingCore,
    failed_features: _failedAddons.map(f => ({ name: f.name, reason: f.reason })),
    required_core: REQUIRED_CORE,
    total_loaded: _registry.size,
    total_failed: _failedAddons.length,
  };
}

async function shutdownAddons(log) {
  const logFn = log || _log;
  const names = [..._registry.keys()].reverse();
  for (const name of names) {
    const entry = _registry.get(name);
    if (entry && typeof entry.mod.shutdown === 'function') {
      try {
        await entry.mod.shutdown();
        logFn(`[ADDONS] ${name} shut down`, 'info');
      } catch (err) {
        logFn(`[ADDONS] ${name} shutdown error: ${err.message}`, 'warn');
      }
    }
  }
  _registry.clear();
}

// ─── Config Query APIs (for agent routes) ───

function getAddonConfigAndSchema(addonName) {
  const entry = _registry.get(addonName) || _discovered.get(addonName);
  if (!entry) return null;
  const mod = entry.mod;
  const schema = mod.configSchema || {};
  const values = _resolveAddonConfig(addonName, schema);
  return { schema, values };
}

function updateAddonConfig(addonName, updates) {
  const entry = _registry.get(addonName) || _discovered.get(addonName);
  if (!entry) return { success: false, message: `Addon "${addonName}" not found` };
  const mod = entry.mod;
  const schema = mod.configSchema || {};
  if (!schema || Object.keys(schema).length === 0) return { success: false, message: 'Addon has no configurable settings' };

  const errors = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!schema[key]) { errors.push(`Unknown key: ${key}`); continue; }
    const v = _validateConfigValue(key, value, schema[key]);
    if (!v.valid) errors.push(v.reason);
  }
  if (errors.length > 0) return { success: false, message: errors.join('; ') };

  const current = _loadAddonConfig(addonName);
  for (const [key, value] of Object.entries(updates)) {
    current[key] = value;
  }
  _saveAddonConfig(addonName, current);
  _log(`[ADDONS] config updated for ${addonName}: ${Object.keys(updates).join(', ')}`, 'info');
  return { success: true, message: 'Config saved', values: _resolveAddonConfig(addonName, schema) };
}

module.exports = {
  loadAddons,
  postInitAddons,
  getFeature,
  requireFeature,
  getAddonStatus,
  getLoadedFeatures,
  getFeatureHealthStatus,
  shutdownAddons,
  // Runtime controls
  enableAddon,
  disableAddon,
  reloadAddon,
  installAddon,
  uninstallAddon,
  // Config system
  getAddonConfigAndSchema,
  updateAddonConfig,
  // Internal access (for global interceptors like rconQueue)
  getInternalCtx: () => _ctx,
  // Backward-compatible aliases
  loadFeatures: loadAddons,
  postInitFeatures: postInitAddons,
  shutdownFeatures: shutdownAddons,
};
