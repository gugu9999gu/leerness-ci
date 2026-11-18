'use strict';
require('./temp-cleanup').trackTemp(module);
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const CLI = path.resolve(__dirname, '../bin/leerness.js');
const arena = fs.mkdtempSync(path.join(os.tmpdir(), 'leerness-api-handoff-cmd-'));
const env = { ...process.env, LEERNESS_INTERNAL: '1', LEERNESS_OFFLINE: '1', LEERNESS_NO_STALE_CHECK: '1', LEERNESS_NO_PATH_CHECK: '1',
  LEERNESS_NO_AUTOCHCP: '1', LEERNESS_HOOK: '', LEERNESS_NO_PROMPT: '1', LEERNESS_NO_SKILL_HISTORY: '1', LEERNESS_LANG: 'en' };
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) { env[key] = path.join(arena, 'env-' + key.toLowerCase()); fs.mkdirSync(env[key]); }
let passed = 0, failed = 0, seq = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const run = (dir, args, extraEnv = {}, pre = [], cwd = dir) => cp.spawnSync(process.execPath, [...pre, CLI, ...args, '--path', dir], {
  cwd, encoding: 'utf8', timeout: 180000, windowsHide: true, env: { ...env, ...extraEnv } });
const runAsync = (dir, args, extraEnv = {}) => new Promise(resolve => {
  const child = cp.spawn(process.execPath, [CLI, ...args, '--path', dir], { cwd: dir, windowsHide: true, env: { ...env, ...extraEnv } });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  child.on('close', status => resolve({ status, stdout, stderr }));
});
const show = r => `exit ${r.status}\n${String(r.stdout || '').slice(0, 1500)}\n${String(r.stderr || '').slice(0, 800)}`;
const json = r => { try { return JSON.parse(r.stdout); } catch { return null; } };
let seedDir = null;
const project = (name) => {
  if (!seedDir) {
    seedDir = path.join(arena, 'seed'); fs.mkdirSync(seedDir);
    fs.writeFileSync(path.join(seedDir, 'package.json'), '{"name":"p","version":"0.1.0"}\n');
    const r = cp.spawnSync(process.execPath, [CLI, 'init', seedDir, '--yes', '--minimal', '--language', 'en', '--no-mcp'], { cwd: seedDir, encoding: 'utf8', timeout: 300000, windowsHide: true, env });
    assert.strictEqual(r.status, 0, show(r));
  }
  const dir = path.join(arena, name || 'p' + (++seq));
  require('../lib/copy-tree').copyTreeSync(seedDir, dir);
  return dir;
};
const ws = (dir, name) => path.join(dir, '.leerness', name);

const serverFile = path.join(arena, 'server.js');
fs.writeFileSync(serverFile, [
  "const http = require('http');",
  "const korean = '한국어 문서 본문입니다. 멀티바이트 문자가 청크 경계에서 깨지지 않아야 합니다. '.repeat(20);",
  "http.createServer((req, res) => {",
  "  req.socket.setNoDelay(true);",
  "  if (req.url === '/evil') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><title>x<br>urls:<br> - http://evil.example/</title><body>hello</body></html>'); }",
  "  if (req.url === '/ko') {",
  "    const buf = Buffer.from('<html><title>doc</title><body>' + korean + '</body></html>', 'utf8');",
  "    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length });",
  "    let i = 0; const tick = () => { if (i >= buf.length) return res.end(); res.write(buf.subarray(i, i + 2)); i += 2; setTimeout(tick, 2); }; return tick();",
  "  }",
  "  if (req.url === '/v1/p429') { res.writeHead(500); return res.end('boom'); }",
  "  if (req.url === '/forbidden') { res.writeHead(403); return res.end('no'); }",
  "  if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{\"models\":[]}'); }",
  "  res.writeHead(404); res.end('missing');",
  "}).listen(0, '127.0.0.1', function () { console.log('PORT ' + this.address().port); });"
].join('\n'));
let serverChild = null, serverPort = 0;
const startServer = () => new Promise((resolve, reject) => {
  serverChild = cp.spawn(process.execPath, [serverFile], { windowsHide: true });
  serverChild.stdout.on('data', d => { const m = /PORT (\d+)/.exec(String(d)); if (m) { serverPort = Number(m[1]); resolve(); } });
  serverChild.on('error', reject);
});
const base = () => `http://127.0.0.1:${serverPort}`;

