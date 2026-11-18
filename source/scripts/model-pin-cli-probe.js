'use strict';
require('./temp-cleanup').trackTemp(module);

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'bin', 'leerness.js');

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

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `leerness-model-pin-cli-${name}-`));
  fs.mkdirSync(path.join(dir, '.leerness'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.leerness', 'providers.json'), JSON.stringify({ schemaVersion: 1, providers: [
    { id: 'live', bin: 'node', envFlag: 'LEERNESS_ENABLE_LIVE', versionArgs: ['--version'], desc: 'live' },
    { id: 'spare', bin: 'node', envFlag: 'LEERNESS_ENABLE_SPARE', versionArgs: ['--version'], desc: 'spare' },
  ] }, null, 2));
  fs.writeFileSync(path.join(dir, '.leerness', 'agent-roles.json'), JSON.stringify({ schemaVersion: 1, roles: {
    coder: { provider: 'live', model: 'live-model-1', primary: { provider: 'live', model: 'live-model-1' }, candidates: [{ provider: 'spare', model: 'spare-model-1' }], fallbackPolicy: 'balanced' },
  } }, null, 2) + '\n');
  return dir;
}

function ledger(dir) {
  const file = path.join(dir, '.leerness', 'execution-ledger.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

function stub() {
  const s = { requests: [], mode: 'ok', delay: 0, root: null };
  s.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let model = null; try { model = JSON.parse(body).model; } catch {}
      s.requests.push({ model, ledgerAtCall: s.root ? ledger(s.root).map(e => ({ event: e.event, taskId: e.taskId, attemptId: e.attemptId || null })) : [] });
      setTimeout(() => {
        if (s.mode === 'fail') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'stub provider failure' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: `${model}:latest`, response: 'stub answer' }));
      }, s.delay);
    });
  });
  return s;
}

function run(dir, s, args, { input = '', env = {} } = {}) {
  return new Promise(resolve => {
    const child = cp.spawn(process.execPath, [CLI, ...args, '--path', dir], {
      cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LEERNESS_NO_BANNER: '1', LEERNESS_NO_PROMPT: '1', LEERNESS_NO_DRIFT_CHECK: '1', LEERNESS_NO_STALE_CHECK: '1',
        LEERNESS_ENABLE_LIVE: '1', LEERNESS_ENABLE_SPARE: '1', LEERNESS_ENABLE_OLLAMA: '1', LEERNESS_OLLAMA_BASE_URL: `http://127.0.0.1:${s.server.address().port}`, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('close', status => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout.trim()); } catch { const at = stdout.indexOf('{'); if (at >= 0) { try { json = JSON.parse(stdout.slice(at)); } catch {} } }
      resolve({ status, stdout, stderr, text: stdout + stderr, json });
    });
    child.stdin.end(input);
  });
}

const sent = (s, model) => s.requests.filter(r => r.model === model).length;
const agent = (dir, s, task, id, model, more = []) => run(dir, s, ['agent', task, '--provider', 'ollama', '--model', model, '--id', id, ...more]);
async function approve(dir, s, id, provider, model) {
  const asked = await run(dir, s, ['agents', 'approve-model-change', '--id', id, '--provider', provider, '--model', model, '--json']);
  assert.strictEqual(asked.status, 1, asked.text);
  assert.strictEqual(asked.json.code, 'model_change_human_answer_required', asked.text);
  const confirmed = await run(dir, s, ['agents', 'approve-model-change', '--id', id, '--request', asked.json.requestId, '--human-reply', asked.json.confirmationPhrase, '--json']);
  assert.strictEqual(confirmed.status, 0, confirmed.text);
  assert.strictEqual(confirmed.json.verification, 'host-reported-unverified');
  return confirmed.json;
}
const record = (dir, s, verb, id, attempt, provider, model, more = []) => run(dir, s, ['agents', 'record', verb, `${verb} ${attempt}`, '--task', id, '--id', attempt,
  '--provider', provider, '--model', model, '--evidence', 'stub-evidence', ...more, '--json']);
const count = (dir, event, pred = () => true) => ledger(dir).filter(e => e.event === event && pred(e)).length;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function withProject(name, fn) {
  const dir = project(name), s = stub();
  s.root = dir;
  await new Promise(resolve => s.server.listen(0, '127.0.0.1', resolve));
  try { await fn(dir, s); }
  finally { await new Promise(resolve => s.server.close(resolve)); removeFixture(dir); }
}

