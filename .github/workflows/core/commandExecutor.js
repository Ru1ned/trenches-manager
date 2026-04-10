/**
 * Command Executor Module — extracted from trenches-agent.js
 * 
 * Contains the priority command queue, circuit breaker,
 * retry logic, and queue persistence helpers.
 * 
 * ZERO new logic — this is a direct extraction.
 * All functions receive dependencies via injection.
 */
'use strict';

const MAX_CONCURRENT_COMMANDS = 2;
const MAX_QUEUE_SIZE = 20;
const COMMAND_TIMEOUT_MS = 300000; // 5 min

// Priority levels
const CMD_PRIORITY = {
  stop_server: 100,
  restart_server: 90,
  start_server: 50,
  create_server: 30,
  delete_server: 30,
  create_cluster: 20,
  delete_cluster: 20,
  manual_backup: 10,
  restore_backup: 10,
  install: 10,
  default: 10,
};

// Per-command retry rules
const COMMAND_RETRY_RULES = {
  start_server: { retry: true, maxRetries: 2 },
  install_server: { retry: true, maxRetries: 3 },
  manual_backup: { retry: true, maxRetries: 1 },
  restore_backup: { retry: true, maxRetries: 1 },
  create_server: { retry: true, maxRetries: 1 },
  delete_server: { retry: false, maxRetries: 0 },
  delete_cluster: { retry: false, maxRetries: 0 },
  stop_server: { retry: false, maxRetries: 0 },
  restart_server: { retry: true, maxRetries: 1 },
};

// Timeout policy per command
const TIMEOUT_RULES = {
  start_server: { timeoutMs: 180000, failOnTimeout: true },
  stop_server: { timeoutMs: 30000, failOnTimeout: true },
  restart_server: { timeoutMs: 210000, failOnTimeout: true },
  install_server: { timeoutMs: 600000, failOnTimeout: false },
  manual_backup: { timeoutMs: 300000, failOnTimeout: false },
  restore_backup: { timeoutMs: 300000, failOnTimeout: false },
  create_server: { timeoutMs: 60000, failOnTimeout: true },
  delete_server: { timeoutMs: 60000, failOnTimeout: true },
  default: { timeoutMs: 300000, failOnTimeout: true },
};

function getTimeoutRules(commandType) {
  return TIMEOUT_RULES[commandType] || TIMEOUT_RULES.default;
}

function getRetryRules(commandType) {
  return COMMAND_RETRY_RULES[commandType] || { retry: false, maxRetries: 0 };
}

function getCommandPriority(commandType) {
  return CMD_PRIORITY[commandType] || CMD_PRIORITY.default;
}

function getEffectivePriority(item) {
  const waitSeconds = (Date.now() - item.queued_at) / 1000;
  return item.priority + Math.floor(waitSeconds / 5);
}

function sortQueue(queue) {
  queue.sort((a, b) => getEffectivePriority(b) - getEffectivePriority(a) || a.queued_at - b.queued_at);
}

// ─── Circuit Breaker ───

function createCircuitBreaker() {
  return {
    failures: [],
    state: 'closed',
    openedAt: null,
    halfOpenSlotTaken: false,
    cooldownMs: 30000,
    failureThreshold: 5,
    failureWindowMs: 60000,
  };
}

function recordCircuitFailure(cb, log, emitAgentEvent) {
  const now = Date.now();
  cb.failures.push(now);
  cb.failures = cb.failures.filter(t => now - t < cb.failureWindowMs);
  if (cb.failures.length >= cb.failureThreshold && cb.state === 'closed') {
    cb.state = 'open';
    cb.openedAt = now;
    cb.halfOpenSlotTaken = false;
    log('[CircuitBreaker] OPEN — too many failures, rejecting non-critical commands', 'error');
    emitAgentEvent('system:degraded', `Circuit breaker OPEN — ${cb.failures.length} failures in 60s`, { level: 'error' });
  }
}

function checkCircuitBreaker(cb, commandType, log) {
  if (cb.state === 'closed') return true;
  if (commandType === 'stop_server') return true;
  if (cb.state === 'open') {
    if (Date.now() - cb.openedAt > cb.cooldownMs) {
      cb.state = 'half_open';
      cb.halfOpenSlotTaken = false;
      log('[CircuitBreaker] → half_open (allowing 1 probe command)', 'warn');
    } else {
      return false;
    }
  }
  if (cb.state === 'half_open') {
    if (cb.halfOpenSlotTaken) return false;
    cb.halfOpenSlotTaken = true;
    return true;
  }
  return true;
}

function circuitBreakerSuccess(cb, log, emitAgentEvent) {
  if (cb.state === 'half_open') {
    cb.state = 'closed';
    cb.failures = [];
    cb.halfOpenSlotTaken = false;
    log('[CircuitBreaker] → closed (recovered)', 'success');
    emitAgentEvent('system:recovered', 'Circuit breaker recovered — accepting commands', { level: 'success' });
  }
}

function circuitBreakerFailure(cb, log, emitAgentEvent) {
  recordCircuitFailure(cb, log, emitAgentEvent);
  if (cb.state === 'half_open') {
    cb.state = 'open';
    cb.openedAt = Date.now();
    cb.halfOpenSlotTaken = false;
    log('[CircuitBreaker] half_open probe FAILED → reopening', 'error');
    emitAgentEvent('system:degraded', 'Circuit breaker re-opened after probe failure', { level: 'error' });
  }
}

// ─── System Pressure ───

function getSystemPressure(queue, activeCount, cb) {
  const queueLen = queue.length;
  if (cb.state === 'open') return 'high';
  if (activeCount >= MAX_CONCURRENT_COMMANDS && queueLen > 5) return 'high';
  if (activeCount >= MAX_CONCURRENT_COMMANDS || queueLen > 2) return 'medium';
  return 'low';
}

module.exports = {
  MAX_CONCURRENT_COMMANDS,
  MAX_QUEUE_SIZE,
  COMMAND_TIMEOUT_MS,
  CMD_PRIORITY,
  COMMAND_RETRY_RULES,
  TIMEOUT_RULES,
  getTimeoutRules,
  getRetryRules,
  getCommandPriority,
  getEffectivePriority,
  sortQueue,
  createCircuitBreaker,
  recordCircuitFailure,
  checkCircuitBreaker,
  circuitBreakerSuccess,
  circuitBreakerFailure,
  getSystemPressure,
};
