'use strict';
require('./temp-cleanup').trackTemp(module);
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const CLI = path.resolve(__dirname, '../bin/leerness.js');
const arena = fs.mkdtempSync(path.join(os.tmpdir(), 'leerness-skill-task-cmd-'));
const env = { ...process.env, LEERNESS_INTERNAL: '1', LEERNESS_OFFLINE: '1', LEERNESS_NO_STALE_CHECK: '1', LEERNESS_NO_PATH_CHECK: '1',
  LEERNESS_NO_AUTOCHCP: '1', LEERNESS_HOOK: '', LEERNESS_NO_PROMPT: '1', LEERNESS_NO_SKILL_HISTORY: '1', LEERNESS_LANG: 'en' };
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) { env[key] = path.join(arena, 'env-' + key.toLowerCase()); fs.mkdirSync(env[key]); }
let seq = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const run = (dir, args, extraEnv = null, preload = null) => cp.spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), CLI, ...args, '--path', dir], {
  cwd: dir, encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: extraEnv ? { ...env, ...extraEnv } : env });
const runAsync = (dir, args) => new Promise(resolve => cp.execFile(process.execPath, [CLI, ...args, '--path', dir],
  { cwd: dir, env, windowsHide: true, timeout: 180000 }, (error, stdout, stderr) => resolve({ status: error ? (error.code || 1) : 0, stdout, stderr })));
const show = r => `exit ${r.status}\n${String(r.stdout || '').slice(0, 1500)}\n${String(r.stderr || '').slice(0, 800)}`;
const out = r => String(r.stdout || '') + String(r.stderr || '');
let seedDir = null;
const project = () => {
  if (!seedDir) {
    seedDir = path.join(arena, 'seed'); fs.mkdirSync(seedDir);
    fs.writeFileSync(path.join(seedDir, 'package.json'), '{"name":"p","version":"0.1.0"}\n');
    const r = cp.spawnSync(process.execPath, [CLI, 'init', seedDir, '--yes', '--minimal', '--language', 'en', '--no-mcp'], { cwd: seedDir, encoding: 'utf8', timeout: 300000, windowsHide: true, env });
    assert.strictEqual(r.status, 0, show(r));
  }
  const dir = path.join(arena, 'p' + (++seq));
  require('../lib/copy-tree').copyTreeSync(seedDir, dir);
  return dir;
};
const ws = (dir, name) => path.join(dir, '.leerness', name);
const row = (id, status, request) => `| ${id} | ${status} | ${request} | evidence | next | 2026-11-10 |`;
const addRows = (dir, rows) => fs.appendFileSync(ws(dir, 'progress-tracker.md'), rows.join('\n') + '\n');

const stub = path.join(arena, 'net-stub.cjs');
fs.writeFileSync(stub, `
const https = require('https'), { EventEmitter } = require('events');
const names = ['sk-a', 'sk-b', 'sk-c'];
https.get = function (opts, cb) {
  const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
  setImmediate(() => {
    if (process.env.PROBE_GH === 'fail') { req.emit('error', new Error('stub network down')); return; }
    const res = new EventEmitter(); res.statusCode = 200; cb(res);
    res.emit('data', Buffer.from(JSON.stringify(names.map(n => ({ type: 'dir', name: n, path: 'skills/' + n, html_url: 'x' })))));
    res.emit('end');
  });
  return req;
};
global.fetch = async url => {
  let text;
  if (/\\/big\\/SKILL\\.md$/.test(url)) text = '---\\nname: big-skill\\ndescription: d\\n---\\n' + 'x'.repeat(9 * 1024 * 1024);
  else { const m = /\\/(sk-[a-z])\\/SKILL\\.md$/.exec(url); text = m ? '---\\nname: ' + m[1] + '\\ndescription: d\\n---\\n# ' + m[1] + '\\n' : ''; }
  const buf = Buffer.from(text);
  return { status: m404(text) ? 404 : 200, headers: { get: () => null }, text: async () => text,
    body: (async function* () { for (let i = 0; i < buf.length; i += 1 << 20) yield buf.subarray(i, i + (1 << 20)); })() };
};
function m404(t) { return !t; }
`);