test('one-shot pins and reserves before the call and records the result after it', () => withProject('lifecycle', async (dir, s) => {
  const r = await agent(dir, s, 'one', 'T-1', 'oa-1');
  assert.strictEqual(r.status, 0, r.text);
  assert.strictEqual(sent(s, 'oa-1'), 1);
  const atCall = s.requests[0].ledgerAtCall.filter(e => e.taskId === 'T-1').map(e => e.event);
  assert.deepStrictEqual(atCall, ['model.pinned', 'execution.started']);
  const events = ledger(dir).filter(e => e.taskId === 'T-1');
  assert.deepStrictEqual(events.map(e => e.event), ['model.pinned', 'execution.started', 'execution.completed']);
  assert.strictEqual(events[2].attemptId, events[1].attemptId);
  assert.strictEqual(events[2].reportedModel, 'oa-1:latest');
  assert.strictEqual(events[2].actualExecutor.model, 'oa-1');
}));

test('after A, an unapproved B gets no request', () => withProject('no-approval', async (dir, s) => {
  assert.strictEqual((await agent(dir, s, 'one', 'T-1', 'oa-1')).status, 0);
  const b = await agent(dir, s, 'one', 'T-1', 'ob-1');
  assert.strictEqual(b.status, 1, b.text);
  assert.match(b.text, /model_pin_needs_decision/);
  assert.strictEqual(sent(s, 'ob-1'), 0);
  assert.strictEqual(count(dir, 'execution.started', e => e.actualExecutor.model === 'ob-1'), 0);
}));

test('an unfinished attempt blocks the next call until it is closed explicitly', () => withProject('open', async (dir, s) => {
  assert.strictEqual((await run(dir, s, ['agents', 'pin', 'three', '--id', 'T-3', '--provider', 'ollama', '--model', 'oa-1', '--json'])).status, 0);
  assert.strictEqual((await run(dir, s, ['agents', 'record', 'started', 'host run', '--task', 'T-3', '--id', 'open-1', '--provider', 'ollama', '--model', 'oa-1', '--json'])).status, 0);
  const blocked = await agent(dir, s, 'three', 'T-3', 'oa-1');
  assert.strictEqual(blocked.status, 1, blocked.text);
  assert.match(blocked.text, /model_pin_execution_uncertain/);
  assert.strictEqual(s.requests.length, 0);
  assert.strictEqual((await record(dir, s, 'failed', 'T-3', 'open-1', 'ollama', 'oa-1')).status, 0);
  assert.strictEqual((await agent(dir, s, 'three', 'T-3', 'oa-1')).status, 0);
  assert.strictEqual(sent(s, 'oa-1'), 1);
}));

test('the failure limit survives re-pinning; only a confirmed retry approval reopens it', () => withProject('limit', async (dir, s) => {
  s.mode = 'fail';
  for (let i = 0; i < 3; i++) { const r = await agent(dir, s, 'four', 'T-4', 'oa-1'); assert.strictEqual(r.status, 1, r.text); }
  assert.strictEqual(sent(s, 'oa-1'), 3);
  assert.strictEqual(count(dir, 'execution.failed', e => e.taskId === 'T-4'), 3);
  const limited = await agent(dir, s, 'four', 'T-4', 'oa-1');
  assert.match(limited.text, /model_pin_retry_limit/);
  assert.strictEqual(sent(s, 'oa-1'), 3);
  const pinsBefore = count(dir, 'model.pinned', e => e.taskId === 'T-4');
  const same = await run(dir, s, ['agents', 'pin', 'four', '--id', 'T-4', '--provider', 'ollama', '--model', 'oa-1', '--json']);
  assert.strictEqual(same.status, 0, same.text);
  assert.strictEqual(same.json.idempotent, true);
  assert.strictEqual(count(dir, 'model.pinned', e => e.taskId === 'T-4'), pinsBefore);
  assert.match((await agent(dir, s, 'four', 'T-4', 'oa-1')).text, /model_pin_retry_limit/);
  const renamed = await run(dir, s, ['agents', 'pin', 'four, worded differently', '--id', 'T-4', '--provider', 'ollama', '--model', 'oa-1', '--json']);
  assert.strictEqual(renamed.json.newRequestVersion, true);
  assert.strictEqual(renamed.json.failures, 3);
  assert.match((await agent(dir, s, 'four, worded differently', 'T-4', 'oa-1')).text, /model_pin_retry_limit/);
  assert.strictEqual(sent(s, 'oa-1'), 3);
  const status = await run(dir, s, ['agents', 'pin', '--id', 'T-4', '--json']);
  assert.strictEqual(status.json.execution.failures, 3);
  const retry = await approve(dir, s, 'T-4', 'ollama', 'oa-1');
  assert.strictEqual(retry.kind, 'retry');
  s.mode = 'ok';
  assert.strictEqual((await agent(dir, s, 'four, worded differently', 'T-4', 'oa-1')).status, 0);
  assert.strictEqual(sent(s, 'oa-1'), 4);
}));