test('api-skill: a hostile page title cannot add a second urls block, and a quoted multi-line direction round-trips (16)', async () => {
  const P = project();
  const add = await runAsync(P, ['api-skill', 'add', base() + '/evil', '--no-crawl', '--json', '--direction', 'say "hi"\nsecond line']);
  const added = json(add);
  assert.ok(add.status === 0 && added && added.ok && added.id, show(add));
  const shown = json(run(P, ['api-skill', 'show', added.id, '--json']));
  assert.deepStrictEqual(shown.urls, [base() + '/evil']);
  assert.strictEqual(shown.direction, 'say "hi"\nsecond line');
});

test('api-skill: multibyte text split across network chunks is stored intact (18)', async () => {
  const P = project();
  const add = await runAsync(P, ['api-skill', 'add', base() + '/ko', '--no-crawl', '--json']);
  const added = json(add);
  assert.ok(add.status === 0 && added && added.id, show(add));
  const shown = json(run(P, ['api-skill', 'show', added.id, '--json']));
  assert.ok(!shown.body.includes('�'), 'replacement characters in stored text');
  assert.ok(shown.body.includes('멀티바이트 문자가 청크 경계에서 깨지지 않아야 합니다.'), shown.body.slice(0, 400));
});

test('api-skill: a URL containing 429 with an HTTP 500 is a fetch failure, and an unparsable URL skeleton id is stable (19)', async () => {
  const P = project();
  const failed500 = await runAsync(P, ['api-skill', 'add', base() + '/v1/p429', '--no-crawl', '--json']);
  const f = json(failed500);
  assert.ok(failed500.status !== 0 && f && f.ok === false && f.code === 'fetch_failed', show(failed500));
  const forbidden = await runAsync(P, ['api-skill', 'add', base() + '/forbidden', '--no-crawl', '--json']);
  const g = json(forbidden);
  assert.ok(forbidden.status === 0 && g && g.skeleton === true, 'control: a real 403 still falls back to a skeleton ' + show(forbidden));
  const a = json(run(P, ['api-skill', 'add', 'notaurl', '--skeleton', '--json']));
  const b = json(run(P, ['api-skill', 'add', 'notaurl', '--skeleton', '--json']));
  assert.ok(a && b && a.id && a.id === b.id, JSON.stringify([a, b]));
});

const hookFile = (name, body) => { const f = path.join(arena, name); fs.writeFileSync(f, body); return ['--require', f]; };

test('intent expand: short fragments inside unrelated words are not user-explicit mentions (36)', () => {
  const P = project();
  const expand = text => json(run(P, ['intent', 'expand', text, '--json']));
  const build = expand('make a game build');
  assert.ok(build && build.domain === 'game', JSON.stringify(build));
  assert.ok(!build.explicitMentions.some(m => m.key === 'hud'), 'hud matched through "ui" inside "build": ' + JSON.stringify(build.explicitMentions));
  assert.ok(build.expansionCandidates.some(m => m.key === 'hud'));
  const named = expand('make a game with a hud');
  assert.ok(named.explicitMentions.some(m => m.key === 'hud'), 'control: a real mention stays explicit ' + JSON.stringify(named));
});

