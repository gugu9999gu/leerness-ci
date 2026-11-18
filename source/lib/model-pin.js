'use strict';
const crypto = require('crypto');

const PIN_SOURCES = new Set(['user-stated', 'cli-arg', 'role-confirmed']);
const PIN_SCOPES = new Set(['execution', 'review']);
const HUMAN_VERIFICATION = new Set(['tty-typed', 'host-reported-unverified']);
const DISPATCH_EVENTS = new Set(['fallback.selected', 'dispatch.prepared']);
const START_EVENTS = new Set(['execution.started', 'review.completed']);
const TERMINAL_EVENTS = new Set(['execution.completed', 'execution.failed', 'review.completed']);
const RUN_EVENTS = new Set(['execution.started', 'execution.partial', 'execution.completed', 'execution.failed', 'review.completed']);
const PIN_EVENTS = new Set(['model.pinned', 'model.change.requested', 'model.change.approved', 'model.change.revoked']);
const MAX_PINNED_FAILURES = 3;
const CHOICES = Object.freeze(['retry the pinned model', 'approve one specific other model for this task', 'hold or cancel']);
const GUIDANCE = Object.freeze({
  en: 'User-named models override fallback and escalation: on failure ask the user; never switch model, provider or worker.',
  ko: '사용자가 지정한 모델은 fallback·escalation보다 우선한다. 실패하면 사용자에게 묻고 모델·provider·작업자를 바꾸지 않는다.',
});
const guidance = lang => GUIDANCE[lang === 'en' ? 'en' : 'ko'];

const digest = value => crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex');
const requestDigest = request => digest(String(request == null ? '' : request).trim());
const randomId = prefix => `${prefix}${crypto.randomBytes(5).toString('hex')}`;

function canonical(executor) {
  if (!executor || typeof executor !== 'object') return { provider: null, model: null };
  const id = require('./role-fallback').normalizeExecutorIdentity(executor, { allowLegacyProviderIds: true });
  return { provider: id.provider || null, model: id.model || null };
}
const sameModel = (a, b) => {
  const x = canonical(a), y = canonical(b);
  return !!(x.provider && x.model && x.provider === y.provider && x.model === y.model);
};
const describe = executor => {
  const id = canonical(executor);
  return id.provider ? `${id.provider} / ${id.model || '(provider default)'}` : '(no model executor)';
};
const label = executor => { const id = canonical(executor); return `${id.provider}/${id.model}`; };
const scopeOfRole = role => (String(role || '').trim().toLowerCase() === 'reviewer' ? 'review' : 'execution');
const scopeOfRecord = record => (record && (record.event === 'review.completed' || scopeOfRole(record.requestedRole) === 'review') ? 'review' : 'execution');
const challengeFor = ({ taskId, requestId, kind, from, to }) => (kind === 'retry'
  ? `RETRY ${requestId} ${taskId} ${label(from)}`
  : `APPROVE ${requestId} ${taskId} ${label(from)} -> ${label(to)}`);
const contentDigest = record => digest(JSON.stringify([
  record.event, record.taskId || null, record.attemptId || null, label(record.actualExecutor),
  record.approvalEventId || null, record.dispatchEventId || null, record.executed === true,
  [...(record.evidenceRefs || [])].map(String).sort(), (record.result && record.result.summary) || null, record.parentAttemptId || null,
  record.reportedModel == null ? null : String(record.reportedModel), record.modelVerification == null ? null : String(record.modelVerification),
  record.status ?? null, record.review?.feedbackRoundId ?? null, record.reviewOfAttemptId ?? null,
  record.requestedRole ?? null, record.sessionId ?? null, record.actualExecutor?.sessionId ?? null,
  record.actualExecutor?.modelFamily ?? null, record.requestDigest ?? null,
]));

function pinError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, executed: false, substituted: false, ...extra });
}

function pinScopeOf(events, taskId, pinId) {
  for (const event of events || []) if (event && event.taskId === taskId && event.event === 'model.pinned' && event.pin && event.pin.pinId === pinId) return event.pin.scope || 'execution';
  return null;
}