test('one confirmed A to B approval allows exactly one B call', () => withProject('approved', async (dir, s) => {
  assert.strictEqual((await agent(dir, s, 'five', 'T-5', 'oa-1')).status, 0);
  const approval = await approve(dir, s, 'T-5', 'ollama', 'ob-1');
  const changed = await agent(dir, s, 'five, other text', 'T-5', 'ob-1');
  assert.strictEqual(changed.status, 1, changed.text);
  assert.strictEqual(sent(s, 'ob-1'), 0);
  const b = await agent(dir, s, 'five', 'T-5', 'ob-1');
  assert.strictEqual(b.status, 0, b.text);
  assert.strictEqual(sent(s, 'ob-1'), 1);
  const started = ledger(dir).filter(e => e.taskId === 'T-5' && e.event === 'execution.started' && e.actualExecutor.model === 'ob-1');
  assert.strictEqual(started.length, 1);
  assert.strictEqual(started[0].approvalEventId, approval.approvalEventId);
  const again = await agent(dir, s, 'five', 'T-5', 'ob-1');
  assert.strictEqual(again.status, 1, again.text);
  assert.strictEqual(sent(s, 'ob-1'), 1);
}));

test('two concurrent runs on one approval make at most one B call', () => withProject('concurrent', async (dir, s) => {
  assert.strictEqual((await agent(dir, s, 'six', 'T-6', 'oa-1')).status, 0);
  await approve(dir, s, 'T-6', 'ollama', 'ob-1');
  s.delay = 1500;
  const results = await Promise.all([agent(dir, s, 'six', 'T-6', 'ob-1'), agent(dir, s, 'six', 'T-6', 'ob-1')]);
  assert.strictEqual(sent(s, 'ob-1'), 1);
  assert.deepStrictEqual(results.map(r => r.status).sort(), [0, 1], results.map(r => r.text).join('\n----\n'));
  assert.strictEqual(count(dir, 'execution.started', e => e.taskId === 'T-6' && e.actualExecutor.model === 'ob-1'), 1);
}));

test('an approval binds one dispatch and one attempt; other attempts and changed resends are refused', () => withProject('binding', async (dir, s) => {
  const base = ['--json'];
  assert.strictEqual((await run(dir, s, ['agents', 'dispatch', 'seven', '--to', 'live', '--model', 'live-model-1', '--id', 'T-7', ...base])).status, 0);
  await approve(dir, s, 'T-7', 'spare', 'spare-model-1');
  const prepared = await run(dir, s, ['agents', 'dispatch', 'seven', '--to', 'spare', '--model', 'spare-model-1', '--id', 'T-7', ...base]);
  assert.strictEqual(prepared.status, 0, prepared.text);
  const D = prepared.json.auditEventId;
  const link = ['--dispatch-id', D];
  assert.strictEqual((await record(dir, s, 'started', 'T-7', 'att-1', 'spare', 'spare-model-1', link)).status, 0);
  const startedBefore = count(dir, 'execution.started', e => e.attemptId === 'att-1');
  const resend = await record(dir, s, 'started', 'T-7', 'att-1', 'spare', 'spare-model-1', link);
  assert.strictEqual(resend.status, 0, resend.text);
  assert.strictEqual(resend.json.idempotent, true);
  assert.strictEqual(count(dir, 'execution.started', e => e.attemptId === 'att-1'), startedBefore);
  const conflict = await record(dir, s, 'started', 'T-7', 'att-1', 'spare', 'spare-model-2', link);
  assert.strictEqual(conflict.status, 1);
  assert.strictEqual(conflict.json.code, 'model_pin_event_conflict');
  assert.strictEqual((await record(dir, s, 'completed', 'T-7', 'att-1', 'spare', 'spare-model-1')).status, 0);
  const doneResend = await record(dir, s, 'completed', 'T-7', 'att-1', 'spare', 'spare-model-1');
  assert.strictEqual(doneResend.status, 0, doneResend.text);
  assert.strictEqual(doneResend.json.idempotent, true);
  assert.strictEqual(count(dir, 'execution.completed', e => e.attemptId === 'att-1'), 1);
  const doneConflict = await run(dir, s, ['agents', 'record', 'completed', 'a different summary', '--task', 'T-7', '--id', 'att-1', '--provider', 'spare', '--model', 'spare-model-1', '--evidence', 'stub-evidence', '--json']);
  assert.strictEqual(doneConflict.json.code, 'model_pin_event_conflict');
  for (const [attempt, more] of [['att-2', link], ['att-3', []]]) {
    const started = await record(dir, s, 'started', 'T-7', attempt, 'spare', 'spare-model-1', more);
    assert.strictEqual(started.status, 1, started.text);
    assert.strictEqual(started.json.code, 'model_pin_needs_decision');
    assert.ok(started.json.diagnosticEventId, started.text);
    const completed = await record(dir, s, 'completed', 'T-7', attempt, 'spare', 'spare-model-1');
    assert.strictEqual(completed.status, 1, completed.text);
  }
  assert.strictEqual(count(dir, 'execution.started', e => ['att-2', 'att-3'].includes(e.attemptId)), 0);
  assert.strictEqual(count(dir, 'execution.completed', e => ['att-2', 'att-3'].includes(e.attemptId)), 0);
  assert.ok(count(dir, 'model.pin.violation', e => e.taskId === 'T-7') >= 4);
  const mismatch = await record(dir, s, 'started', 'T-7', 'att-4', 'live', 'live-model-2', link);
  assert.strictEqual(mismatch.status, 1);
  assert.strictEqual((await run(dir, s, ['agents', 'dispatch', 'other', '--to', 'live', '--model', 'live-model-1', '--id', 'T-7B', ...base])).status, 0);
  const otherTask = await record(dir, s, 'started', 'T-7B', 'att-5', 'spare', 'spare-model-1', link);
  assert.strictEqual(otherTask.status, 1);
  assert.match(otherTask.json.error, /not a dispatch of this task/);
}));

