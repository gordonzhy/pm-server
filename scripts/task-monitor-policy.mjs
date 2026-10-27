import { instant } from './task-log.mjs';
import {registeredManagerReference} from '../lib/notifications.mjs';

const managerReference = value => registeredManagerReference(value) || value || '';
export function monitorScope(task, projectManager = null) {
  return JSON.stringify([task.dispatch_id || '', task.execution_thread_id || '',
    '', managerReference(task.manager_thread_id),
    ...(projectManager ? [managerReference(projectManager)] : [])]);
}

export function monitorScopeMatches(saved, task, projectManager = null) {
  let previous;
  try { previous = JSON.parse(saved); } catch { return false; }
  const expected = JSON.parse(monitorScope(task, projectManager));
  if (!Array.isArray(previous) || previous.length !== expected.length
      || !previous.every(value => typeof value === 'string')) return false;
  return previous.every((value, index) => (index === 2 || (index >= 3 ? managerReference(value) : value) === expected[index]));
}

export const pauseFields = ['monitor_pause_until', 'monitor_pause_reason', 'monitor_pause_scope'];
export function pauseScope(task, runtimeTurn = '') {
  return {dispatch: task.dispatch_id || '', execution: task.execution_thread_id || '',
    csvTurn: task.execution_turn_id || '', runtimeTurn, manager: managerReference(task.manager_thread_id)};
}
export function inspectPause(task, runtimeTurn, now = Date.now()) {
  const values = pauseFields.map(field => task[field] || '');
  if (!values.some(Boolean)) return {paused: false, clear: false};
  let scope;
  try { scope = JSON.parse(task.monitor_pause_scope); } catch {}
  const expected = pauseScope(task, runtimeTurn);
  const valid = Number.isFinite(instant(task.monitor_pause_until)) && task.monitor_pause_reason?.trim()
    && scope && Object.keys(scope).length === Object.keys(expected).length
    && Object.keys(expected).every(key => typeof scope[key] === 'string');
  if (!valid) return {paused: false, clear: true, error: 'invalid monitoring pause metadata'};
  const same = ['dispatch', 'execution', 'csvTurn'].every(key => scope[key] === expected[key])
    && managerReference(scope.manager) === expected.manager
    && (!runtimeTurn || scope.runtimeTurn === runtimeTurn);
  return {paused: task.status === '进行中' && same && instant(task.monitor_pause_until) > now,
    clear: task.status !== '进行中' || !same || instant(task.monitor_pause_until) <= now};
}