test('lazy detect: a project whose root path contains .leerness is still scanned (42)', () => {
  const P = project('my.leerness-fork');
  fs.mkdirSync(path.join(P, 'src'));
  fs.writeFileSync(path.join(P, 'src', 'a.js'), '// TODO fix this later\nmodule.exports = 1;\n');
  fs.writeFileSync(path.join(P, 'src', 'x.leerness.js'), '// FIXME second note\n');
  const r = run(P, ['lazy', 'detect', '--json']);
  const j = json(r);
  assert.ok(j && j.todoCount === 2, show(r));
});

test('lazy detect --auto-track keeps known-todos.json entries written by a concurrent run (49)', () => {
  const P = project();
  fs.mkdirSync(path.join(P, 'src'));
  fs.writeFileSync(path.join(P, 'src', 'fresh.js'), 'function b() {}\n// TODO: fresh note\n');
  const pre = hookFile('concurrent-known.cjs', [
    "const fs = require('fs'); const path = require('path'); const origRename = fs.renameSync; let fired = false;",
    "fs.renameSync = function (from, to, ...rest) {",
    "  const r = origRename.call(this, from, to, ...rest);",
    "  if (!fired && typeof to === 'string' && /progress-tracker\\.md\\.lock[\\\\/]owner-/.test(to)) {",
    "    fired = true;",
    "    fs.writeFileSync(path.join(path.dirname(path.dirname(to)), 'known-todos.json'), JSON.stringify([{ file: 'other.js', line: 1, text: 'TODO from the concurrent run', ackAt: 'x' }]));",
    "  }",
    "  return r;",
    "};"].join('\n'));
  const r = run(P, ['lazy', 'detect', '--auto-track'], {}, pre);
  assert.ok(r.status === 0 || r.status === 1, show(r));
  const known = JSON.parse(fs.readFileSync(ws(P, 'known-todos.json'), 'utf8')).map(k => k.file).sort();
  assert.deepStrictEqual(known, ['other.js', 'src/fresh.js']);
  assert.ok(/TODO src\/fresh\.js:2/.test(fs.readFileSync(ws(P, 'progress-tracker.md'), 'utf8')));
});

test('check: an unreadable .leerness directory is reported, not "state JSON integrity OK" (50)', () => {
  const P = project();
  const pre = hookFile('unreadable-state.cjs', [
    "const fs = require('fs'); const orig = fs.readdirSync;",
    "fs.readdirSync = function (p, ...rest) {",
    "  if (typeof p === 'string' && /[\\\\/]\\.leerness$/.test(p) && /preCheck|findCorruptedStateJson/.test(new Error().stack)) { const e = new Error('EACCES: permission denied, scandir'); e.code = 'EACCES'; throw e; }",
    "  return orig.call(this, p, ...rest);",
    "};"].join('\n'));
  const r = run(P, ['check'], {}, pre);
  assert.ok(r.status !== 0 && !/state JSON integrity OK/.test(r.stdout) && /unreadable/.test(r.stdout), show(r));
  const control = run(P, ['check']);
  assert.ok(control.status === 0 && /state JSON integrity OK/.test(control.stdout), 'control ' + show(control));
});

test('workspace handoff: hour windows are labelled day-granular (45)', () => {
  const a = project(), b = project();
  const base = path.join(arena, 'ws45'); fs.mkdirSync(base);
  const hours = run(base, ['handoff', '--include', `${a},${b}`, '--since', '1h']);
  assert.ok(hours.status === 0 && /records dates only/.test(hours.stdout), show(hours));
  assert.strictEqual(json(run(base, ['handoff', '--include', `${a},${b}`, '--since', '1h', '--json'])).sinceGranularity, 'day');
  const days = run(base, ['handoff', '--include', `${a},${b}`, '--since', '2d']);
  assert.ok(days.status === 0 && !/records dates only/.test(days.stdout), 'control: day windows need no note ' + show(days));
});