test('1 agent-mode start prints the handoff output it claims to show', () => {
  const P = project();
  const r = run(P, ['agent-mode', 'start']);
  assert.ok(r.status === 0 && /Session Start Context/.test(r.stdout), show(r));
});

test('2 skill auto-install continues after one skill fails and reports the failure count', () => {
  const P = project();
  fs.mkdirSync(ws(P, 'skills/sk-b'), { recursive: true });
  fs.writeFileSync(ws(P, 'skills/sk-b/SKILL.md'), 'older different body\n');
  const r = run(P, ['skill', 'auto-install', '--presets', 'vercel', '--query', 'sk-', '--yes'], null, stub);
  assert.ok(/2건 설치 \/ 1건 실패/.test(r.stdout), show(r));
  assert.ok(fs.existsSync(ws(P, 'skills/sk-c/SKILL.md')) && fs.existsSync(ws(P, 'skills/sk-a/SKILL.md')), show(r));
  assert.notStrictEqual(r.status, 0, show(r));
});

test('6 concurrent skill use runs keep every usage count', async () => {
  const P = project();
  assert.strictEqual(run(P, ['skill', 'learn', 'cx', '--capability', 'c']).status, 0);
  const results = await Promise.all(Array.from({ length: 10 }, () => runAsync(P, ['skill', 'use', 'cx'])));
  const bad = results.filter(r => r.status !== 0);
  assert.strictEqual(bad.length, 0, bad.map(show).join('\n'));
  const count = JSON.parse(fs.readFileSync(ws(P, 'skills/cx/skill.json'), 'utf8')).usage.count;
  assert.strictEqual(count, 10);
});

test('7 init --keep 0 says that one backup is still kept', () => {
  const P = project();
  const r = run(P, ['migrate', '--keep', '0']);
  assert.ok(/--keep 0/.test(out(r)), show(r));
});

test('8 skill consolidate --threshold and auto-install --max reject non-numbers', () => {
  const P = project();
  const a = run(P, ['skill', 'consolidate', '--threshold', 'abc']);
  assert.ok(a.status !== 0 && /--threshold/.test(out(a)) && !/jaccard < NaN/.test(out(a)), show(a));
  const b = run(P, ['skill', 'auto-install', '--max', 'abc', '--presets', 'vercel', '--query', 'sk-'], null, stub);
  assert.ok(b.status !== 0 && /--max/.test(out(b)) && !/NaN/.test(out(b)), show(b));
});

test('9 skill install refuses a response larger than the size limit', () => {
  const P = project();
  const r = run(P, ['skill', 'install', 'https://stub.test/big/SKILL.md'], null, stub);
  assert.ok(r.status !== 0 && !fs.existsSync(ws(P, 'skills/big-skill/SKILL.md')), show(r));
});

test('10 an open request with no 2-character words is reported as missing, not tracked', () => {
  const P = project();
  assert.strictEqual(run(P, ['requests', 'add', 'a b']).status, 0);
  const r = run(P, ['requests', 'audit', '--json']);
  const j = JSON.parse(r.stdout);
  assert.ok(j.missing.length === 1 && j.tracked.length === 0, show(r));
});