test('revocation blocks an unused approval and the completion of a started attempt but not its failure record', () => withProject('revoke', async (dir, s) => {
  assert.strictEqual((await run(dir, s, ['agents', 'dispatch', 'eight', '--to', 'live', '--model', 'live-model-1', '--id', 'T-8', '--json'])).status, 0);
  const first = await approve(dir, s, 'T-8', 'spare', 'spare-model-1');
  const d1 = await run(dir, s, ['agents', 'dispatch', 'eight', '--to', 'spare', '--model', 'spare-model-1', '--id', 'T-8', '--json']);
  assert.strictEqual((await run(dir, s, ['agents', 'revoke-model-change', '--id', 'T-8', '--approval', first.approvalEventId, '--json'])).status, 0);
  assert.strictEqual((await record(dir, s, 'started', 'T-8', 'r-1', 'spare', 'spare-model-1', ['--dispatch-id', d1.json.auditEventId])).status, 1);
  const second = await approve(dir, s, 'T-8', 'spare', 'spare-model-1');
  const d2 = await run(dir, s, ['agents', 'dispatch', 'eight', '--to', 'spare', '--model', 'spare-model-1', '--id', 'T-8', '--json']);
  assert.strictEqual((await record(dir, s, 'started', 'T-8', 'r-2', 'spare', 'spare-model-1', ['--dispatch-id', d2.json.auditEventId])).status, 0);
  assert.strictEqual((await run(dir, s, ['agents', 'revoke-model-change', '--id', 'T-8', '--approval', second.approvalEventId, '--json'])).status, 0);
  assert.strictEqual((await record(dir, s, 'completed', 'T-8', 'r-2', 'spare', 'spare-model-1')).status, 1);
  assert.strictEqual((await record(dir, s, 'failed', 'T-8', 'r-2', 'spare', 'spare-model-1')).status, 0);
  assert.strictEqual(count(dir, 'execution.completed', e => e.taskId === 'T-8'), 0);
}));