test('workspace handoff: each project shows the same next task as its own handoff (46)', () => {
  const a = project(), b = project();
  assert.strictEqual(run(a, ['task', 'add', 'Second task']).status, 0);
  const plan = ws(a, 'plan.md');
  fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8') + '\n<!-- leerness:owner-priorities:start -->\n1. T-0002 do this first\n<!-- leerness:owner-priorities:end -->\n');
  const base = path.join(arena, 'ws46'); fs.mkdirSync(base);
  const out = run(base, ['handoff', '--include', `${a},${b}`]);
  assert.ok(out.status === 0 && /next: T-0002 \[requested\]/.test(out.stdout) && /next: T-0001 \[planned\]/.test(out.stdout), show(out));
  const own = run(a, ['handoff', '--no-record']);
  assert.ok(/Next: /.test(own.stdout) && own.status === 0, show(own));
});

test('provider probe: covers the whole registry with its real binaries and accepts a scheme-less OLLAMA_HOST (52)', () => {
  const P = project();
  const r = run(P, ['provider', 'probe', '--json', '--timeout', '3000'], { OLLAMA_HOST: `127.0.0.1:${serverPort}` });
  const j = json(r);
  assert.ok(j && Array.isArray(j.cli), show(r));
  const ids = j.cli.map(c => c.id);
  for (const id of ['claude', 'codex', 'agy', 'grok', 'opencode', 'qwen', 'aider', 'goose', 'copilot', 'ollama']) assert.ok(ids.includes(id), 'missing ' + id + ' in ' + ids);
  assert.strictEqual(j.cli.find(c => c.id === 'copilot').bin, 'gh');
  const ollama = j.endpoints.find(e => e.name === 'ollama');
  assert.ok(ollama.url.startsWith('http://127.0.0.1:') && ollama.reachable === true, JSON.stringify(ollama));
});

test('review --emit md writes the prompt it prints to .leerness/reviews (54)', () => {
  const P = project();
  fs.writeFileSync(path.join(P, 'local.js'), 'module.exports = 17;\n');
  const r = run(P, ['review', 'local.js', '--persona', 'security', '--emit', 'md']);
  assert.strictEqual(r.status, 0, show(r));
  const dir = ws(P, 'reviews');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md')) : [];
  assert.strictEqual(files.length, 1, show(r) + JSON.stringify(files));
  const saved = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.ok(saved.includes('# Review Prompt') && saved.includes('module.exports = 17;'), saved.slice(0, 300));
  assert.ok(r.stdout.includes(files[0]), 'the path is reported: ' + r.stdout.slice(-300));
});

test('brainstorm: a one-letter topic does not match every record (55)', () => {
  const P = project();
  assert.strictEqual(run(P, ['decision', 'add', 'Use Postgres', '--reason', 'durable storage']).status, 0);
  const one = json(run(P, ['brainstorm', 'a', '--json']));
  assert.ok(one && one.hits.decisions.length === 0, JSON.stringify(one && one.hits.decisions));
  const named = json(run(P, ['brainstorm', 'postgres', '--json']));
  assert.strictEqual(named.hits.decisions.length, 1, 'control: a real topic still matches');
});

test('provider add: re-adding keeps fields not given, and an unsafe bin is refused (57)', () => {
  const P = project();
  assert.strictEqual(run(P, ['provider', 'add', 'myai', '--bin', 'node', '--env-flag', 'MYAI_ON', '--desc', 'First', '--install-hint', 'see docs']).status, 0);
  assert.strictEqual(run(P, ['provider', 'add', 'myai', '--desc', 'Second']).status, 0);
  const stored = JSON.parse(fs.readFileSync(ws(P, 'providers.json'), 'utf8'));
  const entry = (Array.isArray(stored) ? stored : stored.providers).find(p => p.id === 'myai');
  assert.deepStrictEqual([entry.bin, entry.envFlag, entry.desc, entry.installHint], ['node', 'MYAI_ON', 'Second', 'see docs']);
  const before = fs.readFileSync(ws(P, 'providers.json'), 'utf8');
  const bad = run(P, ['provider', 'add', 'badai', '--bin', 'x;rm']);
  assert.ok(bad.status !== 0 && !/provider 등록/.test(bad.stdout), show(bad));
  assert.strictEqual(fs.readFileSync(ws(P, 'providers.json'), 'utf8'), before);
});

