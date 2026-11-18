'use strict';
require('./temp-cleanup').trackTemp(module);

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const CLI = path.join(__dirname, '..', 'bin', 'leerness.js');
const { agentsCmd } = require('../lib/agents');
const { appendExecutionEvent, readExecutionEvents, normalizeRoleDefinition } = require('../lib/role-fallback');
const roleStore = require('../lib/role-store');
const mp = require('../lib/model-pin');

for (const key of ['LEERNESS_SESSION_PROVIDER', 'LEERNESS_SESSION_MODEL', 'LEERNESS_SESSION_MODEL_FAMILY', 'LEERNESS_SESSION_ID', 'LEERNESS_MCP_CONNECTION_ID']) delete process.env[key];

const A = { provider: 'alpha', model: 'alpha-model-1' };
const A2 = { provider: 'alpha', model: 'alpha-model-2' };
const B = { provider: 'beta', model: 'beta-model-1' };
const C = { provider: 'gamma', model: 'gamma-model-1' };
const PROVIDERS = ['alpha', 'beta', 'gamma', 'qwen'].map(id => ({ id, bin: process.execPath, envFlag: `LEERNESS_ENABLE_${id.toUpperCase()}`, versionArgs: ['--version'], desc: id }));
const ROLES = {
  coder: { provider: A.provider, model: A.model, primary: { ...A }, candidates: [{ ...B }], fallbackPolicy: 'balanced' },
};