test('an approval row without a request link from an earlier build is not treated as approval', () => withProject('legacy', async (dir, s) => {
  assert.strictEqual((await run(dir, s, ['agents', 'dispatch', 'nine', '--to', 'live', '--model', 'live-model-1', '--id', 'T-9', '--json'])).status, 0);
  const pinEvent = ledger(dir).find(e => e.event === 'model.pinned');
  const legacy = { ...pinEvent, event: 'model.change.approved', eventId: 'evt-legacy-approval',
    approval: { pinId: pinEvent.pin.pinId, from: { provider: 'live', model: 'live-model-1' }, to: { provider: 'spare', model: 'spare-model-1' }, decisionId: 'dec-legacy', verification: 'host-reported-unverified', replyDigest: 'a'.repeat(64), requestDigest: pinEvent.pin.requestDigest } };
  delete legacy.pin;
  const linkless = { ...legacy, eventId: 'evt-linkless-approval', approval: { ...legacy.approval, kind: 'change', confirmationDigest: 'b'.repeat(64) } };
  fs.appendFileSync(path.join(dir, '.leerness', 'execution-ledger.jsonl'), JSON.stringify(legacy) + '\n' + JSON.stringify(linkless) + '\n');
  const blocked = await run(dir, s, ['agents', 'dispatch', 'nine', '--to', 'spare', '--model', 'spare-model-1', '--id', 'T-9', '--json']);
  assert.strictEqual(blocked.status, 1, blocked.text);
  assert.strictEqual(blocked.json.status, 'NEEDS_DECISION');
  assert.strictEqual(count(dir, 'dispatch.prepared', e => e.taskId === 'T-9' && e.actualExecutor.provider === 'spare'), 0);
}));

test('a start recorded after the completion is refused and does not block the next run', () => withProject('late-start', async (dir, s) => {
  assert.strictEqual((await run(dir, s, ['agents', 'pin', 'late', '--id', 'T-12', '--provider', 'ollama', '--model', 'oa-1', '--json'])).status, 0);
  assert.strictEqual((await record(dir, s, 'completed', 'T-12', 'att-x', 'ollama', 'oa-1')).status, 0);
  const late = await record(dir, s, 'started', 'T-12', 'att-x', 'ollama', 'oa-1');
  assert.strictEqual(late.status, 1, late.text);
  assert.strictEqual(late.json.code, 'model_pin_attempt_already_ended');
  assert.ok(late.json.diagnosticEventId);
  const again = await record(dir, s, 'completed', 'T-12', 'att-x', 'ollama', 'oa-1');
  assert.strictEqual(again.status, 0, again.text);
  assert.strictEqual(again.json.idempotent, true);
  const next = await agent(dir, s, 'late', 'T-12', 'oa-1');
  assert.strictEqual(next.status, 0, next.text);
  assert.strictEqual(sent(s, 'oa-1'), 1);
  assert.strictEqual(count(dir, 'execution.started', e => e.attemptId === 'att-x'), 0);
}));

test('a reviewer pin is separate from the worker pin and refuses another reviewer model', () => withProject('review', async (dir, s) => {
  const pinned = await run(dir, s, ['agents', 'pin', 'review ten', '--id', 'T-10', '--role', 'reviewer', '--provider', 'live', '--model', 'live-model-1', '--json']);
  assert.strictEqual(pinned.status, 0, pinned.text);
  assert.strictEqual(pinned.json.scope, 'review');
  assert.strictEqual((await record(dir, s, 'completed', 'T-10', 'impl-1', 'spare', 'spare-model-1')).status, 0);
  const other = await record(dir, s, 'reviewed', 'T-10', 'rev-1', 'spare', 'spare-model-1', ['--target', 'impl-1']);
  assert.strictEqual(other.status, 1, other.text);
  assert.strictEqual(other.json.code, 'model_pin_needs_decision');
  assert.ok(other.json.diagnosticEventId);
  const named = await record(dir, s, 'reviewed', 'T-10', 'rev-2', 'live', 'live-model-1', ['--target', 'impl-1']);
  assert.strictEqual(named.status, 0, named.text);
  assert.strictEqual(count(dir, 'review.completed', e => e.taskId === 'T-10'), 1);
}));

test('one-shot role selection inherits and records only that role-specific pin', () => withProject('role-call', async (dir, s) => {
  const id = 'T-roles';
  const select = (role, model) => run(dir, s, ['agents', 'pin', 'role task', '--id', id, '--role', role, '--provider', 'ollama', '--model', model, '--json']);
  assert.strictEqual((await select('reviewer', 'review-model')).status, 0);
  const review = () => run(dir, s, ['agent', 'role task', '--role', 'reviewer', '--id', id]);
  assert.strictEqual((await review()).status, 0);
  assert.strictEqual(sent(s, 'review-model'), 1);
  assert.strictEqual(count(dir, 'model.pinned'), 1);
  assert.strictEqual((await select('coder', 'build-model')).status, 0);
  assert.strictEqual((await run(dir, s, ['agent', 'role task', '--id', id])).status, 0);
  assert.strictEqual((await review()).status, 0);
  assert.deepStrictEqual(s.requests.map(r => r.model), ['review-model', 'build-model', 'review-model']);
  const denied = await agent(dir, s, 'role task', id, 'build-model', ['--role', 'reviewer', '--json']);
  assert.strictEqual(denied.status, 1);
  assert.strictEqual(s.requests.length, 3);
  const rows = ledger(dir);
  const reviews = rows.filter(e => e.requestedRole === 'reviewer' && e.event === 'execution.completed');
  assert.strictEqual(reviews.length, 2);
  for (const end of reviews) assert(rows.some(start => start.eventId === end.parentAttemptId && start.attemptId === end.attemptId
    && start.event === 'execution.started' && start.requestedRole === 'reviewer'));
}));