function pinState(events, taskId, scope = 'execution') {
  const state = {
    taskId: taskId || null, scope, pin: null, pinEventId: null, pinIds: new Set(), requests: new Map(), answered: new Set(),
    approvals: new Map(), revoked: new Set(), dispatches: new Map(), approvalDispatch: new Map(), approvalAttempt: new Map(),
    attempts: new Map(), open: new Set(), failures: 0, lastFailure: null, retries: 0, allRequestIds: new Set(),
  };
  if (!taskId) return state;
  for (const event of events || []) {
    if (!event || event.taskId !== taskId) continue;
    if (event.event === 'model.change.requested' && event.request) state.allRequestIds.add(event.request.requestId);
    if (event.event === 'model.pinned' && event.pin) {
      if ((event.pin.scope || 'execution') !== scope) continue;
      if (state.pin && sameModel(state.pin, event.pin) && state.pin.requestDigest === event.pin.requestDigest) continue;
      state.pin = { ...event.pin, scope: event.pin.scope || 'execution' };
      state.pinEventId = event.eventId;
      state.pinIds.add(event.pin.pinId);
      continue;
    }
    if (event.event === 'model.change.requested') {
      if (event.request && state.pinIds.has(event.request.pinId)) state.requests.set(event.request.requestId, { ...event.request, eventId: event.eventId });
      continue;
    }
    if (event.event === 'model.change.approved') {
      const approval = event.approval;
      if (!approval || !state.pinIds.has(approval.pinId) || !approval.requestId || !state.requests.has(approval.requestId)) continue;
      state.approvals.set(event.eventId, approval);
      state.answered.add(approval.requestId);
      if (approval.kind === 'retry' && state.pin && approval.pinId === state.pin.pinId) { state.failures = 0; state.lastFailure = null; state.retries += 1; }
      continue;
    }
    if (event.event === 'model.change.revoked') {
      if (state.approvals.has(event.approvalEventId)) state.revoked.add(event.approvalEventId);
      continue;
    }
    if (scopeOfRecord(event) !== scope) continue;
    if (DISPATCH_EVENTS.has(event.event)) {
      state.dispatches.set(event.eventId, { executor: canonical(event.actualExecutor || event.requestedExecutor), approvalEventId: event.approvalEventId || null, attemptId: null });
      if (event.approvalEventId && !state.approvalDispatch.has(event.approvalEventId)) state.approvalDispatch.set(event.approvalEventId, event.eventId);
      continue;
    }
    if (!RUN_EVENTS.has(event.event)) continue;
    if (!event.attemptId) {
      if (event.event === 'execution.failed' && state.pin && sameModel(event.actualExecutor, state.pin)) state.failures += 1;
      continue;
    }
    const attempt = state.attempts.get(event.attemptId) || { executor: canonical(event.actualExecutor) };
    if (START_EVENTS.has(event.event) && !attempt.started && !attempt.terminal) {
      const dispatch = event.dispatchEventId ? state.dispatches.get(event.dispatchEventId) : null;
      const approvalEventId = dispatch ? dispatch.approvalEventId : (event.approvalEventId || null);
      Object.assign(attempt, { executor: canonical(event.actualExecutor), started: true, startEventId: event.eventId, startDigest: contentDigest(event), approvalEventId });
      if (approvalEventId && !state.approvalAttempt.has(approvalEventId)) state.approvalAttempt.set(approvalEventId, event.attemptId);
      if (dispatch && !dispatch.attemptId) dispatch.attemptId = event.attemptId;
      if (event.event === 'execution.started') state.open.add(event.attemptId);
    }
    if (TERMINAL_EVENTS.has(event.event) && !attempt.terminal) {
      Object.assign(attempt, { terminal: event.event, terminalEventId: event.eventId, terminalDigest: contentDigest(event) });
      state.open.delete(event.attemptId);
    }
    state.attempts.set(event.attemptId, attempt);
    if (event.event === 'execution.failed' && state.pin && sameModel(event.actualExecutor, state.pin)) {
      state.failures += 1;
      state.lastFailure = { at: event.at || null, attemptId: event.attemptId, summary: String((event.result && event.result.summary) || '').slice(0, 200) };
    }
  }
  return state;
}