function removeFixture(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  assert.ok(relative && !path.isAbsolute(relative) && !relative.startsWith('..' + path.sep));
  assert.match(relative.split(path.sep)[0], /^leerness-/);
  for (let attempt = 0; ; attempt++) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

function fixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `leerness-model-pin-${name}-`));
  fs.mkdirSync(path.join(dir, '.leerness'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.leerness', 'agent-roles.json'), JSON.stringify({ schemaVersion: 1, roles: ROLES }, null, 2) + '\n', 'utf8');
  return dir;
}

function harness(root, ready = ['alpha', 'beta', 'gamma', 'qwen']) {
  const readySet = new Set(ready);
  const calls = { prepared: [], chat: [], spawn: 0 };
  const deps = {
    VERSION: 'test',
    uiLang: 'en',
    _agentSlashHint: () => null,
    _allProviders: () => PROVIDERS,
    _checkAgent: def => ({ id: def.id, status: readySet.has(def.id) ? 'ready' : 'disabled', installed: true, enabled: readySet.has(def.id), version: 'synthetic', auth: 'ok' }),
    _cliChat: async (_root, provider) => { calls.chat.push(provider); return { ok: true, response: 'synthetic' }; },
    _dispatchCommand: (target, _task, _write, model) => { calls.prepared.push({ provider: target, model: model || null }); return `synthetic ${target} ${model || ''}`; },
    _spawnPortable: () => {
      calls.spawn += 1;
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      process.nextTick(() => { child.stdout.end('synthetic'); child.stderr.end(); child.emit('close', 0); });
      return child;
    },
    _loadEnvFile: () => {},
    _normalizeRole: value => value,
    _policyEnforce: () => ({ allowed: true, advisory: false }),
    _readUserProviders: () => [],
    _recommendAgent: () => ({ target: null, reason: '' }),
    _recordRun: () => null,
    _resolveRole: (dir, role) => {
      const state = roleStore.readRoleStore(dir);
      if (!state.ok || !state.roles || !state.roles[role]) return null;
      const normalized = normalizeRoleDefinition(role, state.roles[role]);
      return {
        role, provider: normalized.primary.provider, model: normalized.primary.model, modelFamily: normalized.primary.modelFamily,
        persona: normalized.persona, candidates: normalized.candidates, fallbackPolicy: normalized.fallbackPolicy,
        requirements: normalized.requirements, primary: normalized.primary, storeRevision: state.revision,
      };
    },
    _withLock: (_file, fn) => fn(),
    _isInteractive: () => false,
    lessonsPath: () => path.join(root, '.leerness', 'lessons.md'),
    taskLogPath: () => path.join(root, '.leerness', 'task-log.md'),
  };
  const prepared = executor => calls.prepared.filter(item => item.provider === executor.provider && (executor.model === undefined || item.model === executor.model)).length;
  return { root, calls, deps, prepared };
}

async function call(h, sub, argv, extra = {}) {
  const outputs = [];
  const previous = { log: console.log, error: console.error };
  console.log = (...parts) => outputs.push(parts.map(String).join(' '));
  console.error = (...parts) => outputs.push(parts.map(String).join(' '));
  process.argv = process.argv.slice();
  process.exitCode = 0;
  const has = flag => argv.includes(flag);
  const arg = (flag, fallback = null) => { const index = argv.indexOf(flag); return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback; };
  const realExit = process.exit;
  process.exit = code => { throw Object.assign(new Error(`agentsCmd called process.exit(${code})`), { probeExit: code }); };
  let ret;
  try { ret = await agentsCmd(h.root, sub, argv, { ...h.deps, has, arg, rawArgv: argv, ...extra }); }
  finally { process.exit = realExit; console.log = previous.log; console.error = previous.error; }
  const exitCode = process.exitCode || 0;
  process.exitCode = 0;
  let json = null;
  for (const chunk of outputs) {
    try { const value = JSON.parse(chunk); if (value && typeof value === 'object') { json = value; break; } } catch {}
  }
  return { ret, exitCode, json, text: outputs.join('\n') };
}

function events(root, name) {
  const history = readExecutionEvents(root, 2000, { preserveAll: true, maxBytes: 64 * 1024 * 1024 });
  assert.strictEqual(history.ok, true, history.error || 'ledger unreadable');
  return name ? history.events.filter(event => event.event === name) : history.events;
}

function assertDecision(result, code) {
  assert.strictEqual(result.exitCode, 1, result.text);
  assert.ok(result.json, `no JSON in: ${result.text}`);
  assert.strictEqual(result.json.status, 'NEEDS_DECISION', result.text);
  if (code) assert.strictEqual(result.json.code, code, result.text);
  if ('executed' in result.json) assert.strictEqual(result.json.executed, false);
  if ('substituted' in result.json) assert.strictEqual(result.json.substituted, false);
}

const dispatch = (h, task, id, executor, more = []) => call(h, 'dispatch', [task, '--id', id,
  ...(executor && executor.provider ? ['--to', executor.provider] : []),
  ...(executor && executor.model ? ['--model', executor.model] : []), ...more, '--json']);
const pin = (h, task, id, executor, more = []) => call(h, 'pin', [task, '--id', id, '--provider', executor.provider, '--model', executor.model, ...more, '--json']);
const requestChange = (h, id, executor, more = [], extra = {}) => call(h, 'approve-model-change', ['--id', id, '--provider', executor.provider, '--model', executor.model, ...more, '--json'], extra);
const answer = (h, id, requestId, reply, extra = {}) => call(h, 'approve-model-change', ['--id', id, '--request', requestId, '--human-reply', reply, '--json'], extra);
async function approve(h, id, executor, more = []) {
  const asked = await requestChange(h, id, executor, more);
  assert.strictEqual(asked.json && asked.json.status, 'NEEDS_DECISION', asked.text);
  assert.ok(asked.json.requestId && asked.json.confirmationPhrase, asked.text);
  return answer(h, id, asked.json.requestId, asked.json.confirmationPhrase);
}
const terminal = (root, taskId, attemptId, executor, eventName, summary = 'synthetic') => appendExecutionEvent(root, {
  event: eventName, taskId, attemptId, actualExecutor: executor, evidenceRefs: ['synthetic-evidence'], result: { summary }, executed: true,
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('an explicit --model pins the task and only that model is prepared', async () => {
  const h = harness(fixture('explicit'));
  try {
    const r = await dispatch(h, 'task one', 'T-1', A);
    assert.strictEqual(r.exitCode, 0, r.text);
    assert.strictEqual(r.json.action, 'dispatch-prepared');
    assert.deepStrictEqual(r.json.modelPin.requested, A);
    const pins = events(h.root, 'model.pinned');
    assert.strictEqual(pins.length, 1);
    assert.strictEqual(pins[0].pin.source, 'cli-arg');
    const [prepared] = events(h.root, 'dispatch.prepared');
    assert.strictEqual(prepared.taskId, 'T-1');
    assert.strictEqual(prepared.actualExecutor.model, A.model);
    assert.deepStrictEqual(prepared.modelPin.passed, A);
    assert.strictEqual(prepared.modelPin.reported, null);
    assert.strictEqual(prepared.modelPin.reportedVerification, 'unverified');
    assert.deepStrictEqual(h.calls.prepared, [A]);
  } finally { removeFixture(h.root); }
});

test('before approval no other provider, version or provider default is prepared', async () => {
  const h = harness(fixture('bypass'));
  try {
    await dispatch(h, 'task one', 'T-1', A);
    assertDecision(await dispatch(h, 'task one', 'T-1', B), 'model_pin_needs_decision');
    assertDecision(await dispatch(h, 'task one', 'T-1', A2), 'model_pin_needs_decision');
    assertDecision(await dispatch(h, 'task one', 'T-1', { provider: B.provider }), 'model_pin_needs_decision');
    assert.throws(() => appendExecutionEvent(h.root, { event: 'dispatch.prepared', taskId: 'T-1', actualExecutor: { provider: A.provider }, executed: false }), error => error.code === 'model_pin_needs_decision');
    assert.throws(() => appendExecutionEvent(h.root, { event: 'fallback.selected', taskId: 'T-1', actualExecutor: B, executed: false }), error => error.code === 'model_pin_needs_decision');
    assert.strictEqual(h.prepared({ provider: B.provider }), 0);
    assert.strictEqual(h.prepared(A2), 0);
    assert.strictEqual(events(h.root, 'dispatch.prepared').length, 1);
    const decision = await dispatch(h, 'task one', 'T-1', B);
    assert.deepStrictEqual(decision.json.requested, A);
    assert.strictEqual(decision.json.choices.length, 3);
  } finally { removeFixture(h.root); }
});

test('a later dispatch, resume or role delegation keeps the pinned model', async () => {
  const h = harness(fixture('resume'));
  try {
    await dispatch(h, 'task one', 'T-1', A);
    const resumed = await dispatch(h, 'task one', 'T-1', null);
    assert.strictEqual(resumed.exitCode, 0, resumed.text);
    assert.deepStrictEqual(h.calls.prepared, [A, A]);
    assert.strictEqual((await pin(h, 'role task', 'T-6', B)).exitCode, 0);
    const role = await call(h, 'dispatch', ['role task', '--role', 'coder', '--id', 'T-6', '--json']);
    assert.strictEqual(role.exitCode, 0, role.text);
    assert.deepStrictEqual(h.calls.prepared[2], B);
    assert.strictEqual((await pin(h, 'role task', 'T-7', C)).exitCode, 0);
    const outsidePolicy = await call(h, 'dispatch', ['role task', '--role', 'coder', '--id', 'T-7', '--json']);
    assert.strictEqual(outsidePolicy.exitCode, 1, outsidePolicy.text);
    assert.match(String(outsidePolicy.json && outsidePolicy.json.code), /^fallback_choice_(blocked|not_found)$/, outsidePolicy.text);
    assert.strictEqual(events(h.root, 'dispatch.prepared').filter(event => event.taskId === 'T-7').length, 0);
    assert.strictEqual(h.prepared({ provider: C.provider }), 0);
    assert.strictEqual(h.prepared({ provider: A.provider }), 2);
  } finally { removeFixture(h.root); }
});

test('refusals, conditions, near names, generic or empty answers, flags and agent-made rows are not approval', async () => {
  const h = harness(fixture('not-approval'));
  try {
    await dispatch(h, 'task one', 'T-1', A);
    const asked = await requestChange(h, 'T-1', B);
    assertDecision(asked, 'model_change_human_answer_required');
    assert.match(asked.json.confirmationPhrase, /^APPROVE mreq-[0-9a-f]{10} T-1 alpha\/alpha-model-1 -> beta\/beta-model-1$/);
    const phrase = asked.json.confirmationPhrase, requestId = asked.json.requestId;
    for (const flag of ['--yes', '--force']) {
      const r = await requestChange(h, 'T-1', B, [flag]);
      assert.strictEqual(r.exitCode, 1);
      assert.strictEqual(r.json.code, 'model_change_flag_not_approval');
    }
    const refusals = ['beta-model-1은 사용하지 마', 'Do not use beta-model-1', 'Only after I approve again, use beta-model-1', 'Use beta-model-10 instead',
      'yes', '계속해', '알아서 해', 'beta-model-1', 'beta/beta-model-1', `${phrase} but only tomorrow`, `not ${phrase}`, phrase.toLowerCase(), phrase.replace('beta-model-1', 'beta-model-10')];
    for (const reply of refusals) assertDecision(await answer(h, 'T-1', requestId, reply), 'model_change_not_approved');
    for (const blank of ['', '   ']) {
      const empty = await answer(h, 'T-1', requestId, blank);
      assert.strictEqual(empty.exitCode, 1);
      assert.strictEqual(empty.json.code, 'empty_flag_value');
    }
    const unbound = await requestChange(h, 'T-1', B, ['--human-reply', phrase]);
    assertDecision(unbound, 'model_change_human_answer_required');
    for (const typed of [null, '', 'yes', 'beta-model-1', 'Do not use beta-model-1']) {
      assertDecision(await call(h, 'approve-model-change', ['--id', 'T-1', '--request', requestId, '--json'], { _isInteractive: () => true, _askHuman: async () => typed }), 'model_change_not_approved');
    }
    const state = mp.pinState(events(h.root), 'T-1');
    const request = state.requests.get(requestId);
    const valid = { requestId, pinId: request.pinId, kind: 'change', from: A, to: B, requestDigest: request.requestDigest, verification: 'host-reported-unverified', confirmationDigest: mp.digest(phrase) };
    for (const [approval, code] of [
      [{ ...valid, verification: 'agent-judgement' }, 'model_change_not_human'],
      [{ ...valid, confirmationDigest: mp.digest('yes') }, 'model_change_not_confirmed'],
      [{ pinId: request.pinId, from: A, to: B, decisionId: 'legacy', verification: 'host-reported-unverified', replyDigest: mp.digest('x') }, 'model_change_request_required'],
      [{ ...valid, to: C }, 'model_change_scope_mismatch'],
      [{ ...valid, requestId: 'mreq-0000000000' }, 'model_change_request_unknown'],
      [{ ...valid, approved: true, verification: undefined }, 'model_change_not_human'],
    ]) assert.throws(() => appendExecutionEvent(h.root, { event: 'model.change.approved', taskId: 'T-1', approval, executed: false }), error => error.code === code, code);
    assert.strictEqual(events(h.root, 'model.change.approved').length, 0);
    assertDecision(await dispatch(h, 'task one', 'T-1', B), 'model_pin_needs_decision');
    await dispatch(h, 'other task', 'T-9', A);
    const otherTask = await answer(h, 'T-9', requestId, phrase);
    assert.strictEqual(otherTask.exitCode, 1);
    assert.strictEqual(otherTask.json.code, 'model_change_request_unknown');
    const wrongTarget = await call(h, 'approve-model-change', ['--id', 'T-1', '--request', requestId, '--provider', C.provider, '--model', C.model, '--human-reply', phrase, '--json']);
    assert.strictEqual(wrongTarget.json.code, 'model_change_target_mismatch');
    assert.strictEqual(h.prepared({ provider: B.provider }), 0);
  } finally { removeFixture(h.root); }
});

test('after the user approves A to B only B is prepared, and only once', async () => {
  const h = harness(fixture('approved'));
  try {
    await dispatch(h, 'task one', 'T-1', A);
    const ok = await approve(h, 'T-1', B);
    assert.strictEqual(ok.exitCode, 0, ok.text);
    assert.strictEqual(ok.json.verification, 'host-reported-unverified');
    assert.notStrictEqual(ok.json.verification, 'tty-typed');
    assert.ok(ok.json.limit);
    assertDecision(await dispatch(h, 'task one', 'T-1', C), 'model_pin_needs_decision');
    assertDecision(await dispatch(h, 'task one, changed', 'T-1', B), 'model_pin_needs_decision');
    assert.strictEqual(h.prepared({ provider: B.provider }), 0);
    const run = await dispatch(h, 'task one', 'T-1', B);
    assert.strictEqual(run.exitCode, 0, run.text);
    assert.strictEqual(run.json.modelPin.approvalEventId, ok.json.approvalEventId);
    const record = events(h.root, 'dispatch.prepared').find(event => event.actualExecutor.provider === B.provider);
    assert.strictEqual(record.substitution.kind, 'approved-model-change');
    assert.strictEqual(record.approvalEventId, ok.json.approvalEventId);
    assertDecision(await dispatch(h, 'task one', 'T-1', B), 'model_pin_needs_decision');
    assert.throws(() => appendExecutionEvent(h.root, { event: 'dispatch.prepared', taskId: 'T-1', actualExecutor: B, approvalEventId: ok.json.approvalEventId, requestDigest: mp.requestDigest('task one'), executed: false }), error => error.code === 'model_pin_needs_decision');
    assert.strictEqual(h.prepared(B), 1);
    assert.strictEqual(h.prepared({ provider: C.provider }), 0);
    const duplicate = await answer(h, 'T-1', ok.json.requestId, mp.pinState(events(h.root), 'T-1').requests.get(ok.json.requestId).challenge);
    assert.strictEqual(duplicate.exitCode, 1);
    assert.strictEqual(duplicate.json.code, 'model_change_decision_reused');
    let shown = null;
    const typed = await requestChange(h, 'T-1', B, [], { _isInteractive: () => true, _askHuman: async question => { shown = /(APPROVE mreq-\S+ \S+ \S+ -> \S+)/.exec(question)[1]; return shown; } });
    assert.strictEqual(typed.exitCode, 0, typed.text);
    assert.strictEqual(typed.json.verification, 'tty-typed');
  } finally { removeFixture(h.root); }
});

test('when the approved model fails nothing moves on to a third model', async () => {
  const h = harness(fixture('b-fails'));
  try {
    await dispatch(h, 'task one', 'T-1', A);
    await approve(h, 'T-1', B);
    const prepared = await dispatch(h, 'task one', 'T-1', B);
    appendExecutionEvent(h.root, { event: 'execution.started', taskId: 'T-1', attemptId: 'attempt-b', actualExecutor: B, dispatchEventId: prepared.json.auditEventId, executed: true });
    terminal(h.root, 'T-1', 'attempt-b', B, 'execution.failed', 'synthetic provider error');
    assertDecision(await dispatch(h, 'task one', 'T-1', C), 'model_pin_needs_decision');
    assertDecision(await dispatch(h, 'task one', 'T-1', B), 'model_pin_needs_decision');
    const next = await dispatch(h, 'task one', 'T-1', null);
    assert.strictEqual(next.exitCode, 0, next.text);
    assert.deepStrictEqual(h.calls.prepared, [A, B, A]);
    assert.strictEqual(h.prepared({ provider: C.provider }), 0);
  } finally { removeFixture(h.root); }
});

test('revoked, superseded and other-task approvals are refused', async () => {
  const h = harness(fixture('scope'));
  try {
    await dispatch(h, 'task one', 'T-1', A);
    const first = await approve(h, 'T-1', B);
    const revoked = await call(h, 'revoke-model-change', ['--id', 'T-1', '--json']);
    assert.strictEqual(revoked.exitCode, 0, revoked.text);
    assert.deepStrictEqual(revoked.json.revoked, [first.json.approvalEventId]);
    assertDecision(await dispatch(h, 'task one', 'T-1', B), 'model_pin_needs_decision');
    assert.throws(() => appendExecutionEvent(h.root, { event: 'dispatch.prepared', taskId: 'T-1', actualExecutor: B, approvalEventId: first.json.approvalEventId, requestDigest: mp.requestDigest('task one'), executed: false }), error => error.code === 'model_pin_needs_decision');
    await approve(h, 'T-1', B);
    assert.strictEqual((await pin(h, 'task two', 'T-1', A)).exitCode, 0);
    assertDecision(await dispatch(h, 'task two', 'T-1', B), 'model_pin_needs_decision');
    await dispatch(h, 'task three', 'T-2', A);
    await approve(h, 'T-1', B);
    assertDecision(await dispatch(h, 'task three', 'T-2', B), 'model_pin_needs_decision');
    assertDecision(await pin(h, 'task two', 'T-1', B), 'model_pin_change_requires_approval');
    assert.throws(() => appendExecutionEvent(h.root, { event: 'model.pinned', taskId: 'T-1', pin: mp.newPin({ ...B, source: 'cli-arg', request: 'task two' }), executed: false }), error => error.code === 'model_pin_change_requires_approval');
    assert.strictEqual(h.prepared({ provider: B.provider }), 0);
  } finally { removeFixture(h.root); }
});

test('an attempt without a recorded result blocks a duplicate run, and retries are bounded', async () => {
  const h = harness(fixture('uncertain'));
  try {
    await dispatch(h, 'task four', 'T-4', A);
    terminal(h.root, 'T-4', 'attempt-1', A, 'execution.started');
    assertDecision(await dispatch(h, 'task four', 'T-4', null), 'model_pin_execution_uncertain');
    assert.throws(() => terminal(h.root, 'T-4', 'attempt-2', A, 'execution.started'), error => error.code === 'model_pin_execution_uncertain');
    terminal(h.root, 'T-4', 'attempt-1', A, 'execution.failed', 'synthetic timeout');
    assert.strictEqual((await dispatch(h, 'task four', 'T-4', null)).exitCode, 0);
    terminal(h.root, 'T-4', 'attempt-3', A, 'execution.failed');
    terminal(h.root, 'T-4', 'attempt-4', A, 'execution.failed');
    const limited = await dispatch(h, 'task four', 'T-4', null);
    assertDecision(limited, 'model_pin_retry_limit');
    assert.strictEqual(limited.json.retried, mp.MAX_PINNED_FAILURES);
    assert.strictEqual(h.prepared(A), 2);
  } finally { removeFixture(h.root); }
});

test('an ended attempt is never open again: a late start is refused and a reload does not reopen it', async () => {
  const h = harness(fixture('late-start'));
  try {
    await dispatch(h, 'task twelve', 'T-12', A);
    terminal(h.root, 'T-12', 'att-x', A, 'execution.completed');
    assert.throws(() => appendExecutionEvent(h.root, { event: 'execution.started', taskId: 'T-12', attemptId: 'att-x', actualExecutor: A, executed: true }), error => error.code === 'model_pin_attempt_already_ended');
    assert.strictEqual(mp.pinState(events(h.root), 'T-12').open.size, 0);
    const resent = terminal(h.root, 'T-12', 'att-x', A, 'execution.completed');
    assert.strictEqual(resent.idempotent, true);
    assert.strictEqual(events(h.root, 'execution.completed').filter(e => e.attemptId === 'att-x').length, 1);
    terminal(h.root, 'T-12', 'att-y', A, 'execution.started');
    terminal(h.root, 'T-12', 'att-y', A, 'execution.completed');
    assert.strictEqual((await dispatch(h, 'task twelve', 'T-12', null)).exitCode, 0);
    const file = path.join(h.root, '.leerness', 'execution-ledger.jsonl');
    const completed = events(h.root, 'execution.completed').find(e => e.attemptId === 'att-x');
    const legacyStart = { ...completed, event: 'execution.started', eventId: 'evt-legacy-late-start', attemptId: 'att-x' };
    delete legacyStart.evidenceRefs;
    fs.appendFileSync(file, JSON.stringify(legacyStart) + '\n');
    assert.strictEqual(events(h.root).filter(e => e.eventId === 'evt-legacy-late-start').length, 1);
    assert.strictEqual(mp.pinState(events(h.root), 'T-12').open.size, 0);
    assert.strictEqual((await dispatch(h, 'task twelve', 'T-12', null)).exitCode, 0);
    terminal(h.root, 'T-12', 'att-z', A, 'execution.started');
    assert.strictEqual(mp.pinState(events(h.root), 'T-12').open.size, 1);
  } finally { removeFixture(h.root); }
});

test('fallback, --approved-by and session takeover do not unlock a pinned task', async () => {
  const h = harness(fixture('fallback'), ['beta', 'gamma']);
  try {
    assert.strictEqual((await pin(h, 'fallback task', 'T-8', A)).exitCode, 0);
    assertDecision(await call(h, 'fallback', ['provider', 'fallback task', '--role', 'coder', '--to', B.provider, '--model', B.model, '--approved-by', 'the user said ok', '--id', 'T-8', '--json']), 'model_pin_needs_decision');
    assertDecision(await call(h, 'fallback', ['session', 'fallback task', '--role', 'coder', '--session-provider', C.provider, '--session-model', C.model, '--id', 'T-8', '--json']), 'model_pin_needs_decision');
    const held = await call(h, 'fallback', ['hold', 'fallback task', '--role', 'coder', '--id', 'T-8', '--json']);
    assert.strictEqual(held.exitCode, 0, held.text);
    assert.strictEqual(events(h.root, 'fallback.selected').filter(event => event.taskId === 'T-8').length, 0);
    assert.strictEqual(h.prepared({ provider: B.provider }), 0);
    assertDecision(await dispatch(h, 'fallback task', 'T-8', null), 'model_pin_unavailable');
    assert.strictEqual(h.calls.prepared.length, 0);
  } finally { removeFixture(h.root); }
});

test('multi, bench and providers that cannot carry a model refuse it', async () => {
  const h = harness(fixture('unsupported'));
  try {
    await dispatch(h, 'task one', 'T-1', A);
    for (const argv of [['multi task', '--model', A.model, '--execute', '--json'], ['multi task', '--id', 'T-1', '--execute', '--json']]) {
      const r = await call(h, 'multi', argv);
      assert.strictEqual(r.exitCode, 1, r.text);
      assert.strictEqual(r.json.code, 'model_pin_unsupported_path');
    }
    for (const argv of [['bench task', '--model', A.model, '--json'], ['bench task', '--id', 'T-1', '--json']]) {
      const r = await call(h, 'bench', argv);
      assert.strictEqual(r.exitCode, 1, r.text);
      assert.strictEqual(r.json.code, 'model_pin_unsupported_path');
    }
    assertDecision(await dispatch(h, 'qwen task', 'T-9', { provider: 'qwen', model: 'qwen-model-1' }), 'model_pin_unsupported_path');
    assert.strictEqual(h.calls.chat.length, 0);
    assert.strictEqual(h.calls.spawn, 0);
    assert.strictEqual(h.prepared({ provider: 'qwen' }), 0);
  } finally { removeFixture(h.root); }
});

test('unpinned routing is unchanged', async () => {
  const h = harness(fixture('unpinned'));
  try {
    const plain = await call(h, 'dispatch', ['plain task', '--to', B.provider, '--json']);
    assert.strictEqual(plain.exitCode, 0, plain.text);
    assert.strictEqual(plain.json.taskId, null);
    assert.strictEqual(plain.json.modelPin, null);
    const role = await call(h, 'dispatch', ['role task', '--role', 'coder', '--json']);
    assert.strictEqual(role.exitCode, 0, role.text);
    assert.deepStrictEqual(h.calls.prepared, [{ provider: B.provider, model: null }, A]);
    assert.strictEqual(events(h.root, 'model.pinned').length, 0);
    const fallbackHarness = harness(h.root, ['beta']);
    const fb = await call(fallbackHarness, 'fallback', ['provider', 'fb task', '--role', 'coder', '--to', B.provider, '--model', B.model, '--json']);
    assert.strictEqual(fb.exitCode, 0, fb.text);
    assert.strictEqual(fb.json.modelPin, null);
  } finally { removeFixture(h.root); }
});

test('ambiguous or unconfirmed model names are asked, not guessed', async () => {
  const h = harness(fixture('alias'));
  try {
    const ambiguous = await pin(h, 'x', 'T-10', { provider: 'claude', model: 'sonnet' }, ['--source', 'user-stated', '--user-words', 'use sonnet for this']);
    assert.strictEqual(ambiguous.exitCode, 1);
    assert.strictEqual(ambiguous.json.code, 'model_pin_ambiguous');
    assert.ok(ambiguous.json.candidates.length >= 1);
    for (const quoted of ['alpha-model-1-mini','new-alpha-model-1','alpha-model-1.2','org/alpha-model-1']) {
      const partial = await pin(h, 'x', 'T-10', A, ['--source','user-stated','--user-words','Please use ' + quoted + '.']);
      assert.strictEqual(partial.json.code, 'model_pin_needs_exact_id');
    }
    const guessed = await pin(h, 'x', 'T-10', { provider: 'claude', model: 'claude-sonnet-4-5' }, ['--source', 'user-stated', '--user-words', '소넷으로 해줘']);
    assert.strictEqual(guessed.json.code, 'model_pin_needs_exact_id');
    const badSource = await pin(h, 'x', 'T-10', A, ['--source', 'agent-guess']);
    assert.strictEqual(badSource.json.code, 'model_pin_source_invalid');
    assert.strictEqual(events(h.root, 'model.pinned').length, 0);
    const stated = await pin(h, 'x', 'T-10', A, ['--source', 'user-stated', '--user-words', 'please use (alpha-model-1).']);
    assert.strictEqual(stated.exitCode, 0, stated.text);
    assert.strictEqual(events(h.root, 'model.pinned')[0].pin.model, A.model);
  } finally { removeFixture(h.root); }
});

test('a completion by another or an unnamed model is not recorded as done', async () => {
  const h = harness(fixture('completion'));
  try {
    await dispatch(h, 'task eleven', 'T-11', A);
    const record = (executor) => call(h, 'record', ['completed', 'synthetic result', '--task', 'T-11', '--id', `attempt-${executor.model || 'none'}`,
      '--provider', executor.provider, ...(executor.model ? ['--model', executor.model] : []), '--evidence', 'synthetic-evidence', '--json']);
    for (const executor of [B, { provider: A.provider }]) {
      const refused = await record(executor);
      assert.strictEqual(refused.exitCode, 1, refused.text);
      assert.strictEqual(refused.json && refused.json.code, 'model_pin_needs_decision', refused.text);
    }
    assert.strictEqual(events(h.root, 'execution.completed').length, 0);
    const done = await record(A);
    assert.strictEqual(done.exitCode, 0, done.text);
    assert.strictEqual(events(h.root, 'execution.completed').length, 1);
  } finally { removeFixture(h.root); }
});

const resolve = (h, task, more = []) => call(h, 'resolve', [task, '--role', 'coder', ...more, '--json']);
const fallbackTo = (h, task, id, executor) => call(h, 'fallback', ['provider', task, '--role', 'coder', '--to', executor.provider, '--model', executor.model, '--id', id, '--json']);
const optionFor = (out, executor) => out.json.resolution.options.find(o => o.executor && o.executor.provider === executor.provider && o.executor.model === executor.model);

test('resolve keeps an explicit task id and its pin through fallback and dispatch', async () => {
  const h = harness(fixture('resolve-id'));
  try {
    assert.strictEqual((await pin(h, 'task twenty', 'T-20', A)).exitCode, 0);
    const routed = await resolve(h, 'task twenty', ['--id', 'T-20']);
    assert.strictEqual(routed.exitCode, 0, routed.text);
    assert.strictEqual(routed.json.taskId, 'T-20');
    assert.deepStrictEqual(routed.json.modelPin.requested, A);
    assert.strictEqual(optionFor(routed, A).modelPin, 'pinned-model');
    assert.strictEqual(optionFor(routed, B).modelPin, 'needs-approval');
    assert.deepStrictEqual(events(h.root, 'routing.proposed').map(e => e.taskId), ['T-20']);
    assertDecision(await fallbackTo(h, 'task twenty', routed.json.taskId, B), 'model_pin_needs_decision');
    assertDecision(await dispatch(h, 'task twenty', routed.json.taskId, B), 'model_pin_needs_decision');
    assertDecision(await dispatch(h, 'task twenty', routed.json.taskId, A2), 'model_pin_needs_decision');
    assertDecision(await dispatch(h, 'task twenty', routed.json.taskId, { provider: B.provider }), 'model_pin_needs_decision');
    assert.strictEqual(h.prepared(B), 0);
    assert.strictEqual(h.prepared(A2), 0);
    assert.strictEqual(h.prepared({ provider: B.provider }), 0);
    const kept = await fallbackTo(h, 'task twenty', routed.json.taskId, A);
    assert.strictEqual(kept.exitCode, 0, kept.text);
    assert.strictEqual(h.prepared(A), 1);
    assert.deepStrictEqual(events(h.root, 'fallback.selected').map(e => [e.taskId, `${e.actualExecutor.provider}/${e.actualExecutor.model}`]), [['T-20', `${A.provider}/${A.model}`]]);
    assert.strictEqual(events(h.root).filter(e => e.taskId && e.taskId !== 'T-20').length, 0);
  } finally { removeFixture(h.root); }
});

test('resolve shows an approved model; the approval prepares B once and never for another task', async () => {
  const h = harness(fixture('resolve-approved'));
  try {
    assert.strictEqual((await pin(h, 'task twenty-one', 'T-21', A)).exitCode, 0);
    assert.strictEqual((await pin(h, 'task twenty-two', 'T-22', A)).exitCode, 0);
    assert.strictEqual((await approve(h, 'T-21', B)).exitCode, 0);
    const routed = await resolve(h, 'task twenty-one', ['--id', 'T-21']);
    assert.strictEqual(routed.exitCode, 0, routed.text);
    assert.strictEqual(optionFor(routed, B).modelPin, 'approved');
    assertDecision(await fallbackTo(h, 'task twenty-two', 'T-22', B), 'model_pin_needs_decision');
    const first = await fallbackTo(h, 'task twenty-one', 'T-21', B);
    assert.strictEqual(first.exitCode, 0, first.text);
    assert.ok(first.json.command && first.json.modelPin.approvalEventId, first.text);
    assertDecision(await fallbackTo(h, 'task twenty-one', 'T-21', B), 'model_pin_needs_decision');
    assertDecision(await dispatch(h, 'task twenty-one', 'T-21', B), 'model_pin_needs_decision');
    assert.strictEqual(h.prepared(B), 1);
    const after = await resolve(h, 'task twenty-one', ['--id', 'T-21']);
    assert.strictEqual(optionFor(after, B).modelPin, 'needs-approval');
  } finally { removeFixture(h.root); }
});

test('a pinned model that failed is not replaced by an automatic fallback', async () => {
  const h = harness(fixture('resolve-failed'));
  try {
    assert.strictEqual((await pin(h, 'task twenty-three', 'T-23', A)).exitCode, 0);
    for (const attempt of ['f-1', 'f-2', 'f-3']) {
      terminal(h.root, 'T-23', attempt, A, 'execution.started');
      terminal(h.root, 'T-23', attempt, A, 'execution.failed');
    }
    const routed = await resolve(h, 'task twenty-three', ['--id', 'T-23']);
    assert.strictEqual(routed.exitCode, 0, routed.text);
    assert.strictEqual(routed.json.taskId, 'T-23');
    assert.strictEqual(routed.json.modelPin.failures, 3);
    assertDecision(await fallbackTo(h, 'task twenty-three', 'T-23', B), 'model_pin_needs_decision');
    assertDecision(await fallbackTo(h, 'task twenty-three', 'T-23', A), 'model_pin_retry_limit');
    assertDecision(await dispatch(h, 'task twenty-three', 'T-23', null), 'model_pin_retry_limit');
    assert.strictEqual(h.calls.prepared.length, 0);
  } finally { removeFixture(h.root); }
});

test('resolve without --id or with an unpinned or empty --id keeps its earlier behaviour', async () => {
  const h = harness(fixture('resolve-plain'));
  try {
    const plain = await resolve(h, 'plain task');
    assert.strictEqual(plain.exitCode, 0, plain.text);
    assert.match(plain.json.taskId, /^task-[0-9a-f-]{36}$/);
    assert.strictEqual(plain.json.modelPin, null);
    assert.ok(plain.json.resolution.options.every(o => !('modelPin' in o)));
    const named = await resolve(h, 'named task', ['--id', 'T-24']);
    assert.strictEqual(named.exitCode, 0, named.text);
    assert.strictEqual(named.json.taskId, 'T-24');
    assert.strictEqual(named.json.modelPin, null);
    for (const value of ['', '   ']) {
      const empty = await resolve(h, 'empty id', ['--id', value]);
      assert.strictEqual(empty.exitCode, 1, empty.text);
      assert.strictEqual(empty.json.code, 'empty_flag_value', empty.text);
    }
    assert.deepStrictEqual(events(h.root, 'routing.proposed').map(e => e.taskId), [plain.json.taskId, 'T-24']);
  } finally { removeFixture(h.root); }
});

test('an id that is not the stored id is refused before any lookup, preparation or record', async () => {
  const h = harness(fixture('id-canonical'));
  try {
    assert.strictEqual((await pin(h, 'task forty', 'T-40', A)).exitCode, 0);
    const refused = (out, code) => { assert.strictEqual(out.exitCode, 1, out.text); assert.strictEqual(out.json && out.json.code, code, out.text); };
    for (const id of [' T-40 ', 'T-40 ', '​T-40', 'Ｔ-40', 'T 40']) {
      refused(await pin(h, 'task forty', id, A), 'invalid_id_value');
      refused(await resolve(h, 'task forty', ['--id', id]), 'invalid_id_value');
      refused(await fallbackTo(h, 'task forty', id, B), 'invalid_id_value');
      refused(await dispatch(h, 'task forty', id, { provider: B.provider }), 'invalid_id_value');
      refused(await dispatch(h, 'task forty', id, A2), 'invalid_id_value');
      refused(await call(h, 'record', ['started', 'started b-1', '--task', id, '--id', 'b-1', '--provider', B.provider, '--model', B.model, '--evidence', 'stub', '--json']), 'invalid_id_value');
    }
    refused(await call(h, 'record', ['started', 'started a-1', '--task', 'T-40', '--id', ' a-1 ', '--provider', A.provider, '--model', A.model, '--evidence', 'stub', '--json']), 'invalid_id_value');
    assert.strictEqual(h.calls.prepared.length, 0);
    assert.deepStrictEqual(events(h.root).map(e => e.event), ['model.pinned']);
    assertDecision(await dispatch(h, 'task forty', 'T-40', { provider: B.provider }), 'model_pin_needs_decision');
  } finally { removeFixture(h.root); }
});

test('dispatch returns no command when the ledger refuses it for a pin written after the lookup', async () => {
  const h = harness(fixture('dispatch-race'));
  try {
    const racingPin = (target, _task, _write, model) => {
      h.calls.prepared.push({ provider: target, model: model || null });
      mp.ensurePin(h.root, { taskId: 'T-41', provider: A.provider, model: A.model, request: 'task forty-one' });
      return `synthetic ${target}`;
    };
    const out = await call(h, 'dispatch', ['task forty-one', '--id', 'T-41', '--to', B.provider, '--json'], { _dispatchCommand: racingPin });
    assert.strictEqual(out.exitCode, 1, out.text);
    assert.ok(out.json && out.json.ok === false && /^model_pin_/.test(out.json.code), out.text);
    assert.strictEqual(out.json.command, undefined);
    assert.strictEqual(events(h.root, 'dispatch.prepared').length, 0);
    assert.strictEqual(events(h.root, 'model.pinned').length, 1);
  } finally { removeFixture(h.root); }
});

test('the printed follow-up commands keep the task id, so following them still needs approval', async () => {
  const h = harness(fixture('resolve-text'));
  try {
    assert.strictEqual((await pin(h, 'task forty-two', 'T-42', A)).exitCode, 0);
    const text = await call(h, 'resolve', ['task forty-two', '--role', 'coder', '--id', 'T-42']);
    assert.strictEqual(text.exitCode, 0, text.text);
    const lines = text.text.split('\n').map(l => l.trim()).filter(l => l.startsWith('leerness agents fallback '));
    assert.strictEqual(lines.length, 4, text.text);
    assert.ok(lines.every(l => l.includes(' --id T-42')), lines.join('\n'));
    const filled = lines[0].replace(' --to <provider> [--model <model>]', ` --to ${B.provider} --model ${B.model}`);
    const tokens = filled.match(/"[^"]*"|\S+/g).map(token => token.replace(/^"|"$/g, '')).slice(2);
    assertDecision(await call(h, tokens[0], [...tokens.slice(1), '--json']), 'model_pin_needs_decision');
    assert.strictEqual(h.prepared(B), 0);
    assert.deepStrictEqual(events(h.root).filter(e => e.taskId !== 'T-42').map(e => e.event), []);
    const blocked = harness(h.root, ['beta']);
    const dispatched = await call(blocked, 'dispatch', ['task forty-three', '--role', 'coder', '--id', 'T-43']);
    const blockedLines = dispatched.text.split('\n').map(l => l.trim()).filter(l => l.startsWith('leerness agents fallback '));
    assert.ok(blockedLines.length === 4 && blockedLines.every(l => l.includes(' --id T-43')), dispatched.text);
  } finally { removeFixture(h.root); }
});

test('a completion that differs only in the reported model or its verification is a conflict', async () => {
  const h = harness(fixture('reported-model'));
  try {
    assert.strictEqual((await pin(h, 'task thirty', 'T-30', A)).exitCode, 0);
    const { attemptId } = mp.reserveAttempt(h.root, { taskId: 'T-30', executor: A, request: 'task thirty' });
    mp.finishAttempt(h.root, { taskId: 'T-30', attemptId, executor: A, ok: true, reportedModel: `${A.model}:latest` });
    const stored = events(h.root, 'execution.completed').find(e => e.attemptId === attemptId);
    assert.strictEqual(stored.reportedModel, `${A.model}:latest`);
    assert.strictEqual(stored.modelVerification, 'provider-reported');
    const { eventId, at, schemaVersion, sessionId, ...same } = stored;
    const conflict = error => error.code === 'model_pin_event_conflict';
    assert.strictEqual(appendExecutionEvent(h.root, { ...same }).idempotent, true);
    assert.throws(() => appendExecutionEvent(h.root, { ...same, reportedModel: `${A2.model}:latest` }), conflict);
    assert.throws(() => appendExecutionEvent(h.root, { ...same, reportedModel: null }), conflict);
    assert.throws(() => appendExecutionEvent(h.root, { ...same, modelVerification: 'unverified' }), conflict);
    assert.throws(() => appendExecutionEvent(h.root, { ...same, actualExecutor: { ...same.actualExecutor, provider: B.provider } }), error => /model_pin/.test(error.code));
    assert.throws(() => appendExecutionEvent(h.root, { ...same, event: 'execution.failed' }), conflict);
    assert.throws(() => appendExecutionEvent(h.root, { ...same, event: 'execution.started' }), conflict);
    assert.strictEqual(events(h.root).filter(e => e.attemptId === attemptId && e.event !== 'execution.started').length, 1);
    assert.strictEqual(events(h.root).filter(e => e.attemptId === attemptId && e.event === 'execution.started').length, 1);
    assert.strictEqual(mp.pinState(events(h.root), 'T-30').open.size, 0);
  } finally { removeFixture(h.root); }
});

test('a legacy completion without model fields stays idempotent and is not merged with a reported model', async () => {
  const h = harness(fixture('reported-legacy'));
  try {
    assert.strictEqual((await pin(h, 'task thirty-one', 'T-31', A)).exitCode, 0);
    terminal(h.root, 'T-31', 'old-1', A, 'execution.started');
    terminal(h.root, 'T-31', 'old-1', A, 'execution.completed');
    const stored = events(h.root, 'execution.completed').find(e => e.attemptId === 'old-1');
    assert.ok(!('reportedModel' in stored) && !('modelVerification' in stored));
    assert.strictEqual(terminal(h.root, 'T-31', 'old-1', A, 'execution.completed').idempotent, true);
    const { eventId, at, schemaVersion, sessionId, ...same } = stored;
    assert.strictEqual(appendExecutionEvent(h.root, { ...same, reportedModel: null }).idempotent, true);
    assert.throws(() => appendExecutionEvent(h.root, { ...same, reportedModel: A.model, modelVerification: 'provider-reported' }), error => error.code === 'model_pin_event_conflict');
    assert.strictEqual(events(h.root, 'execution.completed').filter(e => e.attemptId === 'old-1').length, 1);
    assert.strictEqual((await dispatch(h, 'task thirty-one', 'T-31', null)).exitCode, 0);
  } finally { removeFixture(h.root); }
});

test('an approved change records the reported model of that run and refuses another report for it', async () => {
  const h = harness(fixture('reported-approved'));
  try {
    assert.strictEqual((await pin(h, 'task thirty-two', 'T-32', A)).exitCode, 0);
    const approved = await approve(h, 'T-32', B);
    assert.strictEqual(approved.exitCode, 0, approved.text);
    const { attemptId } = mp.reserveAttempt(h.root, { taskId: 'T-32', executor: B, approvalEventId: approved.json.approvalEventId, request: 'task thirty-two' });
    mp.finishAttempt(h.root, { taskId: 'T-32', attemptId, executor: B, ok: true, reportedModel: B.model });
    const stored = events(h.root, 'execution.completed').find(e => e.attemptId === attemptId);
    assert.deepStrictEqual([stored.actualExecutor.model, stored.reportedModel, stored.modelVerification], [B.model, B.model, 'provider-reported']);
    const { eventId, at, schemaVersion, sessionId, ...same } = stored;
    assert.strictEqual(appendExecutionEvent(h.root, { ...same }).idempotent, true);
    assert.throws(() => appendExecutionEvent(h.root, { ...same, reportedModel: C.model }), error => error.code === 'model_pin_event_conflict');
    assert.throws(() => mp.reserveAttempt(h.root, { taskId: 'T-32', executor: B, approvalEventId: approved.json.approvalEventId, request: 'task thirty-two' }), error => error.code === 'model_pin_needs_decision');
  } finally { removeFixture(h.root); }
});

function runCli(args, cwd, env = {}, input = '') {
  return new Promise(resolve => {
    const child = cp.spawn(process.execPath, [CLI, ...args], {
      cwd, env: { ...process.env, LEERNESS_NO_BANNER: '1', LEERNESS_NO_PROMPT: '1', LEERNESS_NO_DRIFT_CHECK: '1', LEERNESS_NO_STALE_CHECK: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('close', status => { clearTimeout(timer); let json = null; try { json = JSON.parse(stdout.trim()); } catch {} resolve({ status, stdout, stderr, json }); });
    child.stdin.end(input);
  });
}

test('the real CLI keeps the pin and needs a human answer before another model', async () => {
  const dir = fixture('cli');
  try {
    fs.writeFileSync(path.join(dir, '.leerness', 'providers.json'), JSON.stringify({ schemaVersion: 1, providers: [
      { id: 'live', bin: 'node', envFlag: 'LEERNESS_ENABLE_LIVE', versionArgs: ['--version'], desc: 'live' },
      { id: 'spare', bin: 'node', envFlag: 'LEERNESS_ENABLE_SPARE', versionArgs: ['--version'], desc: 'spare' },
    ] }, null, 2));
    fs.writeFileSync(path.join(dir, '.leerness', 'agent-roles.json'), JSON.stringify({ schemaVersion: 1, roles: {
      coder: { provider: 'live', model: 'live-model-1', primary: { provider: 'live', model: 'live-model-1' }, candidates: [{ provider: 'spare', model: 'spare-model-1' }], fallbackPolicy: 'balanced' },
    } }, null, 2) + '\n');
    const env = { LEERNESS_ENABLE_LIVE: '1', LEERNESS_ENABLE_SPARE: '1' };
    const base = ['--path', dir, '--json'];
    const first = await runCli(['agents', 'dispatch', 'cli task', '--to', 'live', '--model', 'live-model-1', '--id', 'T-C', ...base], dir, env);
    assert.strictEqual(first.status, 0, first.stdout + first.stderr);
    const blocked = await runCli(['agents', 'dispatch', 'cli task', '--to', 'spare', '--model', 'spare-model-1', '--id', 'T-C', ...base], dir, env);
    assert.strictEqual(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.strictEqual(blocked.json.status, 'NEEDS_DECISION');
    assert.ok(!/spare-model-1"/.test(blocked.json.command || ''));
    const eof = await runCli(['agents', 'approve-model-change', '--id', 'T-C', '--provider', 'spare', '--model', 'spare-model-1', ...base], dir, env, '');
    assert.strictEqual(eof.status, 1);
    assert.strictEqual(eof.json.code, 'model_change_human_answer_required');
    const refused = await runCli(['agents', 'approve-model-change', '--id', 'T-C', '--request', eof.json.requestId, '--human-reply', 'Do not use spare-model-1', ...base], dir, env);
    assert.strictEqual(refused.status, 1);
    assert.strictEqual(refused.json.code, 'model_change_not_approved');
    const approved = await runCli(['agents', 'approve-model-change', '--id', 'T-C', '--request', eof.json.requestId, '--human-reply', eof.json.confirmationPhrase, ...base], dir, env);
    assert.strictEqual(approved.status, 0, approved.stdout + approved.stderr);
    const second = await runCli(['agents', 'dispatch', 'cli task', '--to', 'spare', '--model', 'spare-model-1', '--id', 'T-C', ...base], dir, env);
    assert.strictEqual(second.status, 0, second.stdout + second.stderr);
    assert.match(second.json.command, /spare-model-1/);
    const again = await runCli(['agents', 'dispatch', 'cli task', '--to', 'spare', '--model', 'spare-model-1', '--id', 'T-C', ...base], dir, env);
    assert.strictEqual(again.status, 1);
    const fallback = await runCli(['agents', 'fallback', 'provider', 'cli task', '--role', 'coder', '--to', 'spare', '--model', 'spare-model-1', '--id', 'T-C', ...base], dir, { ...env, LEERNESS_ENABLE_LIVE: '0' });
    assert.strictEqual(fallback.status, 1, fallback.stdout + fallback.stderr);
    assert.strictEqual(fallback.json.status, 'NEEDS_DECISION', fallback.stdout);
    const fresh = await runCli(['agents', 'fallback', 'provider', 'cli task', '--role', 'coder', '--to', 'spare', '--model', 'spare-model-1', ...base], dir, { ...env, LEERNESS_ENABLE_LIVE: '0' });
    assert.strictEqual(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.strictEqual(events(dir, 'dispatch.prepared').filter(event => event.actualExecutor.provider === 'spare').length, 1);
  } finally { removeFixture(dir); }
});

test('one-shot refuses a model the CLI path cannot pass and never spawns it', async () => {
  const dir = fixture('oneshot');
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leerness-model-pin-shim-'));
  try {
    const marker = path.join(shimDir, 'called.txt');
    if (process.platform === 'win32') fs.writeFileSync(path.join(shimDir, 'claude.cmd'), `@echo off\r\necho called> "${marker}"\r\necho shim\r\n`);
    else { fs.writeFileSync(path.join(shimDir, 'claude'), `#!/bin/sh\necho called > "${marker}"\necho shim\n`); fs.chmodSync(path.join(shimDir, 'claude'), 0o755); }
    const env = { PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`, LEERNESS_ENABLE_CLAUDE: '1' };
    const r = await runCli(['agent', 'one shot task', '--provider', 'claude', '--model', 'some-exact-model', '--path', dir], dir, env);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /model_pin_unsupported_path|cannot pass model/);
    assert.strictEqual(fs.existsSync(marker), false, 'the claude shim was spawned');
  } finally { removeFixture(dir); removeFixture(shimDir); }
});

test('ollama gets the requested model and a different reported model is not used', async () => {
  const dir = fixture('ollama');
  const requests = [];
  let reply = 'other-model:latest';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { requests.push(JSON.parse(body).model); } catch { requests.push(null); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: reply, response: 'synthetic answer' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { LEERNESS_OLLAMA_BASE_URL: `http://127.0.0.1:${server.address().port}`, LEERNESS_ENABLE_OLLAMA: '1' };
    const mismatch = await runCli(['agent', 'ollama task', '--provider', 'ollama', '--model', 'pinned-model', '--path', dir], dir, env);
    assert.strictEqual(mismatch.status, 1, mismatch.stdout + mismatch.stderr);
    assert.match(mismatch.stdout + mismatch.stderr, /model mismatch/);
    assert.doesNotMatch(mismatch.stdout, /synthetic answer/);
    reply = 'pinned-model:latest';
    const match = await runCli(['agent', 'ollama task', '--provider', 'ollama', '--model', 'pinned-model', '--path', dir], dir, env);
    assert.strictEqual(match.status, 0, match.stdout + match.stderr);
    assert.match(match.stdout, /synthetic answer/);
    assert.deepStrictEqual(requests, ['pinned-model', 'pinned-model']);
  } finally { await new Promise(resolve => server.close(resolve)); removeFixture(dir); }
});

test('migrating the previous generated guidance adds the rule once and keeps user edits', async () => {
  const legacy = require('./fixtures/previous-model-guidance.json').files;
  const install = ['--yes', '--no-setup-agents', '--no-mcp', '--no-auto-roadmap', '--no-official-skills', '--no-banner'];
  const TAG = '<!-- leerness:migration-preserved -->';
  const files = ['AGENTS.md', '.github/copilot-instructions.md'];
  for (const [key, old] of Object.entries(legacy)) {
    const [lang, mode] = key.split('-');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `leerness-model-pin-migrate-${key}-`));
    try {
      assert.strictEqual((await runCli(['init', dir, '--language', lang, '--mode', mode, ...install], dir)).status, 0);
      const fresh = Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
      for (const f of files) {
        assert.notStrictEqual(old[f], fresh[f], `${key} ${f}: the fixture must predate the rule`);
        assert.ok(!old[f].includes(mp.guidance(lang)));
        fs.writeFileSync(path.join(dir, f), old[f]);
      }
      const clean = await runCli(['migrate', dir], dir);
      assert.strictEqual(clean.status, 0, clean.stdout + clean.stderr);
      for (const f of files) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.strictEqual(text, fresh[f], `${key} ${f}: untouched previous guidance was not replaced exactly`);
        assert.strictEqual(text.split(mp.guidance(lang)).length - 1, 1);
        assert.ok(!text.includes(TAG));
      }
      const custom = 'CUSTOM user line é é kept';
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), old['AGENTS.md'].trimEnd() + '\n\n' + custom + '\n');
      const edited = await runCli(['migrate', dir], dir);
      assert.strictEqual(edited.status, 0, edited.stdout + edited.stderr);
      const text = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
      assert.ok(text.includes(custom), `${key}: user line lost`);
      assert.ok(text.startsWith(fresh['AGENTS.md'].trimEnd()));
      assert.strictEqual(text.split(TAG).length - 1, 1);
    } finally { removeFixture(dir); }
  }
});

let unhandled = 0;
process.on('unhandledRejection', error => { unhandled++; console.error(`✗ unhandled rejection: ${(error && error.stack) || error}`); });
(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`✓ ${name}`); }
    catch (error) { failed++; console.error(`✗ ${name}: ${error.stack || error.message}`); }
  }
  console.log(`model-pin-probe: ${passed} passed, ${failed} failed, ${unhandled} unhandled`);
  process.exitCode = failed || unhandled || passed !== tests.length ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