test('manual recovery closes the reserved scope and replays the same terminal once', () => withProject('recover-role', async (dir, s) => {
  const pin = require('../lib/model-pin');
  for (const role of ['reviewer', 'actor']) {
    const id = 'T-recover-' + role;
    const executor = { provider: 'ollama', model: 'model-' + role };
    pin.ensurePin(dir, { taskId: id, scope: pin.scopeOfRole(role), ...executor, request: 'fixture request' });
    const start = pin.reserveAttempt(dir, { taskId: id, role, executor, request: 'fixture request' });
    const close = extra => record(dir, s, 'failed', id, start.attemptId, executor.provider, executor.model, extra);
    const first = await close([]);
    assert.strictEqual(first.status, 0, first.text);
    const state = pin.pinState(ledger(dir), id, pin.scopeOfRole(role));
    assert.strictEqual(state.open.size, 0);
    for (const extra of [[], ...(role === 'reviewer' ? [['--target', start.event.eventId]] : [])]) {
      const replay = await close(extra);
      assert.strictEqual(replay.json.idempotent, true, replay.text);
      assert.strictEqual(replay.json.event.eventId, first.json.event.eventId);
    }
    assert.strictEqual(count(dir, 'execution.failed', row => row.taskId === id), 1);
    const next = await agent(dir, s, 'fixture request', id, executor.model, ['--role', role]);
    assert.strictEqual(next.status, 0, next.text);
    assert.strictEqual(sent(s, executor.model), 1);
  }
}));

test('terminal replays compare caller provenance after resolving the original parent', () => withProject('replay-fields', async (dir, s)=> {
  const id = 'T-replay';
  await run(dir, s, ['agents', 'pin', 'review', '--id', id, '--role', 'reviewer', '--provider', 'live', '--model', 'live-model-1', '--json']);
  assert.strictEqual((await record(dir, s, 'completed', id, 'work', 'spare', 'spare-model-1')).status, 0);
  const review = extra => record(dir, s, 'reviewed', id, 'review', 'live', 'live-model-1', ['--target', 'work', '--session-id', 'review-session', ...extra]);
  const first = await review([]);
  assert.strictEqual(first.status, 0, first.text);
  const replay = await review([]);
  assert.strictEqual(replay.json.idempotent, true, replay.text);
  for (const extra of [['--status', 'changed'], ['--feedback-round', 'other-round']]) {
    const conflict = await review(extra);
    assert.strictEqual(conflict.json.code, 'model_pin_event_conflict', conflict.text);
  }
  const switched = await record(dir, s, 'reviewed', id, 'review', 'live', 'live-model-1', ['--target', 'work', '--session-id', 'other-session']);
  assert.strictEqual(switched.json.code, 'model_pin_event_conflict', switched.text);
  assert.strictEqual(count(dir, 'review.completed'), 1);
  assert.strictEqual((await review([])).json.idempotent, true);
}));