function decisionPayload(state, attempted, reason, code = 'model_pin_needs_decision') {
  return {
    ok: false, code, status: 'NEEDS_DECISION', taskId: state.taskId, scope: state.scope,
    requested: state.pin ? canonical(state.pin) : null, attempted: attempted ? canonical(attempted) : null,
    reason, executed: false, substituted: false, retried: state.failures, lastFailure: state.lastFailure, choices: CHOICES,
  };
}
function needsDecision(state, attempted, reason, code) {
  const payload = decisionPayload(state, attempted, reason, code);
  return pinError(code || 'model_pin_needs_decision', `Pinned model ${describe(state.pin)} is required for ${state.taskId}; ${reason}. No other model was called.`, { payload });
}

function approvalProblem(state, approvalEventId, executor, { dispatchEventId = null, attemptId = null, request = undefined } = {}) {
  const approval = approvalEventId ? state.approvals.get(approvalEventId) : null;
  if (!approval) return 'no human approval names this model for this task';
  if (!state.pin || approval.pinId !== state.pin.pinId) return 'the approval belongs to an earlier or different request';
  if (approval.kind !== 'change') return 'the approval is not a model change';
  if (state.revoked.has(approvalEventId)) return 'the approval was revoked';
  if (!sameModel(approval.to, executor)) return `the approval is for ${describe(approval.to)}`;
  const usedDispatch = state.approvalDispatch.get(approvalEventId);
  const usedAttempt = state.approvalAttempt.get(approvalEventId);
  if (usedDispatch && usedDispatch !== dispatchEventId) return 'the approval was already used by another dispatch';
  if (usedAttempt && usedAttempt !== attemptId) return 'the approval was already used by another attempt';
  if (request !== undefined && request !== approval.requestDigest) return 'the request changed after the approval';
  return null;
}

function usableApprovalFor(state, executor) {
  for (const [id, approval] of state.approvals) {
    if (approval.kind === 'change' && !approvalProblem(state, id, executor, { request: approval.requestDigest })) return id;
  }
  return null;
}
const unusedApprovalFor = usableApprovalFor;

function activeApprovals(state) {
  return [...state.approvals.entries()]
    .filter(([id, approval]) => state.pin && approval.pinId === state.pin.pinId && !state.revoked.has(id))
    .map(([id, approval]) => ({ approvalEventId: id, kind: approval.kind, to: canonical(approval.to), used: state.approvalDispatch.has(id) || state.approvalAttempt.has(id) }));
}
function openRequests(state) {
  return [...state.requests.values()].filter(r => state.pin && r.pinId === state.pin.pinId && !state.answered.has(r.requestId));
}

function checkExecutor(state, executor, { dispatching = false, approvalEventId = null, requestDigest: request = undefined } = {}) {
  if (!state.pin) return { pinned: false, approvalEventId: null };
  if (dispatching && state.open.size) {
    throw needsDecision(state, executor, `attempt ${[...state.open].join(', ')} started without a recorded result, so its outcome is uncertain`, 'model_pin_execution_uncertain');
  }
  if (sameModel(executor, state.pin)) {
    if (dispatching && state.failures >= MAX_PINNED_FAILURES) throw needsDecision(state, executor, `the pinned model already failed ${state.failures} times`, 'model_pin_retry_limit');
    return { pinned: true, approvalEventId: null };
  }
  const problem = approvalProblem(state, approvalEventId, executor, { request });
  if (problem) throw needsDecision(state, executor, problem);
  return { pinned: true, approvalEventId };
}

function checkStart(state, record) {
  if (!state.pin) return;
  if (!record.attemptId) throw needsDecision(state, record.actualExecutor, 'a run on a pinned task needs an attempt id', 'model_pin_attempt_id_required');
  const others = [...state.open].filter(id => id !== record.attemptId);
  if (others.length) throw needsDecision(state, record.actualExecutor, `attempt ${others.join(', ')} started without a recorded result, so its outcome is uncertain`, 'model_pin_execution_uncertain');
  if (sameModel(record.actualExecutor, state.pin)) {
    if (record.event === 'execution.started' && state.failures >= MAX_PINNED_FAILURES) throw needsDecision(state, record.actualExecutor, `the pinned model already failed ${state.failures} times`, 'model_pin_retry_limit');
    return;
  }
  if (record.dispatchEventId) {
    const dispatch = state.dispatches.get(record.dispatchEventId);
    if (!dispatch) throw needsDecision(state, record.actualExecutor, `dispatch ${record.dispatchEventId} is not a dispatch of this task`);
    if (!sameModel(dispatch.executor, record.actualExecutor)) throw needsDecision(state, record.actualExecutor, `dispatch ${record.dispatchEventId} was prepared for ${describe(dispatch.executor)}`);
    const problem = approvalProblem(state, dispatch.approvalEventId, record.actualExecutor, { dispatchEventId: record.dispatchEventId, attemptId: record.attemptId });
    if (problem) throw needsDecision(state, record.actualExecutor, problem);
    return;
  }
  if (record.approvalEventId) {
    const problem = approvalProblem(state, record.approvalEventId, record.actualExecutor, { attemptId: record.attemptId, request: record.requestDigest || null });
    if (problem) throw needsDecision(state, record.actualExecutor, problem);
    return;
  }
  throw needsDecision(state, record.actualExecutor, 'the run names no approved dispatch or approval for this model');
}

