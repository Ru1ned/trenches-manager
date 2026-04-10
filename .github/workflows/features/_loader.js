/**
 * Unified Feature Module Loader v2.1
 * Single authoritative system for ALL features (core + dynamic).
 * 
 * Features declare: { name, core?, requires?, init(ctx), postInit?(ctx), shutdown?() }
 * 
 * Lifecycle phases:
 *   1. preInit  — resolve dependencies, validate modules
 *   2. init     — core systems ready (db, settings, commands)
 *   3. postInit — runtime ready (chatMonitor, full context available)
 * 
 * Core features (core: true) always load regardless of config.
 * Dynamic features load only if listed in config.features[].
 * 
 * v2.1: Strict runtime validation — core feature guarantee,
 *       dependency hardening, health status endpoint.
 */
'use strict';

const path = require('path');
const fs = require('fs');

// ─── Feature Registry (singleton) ───
const _registry = new Map(); // name → { mod, started, phase, core }
const _failedFeatures = []; // { name, reason, core }
const REQUIRED_CORE_FEATURES = ['transferProtection', 'tribeEnforcer', 'trenchesChat'];

// ─── Agent refs (stored after loadFeatures for health/event emission) ───
let _agentRefs = null;

/**
 * Build the structured context object from raw agent refs.
 * This is the ONLY interface features may use.
 * @param {object} raw — raw agent references
 * @returns {object} structured ctx with namespaces
 */
function buildStructuredCtx(raw) {
  const ctx = {
    // ─── db namespace ───
    db: {
      /** Get raw db handle (for prepare/run/all) */
      instance: () => raw.db(),
      query: (sql, ...params) => {
        const db = raw.db();
        const stmt = db.prepare(sql);
        return params.length > 0 ? stmt.all(...params) : stmt.all();
      },
      run: (sql, ...params) => {
        const db = raw.db();
        return db.prepare(sql).run(...params);
      },
      get: (sql, ...params) => {
        const db = raw.db();
        return db.prepare(sql).get(...params);
      },
    },

    // ─── commands namespace ───
    commands: {
      enqueue: (fn, description, opts) => raw.enqueueHeavyCommand(fn, description, opts),
    },

    // ─── servers namespace ───
    servers: {
      list: () => raw.getServers(),
    },

    // ─── events namespace ───
    events: {
      emit: (event, message, meta) => raw.emitAgentEvent(event, message, meta),
    },

    // ─── settings namespace ───
    settings: {
      get: (key, fallback) => raw.getSetting(key, fallback),
      set: (key, value) => raw.setSetting(key, value),
      isEnabled: (key) => raw.isFeatureEnabled(key),
    },

    // ─── system namespace ───
    system: {
      getPressure: () => raw.getSystemPressure(),
      isCircuitBreakerOpen: () => raw.isCircuitBreakerOpen(),
      isServerLocked: (serverId) => raw.isServerLocked(serverId),
    },

    // ─── log (top-level for convenience) ───
    log: raw.log,

    // ─── features namespace (populated after init) ───
    features: {},

    // ─── runtime refs (populated during postInit) ───
    runtime: {},
  };

  return ctx;
}

/**
 * Topological sort based on `requires` declarations.
 * Features with missing deps are EXCLUDED (not loaded) with explicit error.
 * Returns ordered array of feature entries to load, or null on cycle.
 */