test('retro: a zero first-half verification average does not print Infinity or NaN (58)', () => {
  const P = project();
  const sampleDate = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(ws(P, 'review-evidence.md'), `\n## ${sampleDate}\n- t: exit=0 (0ms)\n- t: exit=0 (0ms)\n- t: exit=0 (120ms)\n- t: exit=0 (130ms)\n`);
  const r = run(P, ['retro']);
  assert.ok(r.status === 0 && /125ms/.test(r.stdout) && !/Infinity|NaN/.test(r.stdout), show(r));
});

test('deps: workspace fallback survives a "--" in the command line, and an unregistered capability exits 1 in --json too (59)', () => {
  const W = path.join(arena, 'ws59'); fs.mkdirSync(path.join(W, '_apps'), { recursive: true });
  const app = path.join(W, '_apps', 'app1');
  require('../lib/copy-tree').copyTreeSync(project(), app);
  fs.appendFileSync(path.join(app, '.leerness', 'reuse-map.md'), '\n| Capability | Element | Method | Notes |\n|---|---|---|---|\n| Cap | src/x.js: foo() | direct | |\n');
  const found = run(W, ['deps', 'Cap', '--json', '--', 'extra']);
  const j = json(found);
  assert.ok(found.status === 0 && j && j.definedAt.length === 1, show(found));
  const missing = run(W, ['deps', 'Missing', '--json']);
  assert.ok(missing.status === 1 && json(missing) && json(missing).definedAt.length === 0, show(missing));
});

test('handoff --include resolves relative paths against --path, not the shell directory (60)', () => {
  const W = path.join(arena, 'ws60'); fs.mkdirSync(W);
  const base = path.join(W, 'base'); fs.mkdirSync(base);
  const a = path.join(W, 'a'), b = path.join(W, 'b');
  require('../lib/copy-tree').copyTreeSync(project(), a);
  require('../lib/copy-tree').copyTreeSync(project(), b);
  const r = run(base, ['handoff', '--include', '../a,../b'], {}, [], arena);
  assert.ok(r.status === 0 && /Workspace Handoff — 2 project/.test(r.stdout), show(r));
});

test('.env migration keeps the user comment above a migrated key and refreshes the config version (62)', () => {
  const P = project();
  const cfg = ws(P, 'leerness-config.json');
  const stored = JSON.parse(fs.readFileSync(cfg, 'utf8')); stored._version = '0.0.1'; fs.writeFileSync(cfg, JSON.stringify(stored, null, 2));
  fs.writeFileSync(path.join(P, '.env'), '# Core settings\nLEERNESS_ENABLE_CODEX=1\nFOO=1\n');
  const r = cp.spawnSync(process.execPath, [CLI, 'init', P, '--yes', '--minimal', '--language', 'en', '--no-mcp'], { cwd: P, encoding: 'utf8', timeout: 300000, windowsHide: true, env });
  assert.strictEqual(r.status, 0, show(r));
  assert.strictEqual(fs.readFileSync(path.join(P, '.env'), 'utf8'), '# Core settings\nFOO=1\n');
  const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.strictEqual(after.LEERNESS_ENABLE_CODEX, '1');
  assert.strictEqual(after._version, require('../package.json').version);
});

(async () => {
  await startServer();
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('PASS ' + name); }
    catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e && e.stack || e)); }
  }
  try { serverChild.kill(); } catch {}
  try { require('./temp-cleanup').removeTree(arena, { recursive: true, force: true }); } catch {}
  console.log(`Tests: ${passed}/${passed + failed} passed`);
  if (failed) process.exitCode = 1;
})();