test('21 task update lists request editing and memo flags and preserves the legacy note alias', () => {
  const P = project();
  const json = args => {
    const result = run(P, [...args, '--json']);
    assert.strictEqual(result.status, 0, show(result));
    return JSON.parse(result.stdout);
  };
  const entries = json(['commands']).categories.task.filter(entry => /^task update(?:\s|$)/.test(entry.cmd));
  assert.strictEqual(entries.length, 1);
  const update = entries[0];
  const commandFlags = update.cmd.match(/--[a-z][a-z-]*/g) || [];
  for (const flag of ['--request', '--memo']) assert.ok(commandFlags.includes(flag), update.cmd);
  assert.match(update.cmd + ' ' + update.desc, /--note(?![\w-])/);

  const id = json(['task', 'add', 'Original fixture request']).id;
  const edit = (flag, value) => json(['task', 'update', id, flag, value]);
  const request = () => require('../lib/progress-rows').parseProgressRows(fs.readFileSync(ws(P, 'progress-tracker.md'), 'utf8'))
    .find(task => task.id === id).request;
  assert.strictEqual(edit('--request', 'Edited fixture request').request, 'Edited fixture request');
  assert.strictEqual(request(), 'Edited fixture request');
  const log = () => fs.readFileSync(ws(P, 'task-log.md'), 'utf8');
  const before = log();
  assert.strictEqual(edit('--memo', 'Fixture memo entry').memoAppended, true);
  assert.strictEqual(request(), 'Edited fixture request');
  const after = log();
  assert.ok(after.startsWith(before), 'existing task history was overwritten');
  const appended = after.slice(before.length);
  assert.ok(appended.includes(id) && appended.includes('Fixture memo entry'), appended);
  assert.strictEqual(edit('--note', 'Legacy fixture request').request, 'Legacy fixture request');
  assert.strictEqual(request(), 'Legacy fixture request');
});

test('24 idempotency audit, auto-fix and task add agree on which statuses are inactive', () => {
  const P = project();
  addRows(P, [row('T-0101', '[완료]', 'ship the report exporter'), row('T-0102', '[완료]', 'ship the report exporter'),
    row('T-0103', '[진행]', 'migrate the billing tables'), row('T-0104', '[진행]', 'migrate the billing tables')]);
  const audit = JSON.parse(run(P, ['idempotency', 'audit', '--json']).stdout);
  const dups = audit.violations.filter(v => v.kind === 'task-duplicate-request');
  assert.strictEqual(dups.length, 1, JSON.stringify(dups));
  assert.ok(/migrate the billing/.test(dups[0].detail), dups[0].detail);
  const fixed = run(P, ['idempotency', 'audit', '--auto-fix', '--json']);
  assert.strictEqual(JSON.parse(fixed.stdout).summary.totalViolations, 0, show(fixed));
  const add = run(P, ['task', 'add', 'ship the report exporter', '--no-review', '--json']);
  assert.ok(JSON.parse(add.stdout).existing !== true, show(add));
});

test('27 idempotency audit --auto-fix with --dry-run changes nothing and is not reported as a failed repair', () => {
  const P = project();
  addRows(P, [row('T-0101', 'requested', 'duplicate request text'), row('T-0102', 'requested', 'duplicate request text')]);
  const before = fs.readFileSync(ws(P, 'progress-tracker.md'), 'utf8');
  const r = run(P, ['idempotency', 'audit', '--auto-fix', '--dry-run', '--json']);
  assert.ok(!/auto-fix failed|"action": "error"|could not repair/.test(out(r)), show(r));
  assert.strictEqual(fs.readFileSync(ws(P, 'progress-tracker.md'), 'utf8'), before);
});

test('28 sessions reports an invalid host salt as an unreadable store instead of crashing', () => {
  const P = project();
  fs.mkdirSync(ws(P, 'cache/sessions'), { recursive: true });
  fs.writeFileSync(ws(P, 'cache/sessions/.host-salt'), 'not-a-salt\n');
  const r = run(P, ['sessions', '--json']);
  const j = JSON.parse(r.stdout);
  assert.ok(j.registryState === 'unreadable' && j.storeError, show(r));
});

test('29 memory status counts only T- rows as tasks', () => {
  const P = project();
  const before = JSON.parse(run(P, ['memory', 'status', '--json']).stdout).tasks;
  addRows(P, [row('M-0099', 'planned', 'a milestone row'), row('D-0099', 'planned', 'a dropped item row')]);
  const r = run(P, ['memory', 'status', '--json']);
  const t = JSON.parse(r.stdout).tasks;
  assert.deepStrictEqual([t.total, t.active], [before.total, before.active], show(r));
});