function checkTerminal(state, record) {
  if (!state.pin) return;
  const attempt = record.attemptId ? state.attempts.get(record.attemptId) : null;
  if (attempt && attempt.started && !sameModel(attempt.executor, record.actualExecutor)) {
    throw needsDecision(state, record.actualExecutor, `attempt ${record.attemptId} started with ${describe(attempt.executor)}`, 'model_pin_event_conflict');
  }
  if (sameModel(record.actualExecutor, state.pin)) return;
  if (!attempt || !attempt.started || !attempt.approvalEventId) throw needsDecision(state, record.actualExecutor, `attempt ${record.attemptId || '(none)'} was not started under an approval for this model`);
  if (record.event !== 'execution.failed' && state.revoked.has(attempt.approvalEventId)) throw needsDecision(state, record.actualExecutor, 'the approval was revoked before the result was recorded');
}

function idempotency(state, record) {
  if (!state.pin || !record.attemptId) return null;
  const attempt = state.attempts.get(record.attemptId);
  if (!attempt) return null;
  if (record.event === 'execution.started') {
    if (!attempt.started && attempt.terminal) throw needsDecision(state, record.actualExecutor, `attempt ${record.attemptId} already ended (${attempt.terminal}); a later start record cannot reopen it`, 'model_pin_attempt_already_ended');
    if (!attempt.started) return null;
    if (attempt.startDigest === contentDigest(record)) return { idempotent: attempt.startEventId };
    throw needsDecision(state, record.actualExecutor, `attempt ${record.attemptId} already started with different content`, 'model_pin_event_conflict');
  }
  if (TERMINAL_EVENTS.has(record.event) && attempt.terminal) {
    if (attempt.terminal === record.event && attempt.terminalDigest === contentDigest(record)) return { idempotent: attempt.terminalEventId };
    throw needsDecision(state, record.actualExecutor, `attempt ${record.attemptId} already ended with different content`, 'model_pin_event_conflict');
  }
  return null;
}