function resolveLoadOrder(modules, log) {
  const graph = new Map(); // name → Set of deps
  const byName = new Map(); // name → entry
  const allNames = new Set(modules.map(m => m.name));
  const excluded = new Set();

  for (const m of modules) {
    byName.set(m.name, m);
    const deps = new Set(m.mod.requires || []);
    graph.set(m.name, deps);

    // Dependency hardening: if dep is missing, exclude this feature
    for (const dep of deps) {
      if (!allNames.has(dep)) {
        const reason = `Feature "${m.name}" disabled due to missing dependency "${dep}"`;
        log(`[FEATURES] ERROR: ${reason}`, 'error');
        _failedFeatures.push({ name: m.name, reason, core: m.isCore });
        excluded.add(m.name);
      }
    }
  }

  // Remove excluded from graph
  for (const name of excluded) {
    graph.delete(name);
    allNames.delete(name);
  }

  const sorted = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(name) {
    if (visited.has(name)) return true;
    if (visiting.has(name)) {
      log(`[FEATURES] ERROR: Circular dependency detected involving "${name}"`, 'error');
      return false;
    }
    visiting.add(name);
    const deps = graph.get(name) || new Set();
    for (const dep of deps) {
      if (excluded.has(dep)) return false; // dep was excluded
      if (!visit(dep)) return false;
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
    return true;
  }

  for (const name of allNames) {
    if (!visit(name)) {
      const reason = `Feature "${name}" disabled due to dependency cycle`;
      log(`[FEATURES] ERROR: ${reason}`, 'error');
      _failedFeatures.push({ name, reason, core: byName.get(name)?.isCore || false });
    }
  }

  return sorted;
}

/**
 * Unified feature loader.
 */
async function loadFeatures({ featuresDir, enabledFeatures, agentRefs, log }) {
  _agentRefs = agentRefs;
  _failedFeatures.length = 0; // reset

  if (!fs.existsSync(featuresDir)) {
    log('[FEATURES] Features directory not found: ' + featuresDir, 'warn');
    return;
  }

  // Phase 1: DISCOVER — scan all .js files (skip _loader.js)
  const files = fs.readdirSync(featuresDir).filter(f =>
    f.endsWith('.js') && !f.startsWith('_')
  );

  const discovered = [];
  for (const file of files) {
    const featureName = path.basename(file, '.js');
    try {
      const mod = require(path.join(featuresDir, file));
      if (typeof mod.init !== 'function') {
        log(`[FEATURES] WARNING: "${featureName}" has no init() — skipping`, 'warn');
        continue;
      }
      const name = mod.name || featureName;
      const isCore = mod.core === true;
      discovered.push({ name, fileName: featureName, mod, isCore });
    } catch (err) {
      log(`[FEATURES] ERROR: Failed to require "${featureName}": ${err.message}`, 'error');
      _failedFeatures.push({ name: featureName, reason: `require() failed: ${err.message}`, core: false });
    }
  }

  // Separate core vs dynamic
  const coreFeatures = discovered.filter(d => d.isCore);
  const dynamicFeatures = discovered.filter(d => !d.isCore && (enabledFeatures || []).includes(d.name));
  const skippedDynamic = discovered.filter(d => !d.isCore && !(enabledFeatures || []).includes(d.name));

  const toLoad = [...coreFeatures, ...dynamicFeatures];

  log(`[FEATURES] Discovered: ${discovered.map(d => d.name + (d.isCore ? '(core)' : '')).join(', ')}`, 'info');
  log(`[FEATURES] Loading: ${toLoad.map(d => d.name).join(', ') || '(none)'}`, 'info');
  if (skippedDynamic.length > 0) {
    log(`[FEATURES] Skipped (not enabled): ${skippedDynamic.map(d => d.name).join(', ')}`, 'info');
  }

  // Phase 2: RESOLVE — topological sort with dependency hardening
  const loadOrder = resolveLoadOrder(toLoad, log);

  const orderedModules = loadOrder
    .map(name => toLoad.find(m => m.name === name))
    .filter(Boolean);

  // Phase 3: BUILD CONTEXT
  const ctx = buildStructuredCtx(agentRefs);

  // Phase 4: INIT — call init(ctx) on each feature in order
  for (const entry of orderedModules) {
    try {
      log(`[FEATURES] Initializing: ${entry.name}...`, 'info');
      await entry.mod.init(ctx);
      _registry.set(entry.name, {
        mod: entry.mod,
        started: Date.now(),
        phase: 'initialized',
        core: entry.isCore,
      });
      // Expose module's public API on ctx.features
      ctx.features[entry.name] = entry.mod;
      log(`[FEATURES] ✓ ${entry.name} initialized`, 'success');
    } catch (err) {
      const reason = `init() failed: ${err.message}`;
      log(`[FEATURES] ✗ "${entry.name}" ${reason}`, 'error');
      _failedFeatures.push({ name: entry.name, reason, core: entry.isCore });
    }
  }

  log(`[FEATURES] ${_registry.size}/${toLoad.length} features initialized`, 'info');

  // Phase 5: CORE FEATURE VALIDATION — strict guarantee
  validateCoreFeatures(log, agentRefs);
}

/**
 * Validate all required core features are loaded.
 * If ANY are missing: log ERROR, emit system:critical, mark degraded.
 */
function validateCoreFeatures(log, agentRefs) {
  const missing = [];
  for (const name of REQUIRED_CORE_FEATURES) {
    if (!_registry.has(name)) {
      missing.push(name);
    }
  }

  if (missing.length === 0) {
    log(`[FEATURES] ✓ Core feature validation passed — all ${REQUIRED_CORE_FEATURES.length} core features loaded`, 'success');
    return;
  }

  // CRITICAL: core features missing
  const msg = `CRITICAL: ${missing.length} core feature(s) missing: [${missing.join(', ')}]`;
  log(`[FEATURES] ✗ ${msg}`, 'error');

  // Emit system:critical event
  try {
    if (agentRefs && typeof agentRefs.emitAgentEvent === 'function') {
      agentRefs.emitAgentEvent('system:critical', msg, {
        level: 'error',
        missing_features: missing,
      });
    }
  } catch {}

  // Set system state to degraded
  try {
    if (agentRefs && typeof agentRefs.setSetting === 'function') {
      agentRefs.setSetting('system_state', 'degraded');
      agentRefs.setSetting('system_degraded_reason', `Missing core features: ${missing.join(', ')}`);
    }
  } catch {}

  // Strict mode: halt agent boot if enabled
  if (process.env.TRENCHES_STRICT_MODE === 'true') {
    const fatalMsg = `[FEATURES] FATAL: Strict mode enabled — refusing to boot with missing core features: [${missing.join(', ')}]`;
    log(fatalMsg, 'error');
    throw new Error(fatalMsg);
  }
}

/**
 * Phase 3: postInit — called once runtime deps (chatMonitor etc.) are available.
 */
async function postInitFeatures(runtimeRefs, log) {
  for (const [name, entry] of _registry) {
    if (typeof entry.mod.postInit === 'function') {
      try {
        await entry.mod.postInit(runtimeRefs);
        entry.phase = 'running';
        log(`[FEATURES] ✓ ${name} postInit complete`, 'success');
      } catch (err) {
        log(`[FEATURES] ✗ "${name}" postInit failed: ${err.message}`, 'error');
        _failedFeatures.push({ name, reason: `postInit() failed: ${err.message}`, core: entry.core });

        // If core feature postInit fails, emit critical
        if (entry.core && _agentRefs && typeof _agentRefs.emitAgentEvent === 'function') {
          try {
            _agentRefs.emitAgentEvent('system:critical', `Core feature "${name}" postInit failed: ${err.message}`, { level: 'error' });
          } catch {}
        }
      }
    } else {
      entry.phase = 'running';
    }
  }
}

/**
 * Get a loaded feature module by name.
 * @param {string} name
 * @returns {object|null} The feature module or null
 */
function getFeature(name) {
  const entry = _registry.get(name);
  return entry ? entry.mod : null;
}

/**
 * Safe accessor for required features.
 * Logs error + emits system:critical if feature is missing.
 * @param {string} name
 * @returns {object|null}
 */
function requireFeature(name) {
  const f = getFeature(name);
  if (!f) {
    const msg = `Missing required feature: ${name}`;
    try {
      if (_agentRefs && typeof _agentRefs.log === 'function') {
        _agentRefs.log(`[FEATURES] ${msg}`, 'error');
      }
    } catch {}
    try {
      if (_agentRefs && typeof _agentRefs.emitAgentEvent === 'function') {
        _agentRefs.emitAgentEvent('system:critical', msg, { level: 'error', feature: name });
      }
    } catch {}
    return null;
  }
  return f;
}

/**
 * Get feature health status for diagnostics.
 */
function getFeatureHealthStatus() {
  const loaded = [];
  for (const [name, info] of _registry) {
    loaded.push({
      name,
      phase: info.phase,
      core: info.core,
      uptime_ms: Date.now() - info.started,
    });
  }

  const missingCore = REQUIRED_CORE_FEATURES.filter(n => !_registry.has(n));

  return {
    healthy: missingCore.length === 0 && _failedFeatures.filter(f => f.core).length === 0,
    loaded_features: loaded,
    missing_core_features: missingCore,
    failed_features: _failedFeatures.map(f => ({ name: f.name, reason: f.reason, core: f.core })),
    required_core: REQUIRED_CORE_FEATURES,
    total_loaded: _registry.size,
    total_failed: _failedFeatures.length,
  };
}

/**
 * Get list of currently loaded features for diagnostics.
 */
function getLoadedFeatures() {
  const result = [];
  for (const [name, info] of _registry) {
    result.push({
      name,
      started: info.started,
      uptime_ms: Date.now() - info.started,
      phase: info.phase,
      core: info.core,
      has_shutdown: typeof info.mod.shutdown === 'function',
      has_postInit: typeof info.mod.postInit === 'function',
      requires: info.mod.requires || [],
    });
  }
  return result;
}

/**
 * Gracefully shut down all features (reverse order).
 */
async function shutdownFeatures(log) {
  const names = [..._registry.keys()].reverse();
  for (const name of names) {
    const info = _registry.get(name);
    if (info && typeof info.mod.shutdown === 'function') {
      try {
        await info.mod.shutdown();
        log(`[FEATURES] ${name} shut down`, 'info');
      } catch (err) {
        log(`[FEATURES] ${name} shutdown error: ${err.message}`, 'warn');
      }
    }
  }
  _registry.clear();
}

module.exports = { loadFeatures, postInitFeatures, getFeature, requireFeature, getLoadedFeatures, getFeatureHealthStatus, shutdownFeatures };