test('30 plan add leaves plan.md unchanged when the linked task cannot be created', () => {
  const P = project();
  fs.writeFileSync(ws(P, 'toggles.json'), '{bad');
  const before = fs.readFileSync(ws(P, 'plan.md'), 'utf8');
  const r = run(P, ['plan', 'add', 'gate milestone', '--status', 'done']);
  assert.notStrictEqual(r.status, 0, show(r));
  assert.strictEqual(fs.readFileSync(ws(P, 'plan.md'), 'utf8'), before, show(r));
});

test('31 JSON-mode task add and plan add refresh the auto roadmap file', () => {
  for (const args of [['task', 'add', 'brand new json task', '--no-review', '--json'], ['plan', 'add', 'brand new json milestone', '--json']]) {
    const P = project();
    fs.mkdirSync(ws(P, 'cache'), { recursive: true });
    fs.writeFileSync(ws(P, 'cache/auto-roadmap.json'), JSON.stringify({ enabled: true, onEveryChange: true }));
    const r = run(P, args);
    assert.strictEqual(r.status, 0, show(r));
    assert.ok(fs.existsSync(path.join(P, 'leerness.html')), args.join(' ') + '\n' + show(r));
  }
});

test('32a skill auto-cache refresh names the presets whose fetch failed', () => {
  const P = project();
  const r = run(P, ['skill', 'auto-cache', 'refresh'], { PROBE_GH: 'fail' }, stub);
  assert.ok(/stub network down/.test(out(r)), show(r));
});

test('32b skill auto-cache refresh names a corrupt cache instead of blaming a concurrent change', () => {
  const P = project();
  fs.writeFileSync(ws(P, 'skill-auto-cache.json'), '{broken');
  const r = run(P, ['skill', 'auto-cache', 'refresh'], null, stub);
  assert.ok(/valid JSON/.test(out(r)) && !/was not saved/.test(out(r)), show(r));
  assert.strictEqual(fs.readFileSync(ws(P, 'skill-auto-cache.json'), 'utf8'), '{broken');
});

test('33 skill export keeps front matter single-line and rejects non-skill ids', () => {
  const P = project();
  fs.mkdirSync(ws(P, 'skills/ex'), { recursive: true });
  fs.writeFileSync(ws(P, 'skills/ex/skill.json'), JSON.stringify({ name: 'ex', description: 'first line\n---\nname: evil\nextra', capabilities: [] }));
  const r = run(P, ['skill', 'export', 'ex']);
  assert.strictEqual(r.status, 0, show(r));
  const lines = fs.readFileSync(ws(P, 'skills-export/ex/SKILL.md'), 'utf8').split('\n');
  assert.deepStrictEqual([lines[0], lines[1], lines[3]], ['---', 'name: ex', '---'], lines.slice(0, 8).join('\n'));
  const c = run(P, ['skill', 'export', 'constructor']);
  assert.ok(c.status !== 0 && !fs.existsSync(ws(P, 'skills-export/constructor')), show(c));
});

test('35 wakeup-interval set accepts only whole seconds', () => {
  const P = project();
  for (const bad of ['90.5', '0x400', '1e3']) assert.notStrictEqual(run(P, ['wakeup-interval', 'set', bad]).status, 0, bad);
  assert.strictEqual(run(P, ['wakeup-interval', 'set', '120']).status, 0);
});

test('38 plan add --progress 50% is stored and listed as 50%', () => {
  const P = project();
  assert.strictEqual(run(P, ['plan', 'add', 'percent milestone', '--progress', '50%']).status, 0);
  assert.ok(/Progress: 50%\r?\n/.test(fs.readFileSync(ws(P, 'plan.md'), 'utf8')));
  assert.ok(!/%%/.test(run(P, ['plan', 'list']).stdout));
});

test('44 task relink rejects a non-numeric --min-score', () => {
  const P = project();
  const r = run(P, ['task', 'relink', '--min-score', 'abc']);
  assert.ok(r.status !== 0 && /--min-score/.test(out(r)), show(r));
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e && e.stack || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