function validateAppend(events, record) {
  if (!record) return null;
  if (PIN_EVENTS.has(record.event) && !record.taskId) throw pinError('model_pin_task_required', `${record.event} needs a task id`);
  if (!record.taskId) return null;
  if (record.event === 'model.pinned') {
    const pin = record.pin || {};
    const id = canonical(pin);
    if (!id.provider || !id.model || id.provider !== pin.provider || id.model !== pin.model
      || !/^pin-[0-9a-f-]{16,}$/.test(String(pin.pinId || '')) || !PIN_SOURCES.has(pin.source) || !PIN_SCOPES.has(pin.scope)
      || !/^[0-9a-f]{64}$/.test(String(pin.requestDigest || ''))) {
      throw pinError('model_pin_invalid', 'model.pinned needs a canonical provider and model, a pin id, a known source and scope, and a request digest');
    }
    const state = pinState(events, record.taskId, pin.scope);
    if (state.pin && sameModel(state.pin, pin) && state.pin.requestDigest === pin.requestDigest) return { idempotent: state.pinEventId };
    if (state.pin && !sameModel(state.pin, pin)) throw needsDecision(state, pin, 'changing the pinned model needs the user\'s approval (agents approve-model-change)', 'model_pin_change_requires_approval');
    return null;
  }
  if (record.event === 'model.change.requested') {
    const request = record.request || {};
    const scope = pinScopeOf(events, record.taskId, request.pinId);
    const state = pinState(events, record.taskId, scope || 'execution');
    if (!state.pin || request.pinId !== state.pin.pinId) throw pinError('model_change_scope_mismatch', 'The request does not name the current pin of this task');
    if (request.requestDigest !== state.pin.requestDigest || !sameModel(request.from, state.pin)) throw pinError('model_change_scope_mismatch', 'The request does not match the current pinned request');
    if (!['change', 'retry'].includes(request.kind)) throw pinError('model_change_kind_invalid', 'kind must be change or retry');
    if (request.kind === 'change' && (!canonical(request.to).model || sameModel(request.to, state.pin))) throw pinError('model_change_target_invalid', 'A change must name one specific other provider and model');
    if (request.kind === 'retry' && !sameModel(request.to, state.pin)) throw pinError('model_change_target_invalid', 'A retry names the pinned model');
    if (!/^mreq-[0-9a-f]{10}$/.test(String(request.requestId || '')) || state.allRequestIds.has(request.requestId)) throw pinError('model_change_request_invalid', 'The request id is missing or already used');
    if (request.challenge !== challengeFor({ taskId: record.taskId, ...request })) throw pinError('model_change_request_invalid', 'The confirmation phrase does not match the request');
    return null;
  }
  if (record.event === 'model.change.approved') {
    const approval = record.approval || {};
    if (!approval.requestId) throw pinError('model_change_request_required', 'An approval must answer a recorded approval request');
    const scope = pinScopeOf(events, record.taskId, approval.pinId);
    const state = pinState(events, record.taskId, scope || 'execution');
    const request = state.requests.get(approval.requestId);
    if (!request) throw pinError('model_change_request_unknown', 'No such approval request for this task');
    if (!state.pin || request.pinId !== state.pin.pinId) throw pinError('model_change_scope_mismatch', 'The approval request belongs to an earlier pinned request');
    if (state.answered.has(approval.requestId)) throw pinError('model_change_decision_reused', 'This approval request was already answered');
    if (approval.pinId !== request.pinId || approval.kind !== request.kind || approval.requestDigest !== request.requestDigest
      || !sameModel(approval.from, request.from) || !sameModel(approval.to, request.to)) throw pinError('model_change_scope_mismatch', 'The approval does not match its request');
    if (!HUMAN_VERIFICATION.has(approval.verification)) throw pinError('model_change_not_human', 'A model change needs a human answer; flags and agent judgement are not approval');
    if (approval.confirmationDigest !== digest(request.challenge)) throw pinError('model_change_not_confirmed', 'The answer was not the exact confirmation phrase');
    return null;
  }
  if (record.event === 'model.change.revoked') {
    const known = (events || []).some(e => e && e.taskId === record.taskId && e.event === 'model.change.approved' && e.eventId === record.approvalEventId);
    if (!known) throw pinError('model_change_unknown', 'No such approval for this task');
    return null;
  }
  if (!DISPATCH_EVENTS.has(record.event) && !RUN_EVENTS.has(record.event)) return null;
  const state = pinState(events, record.taskId, scopeOfRecord(record));
  if (!state.pin) return null;
  if (DISPATCH_EVENTS.has(record.event)) {
    checkExecutor(state, record.actualExecutor || record.requestedExecutor, { dispatching: true, approvalEventId: record.approvalEventId || null, requestDigest: record.requestDigest || null });
    return null;
  }
  const repeated = idempotency(state, record);
  if (repeated) return repeated;
  if (START_EVENTS.has(record.event)) checkStart(state, record);
  else checkTerminal(state, record);
  return null;
}

function newPin({ provider, model, source, request, scope = 'execution' }) {
  const id = canonical({ provider, model });
  return {
    pinId: `pin-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}`,
    scope, provider: id.provider, model: id.model, source, requestDigest: requestDigest(request),
  };
}

function newRequest(state, kind, to) {
  const request = { requestId: randomId('mreq-'), pinId: state.pin.pinId, kind, from: canonical(state.pin), to: canonical(to), requestDigest: state.pin.requestDigest };
  return { ...request, challenge: challengeFor({ taskId: state.taskId, ...request }) };
}

const newTaskId = () => randomId('task-');
const newAttemptId = () => randomId('att-');
const callIdentity = executor => ({ ...canonical(executor), identitySource: 'leerness-call' });