test('the MCP fallback and record tools keep the pin', () => withProject('mcp', async (dir, s) => {
  assert.strictEqual((await run(dir, s, ['agents', 'pin', 'mcp eleven', '--id', 'T-11', '--provider', 'live', '--model', 'live-model-1', '--json'])).status, 0);
  await approve(dir, s, 'T-11', 'spare', 'spare-model-1');
  const prepared = await run(dir, s, ['agents', 'dispatch', 'mcp eleven', '--to', 'spare', '--model', 'spare-model-1', '--id', 'T-11', '--json']);
  assert.strictEqual(prepared.status, 0, prepared.text);
  const calls = [
    { name: 'leerness_agents_fallback', arguments: { path: dir, action: 'provider', role: 'coder', task: 'mcp eleven', taskId: 'T-11', provider: 'spare', model: 'spare-model-1' } },
    { name: 'leerness_agents_record', arguments: { path: dir, event: 'started', summary: 'mcp unlinked', taskId: 'T-11', attemptId: 'm-1', provider: 'spare', model: 'spare-model-1' } },
    { name: 'leerness_agents_record', arguments: { path: dir, event: 'started', summary: 'mcp linked', taskId: 'T-11', attemptId: 'm-2', provider: 'spare', model: 'spare-model-1', dispatchEventId: prepared.json.auditEventId } },
  ];
  const input = calls.map((params, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params })).join('\n') + '\n';
  const mcp = await run(dir, s, ['mcp', 'serve'], { input, env: { LEERNESS_ENABLE_LIVE: '0' } });
  const replies = mcp.stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).filter(r => r.id);
  assert.strictEqual(replies.length, 3, mcp.text.slice(0, 2000));
  const body = r => { try { return JSON.parse(r.result.content[0].text); } catch { return { raw: r.result && r.result.content && r.result.content[0] && r.result.content[0].text }; } };
  const [fallback, unlinked, linked] = replies.sort((a, b) => a.id - b.id).map(body);
  assert.strictEqual(fallback.status, 'NEEDS_DECISION', JSON.stringify(fallback));
  assert.strictEqual(unlinked.code, 'model_pin_needs_decision', JSON.stringify(unlinked));
  assert.strictEqual(linked.ok, true, JSON.stringify(linked));
  assert.deepStrictEqual(ledger(dir).filter(e => e.event === 'execution.started' && e.taskId === 'T-11').map(e => e.attemptId), ['m-2']);
  assert.strictEqual(count(dir, 'fallback.selected', e => e.taskId === 'T-11'), 0);
}));

const mcpCall = async (dir, s, calls) => {
  const input = calls.map((params, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params })).join('\n') + '\n';
  const mcp = await run(dir, s, ['mcp', 'serve'], { input });
  const replies = mcp.stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).filter(r => r.id);
  assert.strictEqual(replies.length, calls.length, mcp.text.slice(0, 2000));
  return replies.sort((a, b) => a.id - b.id).map(r => { try { return JSON.parse(r.result.content[0].text); } catch { return { raw: r.result && r.result.content && r.result.content[0] && r.result.content[0].text }; } });
};
const resolveArgs = (task, id) => ['agents', 'resolve', task, '--role', 'coder', ...(id ? ['--id', id] : []), '--json'];
const fallbackArgs = (task, id, provider, model) => ['agents', 'fallback', 'provider', task, '--role', 'coder', '--to', provider, '--model', model, '--id', id, '--json'];

test('resolve through the CLI and MCP keeps the task id and pin; an unapproved spare model gets no command', () => withProject('resolve', async (dir, s) => {
  assert.strictEqual((await run(dir, s, ['agents', 'pin', 'task thirteen', '--id', 'T-13', '--provider', 'live', '--model', 'live-model-1', '--json'])).status, 0);
  const routed = await run(dir, s, resolveArgs('task thirteen', 'T-13'));
  assert.strictEqual(routed.status, 0, routed.text);
  assert.strictEqual(routed.json.taskId, 'T-13');
  assert.deepStrictEqual(routed.json.modelPin.requested, { provider: 'live', model: 'live-model-1' });
  const viaFallback = await run(dir, s, fallbackArgs('task thirteen', routed.json.taskId, 'spare', 'spare-model-1'));
  assert.strictEqual(viaFallback.status, 1, viaFallback.text);
  assert.strictEqual(viaFallback.json.status, 'NEEDS_DECISION', viaFallback.text);
  assert.strictEqual(viaFallback.json.command, undefined);
  const viaDispatch = await run(dir, s, ['agents', 'dispatch', 'task thirteen', '--to', 'spare', '--model', 'spare-model-1', '--id', routed.json.taskId, '--json']);
  assert.strictEqual(viaDispatch.status, 1, viaDispatch.text);
  assert.strictEqual(viaDispatch.json.status, 'NEEDS_DECISION', viaDispatch.text);
  const [mcpRouted, mcpFallback] = await mcpCall(dir, s, [
    { name: 'leerness_agents_resolve', arguments: { path: dir, task: 'task thirteen', role: 'coder', taskId: 'T-13' } },
    { name: 'leerness_agents_fallback', arguments: { path: dir, action: 'provider', role: 'coder', task: 'task thirteen', taskId: 'T-13', provider: 'spare', model: 'spare-model-1' } },
  ]);
  assert.strictEqual(mcpRouted.taskId, 'T-13', JSON.stringify(mcpRouted));
  assert.strictEqual(mcpFallback.status, 'NEEDS_DECISION', JSON.stringify(mcpFallback));
  assert.deepStrictEqual(ledger(dir).filter(e => e.event === 'routing.proposed').map(e => e.taskId), ['T-13', 'T-13']);
  assert.strictEqual(count(dir, 'fallback.selected'), 0);
  assert.strictEqual(count(dir, 'dispatch.prepared'), 0);
  assert.strictEqual(s.requests.length, 0);
}));

