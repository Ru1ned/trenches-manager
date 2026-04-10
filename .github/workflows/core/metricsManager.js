/**
 * Metrics Manager Module — extracted from trenches-agent.js
 * 
 * Contains server diagnostics, trace system, stderr classification,
 * and corruption tracking helpers.
 * 
 * ZERO new logic — this is a direct extraction.
 */
'use strict';

// ─── Stderr Classification ───

const STDERR_WARN_PATTERNS = [
  'GameAnalytics',
  'Could not open database',
  'Could not ensure/validate local event database',
  'LogOnline',
  'LogStreaming',
  'LogInit',
  'LogConfig',
];

const STDERR_CRASH_PATTERNS = [
  'Fatal error',
  'EXCEPTION_ACCESS_VIOLATION',
  'Segmentation fault',
  'Process exited unexpectedly',
  'LowLevelFatalError',
  'Assertion failed',
  'CRITICAL ERROR',
];

function classifyStderr(text) {
  const upper = text.toUpperCase();
  for (const p of STDERR_CRASH_PATTERNS) {
    if (upper.includes(p.toUpperCase())) return 'error';
  }
  for (const p of STDERR_WARN_PATTERNS) {
    if (text.includes(p)) return 'info';
  }
  return 'warn';
}

// ─── Trace System ───

function createTraceSystem(log) {
  const serverTraces = new Map();

  function createTrace(serverName, traceId) {
    const trace = {
      traceId, serverName,
      startedAt: new Date().toISOString(),
      completedAt: null, finalResult: null,
      stages: [],
    };
    serverTraces.set(serverName, trace);
    return trace;
  }

  function traceLog(traceId, stage, message, level) {
    const prefix = `[TRACE ${traceId}] [${stage}]`;
    log(`${prefix} ${message}`, level || 'startup');
    for (const [, t] of serverTraces) {
      if (t.traceId === traceId) {
        t.stages.push({ ts: new Date().toISOString(), stage, message, level: level || 'info' });
        if (t.stages.length > 300) t.stages.splice(0, t.stages.length - 300);
        break;
      }
    }
  }

  function traceComplete(traceId, result) {
    for (const [, t] of serverTraces) {
      if (t.traceId === traceId) {
        t.completedAt = new Date().toISOString();
        t.finalResult = result;
        break;
      }
    }
  }

  function getLastTrace(serverName) {
    return serverTraces.get(serverName) || null;
  }

  return { createTrace, traceLog, traceComplete, getLastTrace, _traces: serverTraces };
}

// ─── Diagnostics Module ───

function createDiagnosticsSystem(log, DIAGNOSTICS = false) {
  const serverDiagnostics = new Map();

  function getDiag(serverName) {
    if (!serverDiagnostics.has(serverName)) {
      serverDiagnostics.set(serverName, {
        timeline: [], lastKnownPid: null, lastKnownPidAt: null,
        pidChecks: [],
        flags: {
          startupInitiated: false, pidDetected: false,
          logWatcherAttached: false, startupCompleteDetected: false,
        },
        failureReason: null, processScans: [],
      });
    }
    return serverDiagnostics.get(serverName);
  }

  function diagLog(serverName, category, message, level) {
    const diag = getDiag(serverName);
    diag.timeline.push({ ts: new Date().toISOString(), category, message });
    if (diag.timeline.length > 200) diag.timeline.splice(0, diag.timeline.length - 200);
    if (DIAGNOSTICS) log(`[DIAG] [${category}] "${serverName}": ${message}`, level || 'info');
  }

  function diagRecordPidCheck(serverName, pid, alive) {
    const diag = getDiag(serverName);
    diag.pidChecks.push({ ts: Date.now(), pid, alive });
    if (diag.pidChecks.length > 50) diag.pidChecks.splice(0, diag.pidChecks.length - 50);
    if (alive && pid) {
      diag.lastKnownPid = pid;
      diag.lastKnownPidAt = new Date().toISOString();
    }
    if (DIAGNOSTICS) log(`[DIAG] [PID_CHECK] "${serverName}": PID ${pid} alive=${alive}`, alive ? 'info' : 'warn');
  }

  function diagSetFlag(serverName, flag, value) {
    const diag = getDiag(serverName);
    if (diag.flags[flag] !== value) {
      diag.flags[flag] = value;
      diagLog(serverName, 'FLAG', `${flag} = ${value}`, value ? 'success' : 'warn');
    }
  }

  function diagReset(serverName) {
    serverDiagnostics.delete(serverName);
  }

  function diagPrintTimeline(serverName) {
    const diag = getDiag(serverName);
    if (diag.timeline.length === 0) return;
    log(`[DIAG TIMELINE] ═══ "${serverName}" ═══`, 'info');
    const recent = diag.timeline.slice(-30);
    for (const entry of recent) log(`  ${entry.ts} [${entry.category}] ${entry.message}`, 'info');
    log(`[DIAG TIMELINE] ═══ flags: ${JSON.stringify(diag.flags)} ═══`, 'info');
    if (diag.lastKnownPid) log(`[DIAG TIMELINE] ═══ lastPID=${diag.lastKnownPid} at ${diag.lastKnownPidAt} ═══`, 'info');
  }

  return {
    getDiag, diagLog, diagRecordPidCheck, diagSetFlag,
    diagReset, diagPrintTimeline,
    _diagnostics: serverDiagnostics,
  };
}

// ─── Failure Classification ───

const FAILURE_REASONS = {
  PID_LOST_BUT_PROCESS_FOUND: 'PID_LOST_BUT_PROCESS_FOUND',
  PID_LOST_PROCESS_DEAD: 'PID_LOST_PROCESS_DEAD',
  PORT_BIND_FAILURE: 'PORT_BIND_FAILURE',
  CRASH_BEFORE_STARTUP: 'CRASH_BEFORE_STARTUP',
  CRASH_AFTER_STARTUP: 'CRASH_AFTER_STARTUP',
  AGENT_STATE_DESYNC: 'AGENT_STATE_DESYNC',
};

module.exports = {
  STDERR_WARN_PATTERNS,
  STDERR_CRASH_PATTERNS,
  classifyStderr,
  createTraceSystem,
  createDiagnosticsSystem,
  FAILURE_REASONS,
};