function ensurePin(root, { taskId, scope = 'execution', provider, model, source = 'cli-arg', request }) {
  return require('./role-fallback').appendExecutionEvent(root, { event: 'model.pinned', taskId, pin: newPin({ provider, model, source, request, scope }), executed: false });
}

function reserveAttempt(root, { taskId, role, executor, approvalEventId = null, request, attemptId = newAttemptId() }) {
  const written = require('./role-fallback').appendExecutionEvent(root, {
    event: 'execution.started', taskId, attemptId, actualExecutor: callIdentity(executor), approvalEventId, requestDigest: requestDigest(request),
    requestedRole: scopeOfRole(role) === 'review' ? 'reviewer' : null,
    result: { summary: 'attempt reserved before the model call' }, executed: false,
  });
  return { attemptId, event: written.event };
}

function finishAttempt(root, { taskId, attemptId, startedEvent, executor, ok, reportedModel = null, error = null }) {
  return require('./role-fallback').appendExecutionEvent(root, {
    event: ok ? 'execution.completed' : 'execution.failed', taskId, attemptId, actualExecutor: callIdentity(executor),
    ...(startedEvent?.requestedRole ? { requestedRole: startedEvent.requestedRole, parentAttemptId: startedEvent.eventId } : {}),
    reportedModel, modelVerification: ok ? 'provider-reported' : reportedModel ? 'mismatch' : 'unverified',
    result: { summary: ok ? 'model call completed with the provider-reported model' : String(error || 'model call failed').slice(0, 300) },
    evidenceRefs: [`leerness-call:${attemptId}`], executed: true,
  });
}

function pinRequestProblem({ provider, model, source, quote, catalog }) {
  const id = canonical({ provider, model });
  if (!id.provider || !id.model) return { code: 'model_pin_invalid', error: 'a canonical provider and an exact model id are required' };
  if (!PIN_SOURCES.has(source)) return { code: 'model_pin_source_invalid', error: `source must be one of ${[...PIN_SOURCES].join(', ')}` };
  if (source !== 'user-stated') return null;
  const words = String(quote || '').match(/[A-Za-z0-9._:/@+-]+/g) || [];
  if (!words.some(word => word === id.model || word.replace(/[.:]+$/, '') === id.model)) {
    return { code: 'model_pin_needs_exact_id', status: 'NEEDS_DECISION', error: `the user's words must contain the exact model id ${id.model}; ask the user to confirm the exact id` };
  }
  const ids = (Array.isArray(catalog) ? catalog : []).map(item => String(item && item.id || item)).filter(Boolean);
  if (ids.length && !ids.includes(id.model)) {
    const candidates = ids.filter(candidate => candidate.toLowerCase().includes(id.model.toLowerCase()));
    if (candidates.length) return { code: 'model_pin_ambiguous', status: 'NEEDS_DECISION', error: `${id.model} could mean ${candidates.join(', ')}; ask the user which exact id`, candidates };
  }
  return null;
}

function idIssue(value, flag = '--id') {
  if (value == null) return null;
  const raw = String(value);
  if (!raw.trim()) return { code: 'empty_flag_value', error: `${flag} requires a non-empty value` };
  const stored = require('./role-fallback').normalizeProvenanceIdentifier(raw);
  if (stored === raw) return null;
  const shown = JSON.stringify(raw.slice(0, 80));
  return { code: 'invalid_id_value', error: stored
    ? `${flag} ${shown} is not the id the ledger stores (${JSON.stringify(stored)}); pass that exact id — nothing was run or recorded`
    : `${flag} ${shown} is not a valid id (letters, digits and ._:/@+~- only) — nothing was run or recorded` };
}

module.exports = {
  PIN_SOURCES, PIN_SCOPES, HUMAN_VERIFICATION, MAX_PINNED_FAILURES, CHOICES, GUIDANCE, guidance, idIssue,
  digest, requestDigest, canonical, sameModel, describe, scopeOfRole, scopeOfRecord, challengeFor, contentDigest,
  pinState, checkExecutor, unusedApprovalFor, usableApprovalFor, activeApprovals, openRequests, decisionPayload,
  validateAppend, newPin, newRequest, pinRequestProblem, newTaskId, newAttemptId, ensurePin, reserveAttempt, finishAttempt,
};