test('two concurrent fallbacks on one approval prepare at most one spare command', () => withProject('resolve-race', async (dir, s) => {
  assert.strictEqual((await run(dir, s, ['agents', 'pin', 'task fourteen', '--id', 'T-14', '--provider', 'live', '--model', 'live-model-1', '--json'])).status, 0);
  await approve(dir, s, 'T-14', 'spare', 'spare-model-1');
  const routed = await run(dir, s, resolveArgs('task fourteen', 'T-14'));
  assert.strictEqual(routed.json.taskId, 'T-14', routed.text);
  const both = await Promise.all([1, 2].map(() => run(dir, s, fallbackArgs('task fourteen', routed.json.taskId, 'spare', 'spare-model-1'))));
  assert.deepStrictEqual(both.map(r => r.status).sort(), [0, 1], both.map(r => r.text).join('\n'));
  assert.strictEqual(both.filter(r => r.json && r.json.command).length, 1);
  assert.strictEqual(count(dir, 'fallback.selected', e => e.taskId === 'T-14' && e.actualExecutor.provider === 'spare'), 1);
  assert.strictEqual(s.requests.length, 0);
}));

test('MCP and one-shot refuse an empty, padded or missing id instead of starting a new task', () => withProject('id-entry', async (dir, s) => {
  assert.strictEqual((await run(dir, s, ['agents', 'pin', 'task fifteen', '--id', 'T-15', '--provider', 'live', '--model', 'live-model-1', '--json'])).status, 0);
  const replies = await mcpCall(dir, s, [
    { name: 'leerness_agents_resolve', arguments: { path: dir, task: 'task fifteen', role: 'coder', taskId: '' } },
    { name: 'leerness_agents_resolve', arguments: { path: dir, task: 'task fifteen', role: 'coder', taskId: ' T-15 ' } },
    { name: 'leerness_agents_fallback', arguments: { path: dir, action: 'provider', task: 'task fifteen', role: 'coder', provider: 'spare', model: 'spare-model-1', taskId: '' } },
    { name: 'leerness_agents_record', arguments: { path: dir, event: 'started', summary: 'started b-1', taskId: '', attemptId: 'b-1', provider: 'spare', model: 'spare-model-1', evidence: 'stub' } },
    { name: 'leerness_agents_record', arguments: { path: dir, event: 'started', summary: 'started b-1', taskId: 'T-15', attemptId: ' b-1 ', provider: 'live', model: 'live-model-1', evidence: 'stub' } },
  ]);
  assert.deepStrictEqual(replies.map(r => r.code), ['empty_flag_value', 'invalid_id_value', 'empty_flag_value', 'empty_flag_value', 'invalid_id_value'], JSON.stringify(replies));
  for (const [id, message] of [['', /--id requires a non-empty value/], [' T-15 ', /is not the id the ledger stores \("T-15"\)/], [null, /--id (requires a value|\(값 필요)/]]) {
    const oneShot = await run(dir, s, ['agent', 'task fifteen', '--provider', 'ollama', '--model', 'ob-1', ...(id === null ? ['--id'] : ['--id', id])]);
    assert.strictEqual(oneShot.status, 1, oneShot.text);
    assert.match(oneShot.text, message);
  }
  assert.strictEqual(s.requests.length, 0);
  assert.deepStrictEqual(ledger(dir).map(e => e.event), ['model.pinned']);
}));

let unhandled = 0;
process.on('unhandledRejection', error => { unhandled++; console.error(`✗ unhandled rejection: ${(error && error.stack) || error}`); });
(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`✓ ${name}`); }
    catch (error) { failed++; console.error(`✗ ${name}: ${error.stack || error.message}`); }
  }
  console.log(`model-pin-cli-probe: ${passed} passed, ${failed} failed, ${unhandled} unhandled`);
  process.exitCode = failed || unhandled || passed !== tests.length ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
