'use strict';
require('./temp-cleanup').trackTemp(module);
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const CLI = path.resolve(__dirname, '../bin/leerness.js');
const arena = fs.mkdtempSync(path.join(os.tmpdir(), 'leerness-repl-adapter-cmd-'));
const env = { ...process.env, LEERNESS_INTERNAL: '1', LEERNESS_OFFLINE: '1', LEERNESS_NO_STALE_CHECK: '1', LEERNESS_NO_PATH_CHECK: '1',
  LEERNESS_NO_AUTOCHCP: '1', LEERNESS_HOOK: '', LEERNESS_NO_PROMPT: '1', LEERNESS_NO_SKILL_HISTORY: '1', LEERNESS_LANG: 'en' };
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) { env[key] = path.join(arena, 'env-' + key.toLowerCase()); fs.mkdirSync(env[key]); }
for (const key of Object.keys(env)) if (/^LEERNESS_ENABLE_|^LC_CTYPE$|^SHELL$/.test(key)) delete env[key];
let passed = 0, failed = 0, seq = 0;
const test = (name, fn) => { if (process.env.PROBE_ONLY && !new RegExp(process.env.PROBE_ONLY).test(name)) return; try { fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e && e.stack || e)); } };
const spawn = (dir, args, extraEnv = {}, input) => cp.spawnSync(process.execPath, [CLI, ...args], {
  cwd: dir, encoding: 'utf8', timeout: 180000, windowsHide: true, env: { ...env, ...extraEnv }, input });
const run = (dir, args, extraEnv, input) => spawn(dir, [...args, '--path', dir], extraEnv, input);
const show = r => `exit ${r.status}\n${String(r.stdout || '').slice(0, 1500)}\n${String(r.stderr || '').slice(0, 800)}`;
const seeds = {};
const project = (lang = 'en') => {
  if (!seeds[lang]) {
    const seed = seeds[lang] = path.join(arena, 'seed-' + lang); fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"p","version":"0.1.0"}\n');
    const r = cp.spawnSync(process.execPath, [CLI, 'init', seed, '--yes', '--minimal', '--language', lang, '--no-mcp'], { cwd: seed, encoding: 'utf8', timeout: 300000, windowsHide: true, env });
    assert.strictEqual(r.status, 0, show(r));
  }
  const dir = path.join(arena, 'p' + (++seq));
  require('../lib/copy-tree').copyTreeSync(seeds[lang], dir);
  return dir;
};
const ws = (dir, name) => path.join(dir, '.leerness', name);
const emptyDir = () => { const d = path.join(arena, 'e' + (++seq)); fs.mkdirSync(d); return d; };
const tree = dir => { const out = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(dir, p)); if (e.isDirectory()) walk(p); } }; walk(dir); return out.sort(); };

const driver = path.join(arena, 'driver.cjs');
fs.writeFileSync(driver, [
  "const fs = require('fs'), path = require('path'), Module = require('module');",
  "const file = process.argv[2], names = JSON.parse(process.argv[3]), script = process.argv[4];",
  "const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));",
  "m._compile(fs.readFileSync(file, 'utf8').replace(/^#!.*\\n/, '') + '\\nmodule.exports.__x = { ' + names.join(', ') + ' };\\n', file);",
  "global.core = m.exports.__x; global.cli = m.exports;",
  "Promise.resolve(require(script)).then(f => f(), e => { console.error(e && e.stack || e); process.exit(2); }).then(r => { console.log('RESULT ' + JSON.stringify(r === undefined ? null : r)); process.exit(0); }, e => { console.error(e && e.stack || e); process.exit(2); });",
].join('\n'));
const inChild = (names, body, extraEnv = {}, cwd = arena) => {
  const script = path.join(arena, 'script' + (++seq) + '.cjs');
  fs.writeFileSync(script, 'module.exports = async () => {' + body + '};');
  const r = cp.spawnSync(process.execPath, [driver, CLI, JSON.stringify(names), script], { cwd, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...env, ...extraEnv } });
  const line = String(r.stdout || '').split(/\r?\n/).find(l => l.startsWith('RESULT '));
  assert.ok(line, show(r));
  return JSON.parse(line.slice(7));
};
const sleep = ms => cp.execFileSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntil = (cond, ms) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) sleep(200); return cond(); };
const feeder = path.join(arena, 'feeder.cjs');
fs.writeFileSync(feeder, [
  "const cp = require('child_process'), fs = require('fs');",
  "const cfg = JSON.parse(process.argv[2]), fd = fs.openSync(cfg.out, 'w');",
  "const child = cp.spawn(process.execPath, cfg.args, { cwd: cfg.cwd, env: process.env, stdio: ['pipe', fd, fd], windowsHide: true });",
  "const text = () => fs.readFileSync(cfg.out, 'utf8');",
  "const until = (re, from, ms) => new Promise(res => { const end = Date.now() + ms; const t = setInterval(() => { if (re.test(text().slice(from)) || Date.now() > end) { clearInterval(t); res(); } }, 200); });",
  "(async () => {",
  "  await until(/채팅 시작/, 0, 120000);",
  "  for (const [line, marker, pause] of cfg.steps) {",
  "    const before = text().length; child.stdin.write(line + '\\n');",
  "    await until(new RegExp(marker), before, 120000); await new Promise(r => setTimeout(r, pause || 0));",
  "  }",
  "  child.stdin.write(':quit\\n'); await new Promise(r => { child.on('exit', r); setTimeout(r, 60000); }); child.kill(); process.exit(0);",
  "})();",
].join('\n'));
const replSession = (P, steps, extraEnv = {}) => {
  const out = path.join(arena, 'repl' + (++seq) + '.out');
  const script = path.join(arena, 'repl' + seq + '.cjs');
  fs.writeFileSync(script, "module.exports = async () => { await global.core._agentRepl(process.argv[5], {}); return null; };");
  const cfg = { out, cwd: P, steps, args: [driver, CLI, '["_agentRepl"]', script, P] };
  const runner = cp.spawn(process.execPath, [feeder, JSON.stringify(cfg)], { cwd: P, windowsHide: true, stdio: 'ignore',
    env: { ...env, LEERNESS_OLLAMA_BASE_URL: 'http://127.0.0.1:9', ...extraEnv } });
  try { waitUntil(() => !alive(runner.pid), 400000); } finally { try { runner.kill(); } catch {} }
  return fs.readFileSync(out, 'utf8');
};

test('79 basic mode permits the leerness CLI that the REPL spawns', () => {
  const res = inChild(['_isCommandPermitted'], `
    const basic = { mode: 'basic', shell: { exec: false, allowList: [] } };
    return [core._isCommandPermitted(basic, process.execPath, {}), core._isCommandPermitted(basic, process.execPath + '-other', {}),
      core._isCommandPermitted(basic, 'python x.py', {}), core._isCommandPermitted(basic, 'npm test', {})];`);
  assert.deepStrictEqual(res, [true, false, false, true]);
});

test('79 a REPL slash command completes instead of being blocked with exit 126', () => {
  const out = replSession(project(), [[':handoff', ':handoff (완료|실패)']]);
  assert.ok(/:handoff 완료/.test(out), out.slice(-1500));
  assert.ok(!/exit 126/.test(out), out.slice(-1500));
});

const stubDir = path.join(arena, 'stubs'); fs.mkdirSync(stubDir);
fs.writeFileSync(path.join(stubDir, process.platform === 'win32' ? 'grok.cmd' : 'grok'), process.platform === 'win32' ? '@echo off\r\necho grok 1.0.0\r\n' : '#!/bin/sh\necho grok 1.0.0\n', { mode: 0o755 });
test('80 REPL does not auto-select or fall back to a provider a chat turn cannot call', () => {
  const P = project();
  fs.writeFileSync(path.join(arena, 'repl-80.cjs'), "module.exports = async () => { await global.core._agentRepl(process.argv[5], {}); return null; };");
  const r = cp.spawnSync(process.execPath, [driver, CLI, '["_agentRepl"]', path.join(arena, 'repl-80.cjs'), P], { cwd: P, input: ':quit\n', encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...env, PATH: stubDir + path.delimiter + process.env.PATH, LEERNESS_ENABLE_GROK: '1', LEERNESS_OLLAMA_BASE_URL: 'http://127.0.0.1:9' } });
  assert.ok(/Leerness Agent/.test(r.stdout), show(r));
  assert.ok(!/grok 자동 (선택|전환)/.test(r.stdout), show(r));
});

test('81 model list and generate use the same default port for the same base URL', () => {
  const res = inChild(['_ollamaListModels', '_ollamaGenerate'], `
    const http = require('http'), seen = [];
    http.request = (opts) => { seen.push({ port: String(opts.port), path: opts.path }); const handlers = {}; const req = { on(e, f) { handlers[e] = f; return req; }, write() {}, end() { setTimeout(() => handlers.error && handlers.error(new Error('stub')), 0); }, destroy() {} }; return req; };
    process.env.LEERNESS_OLLAMA_BASE_URL = 'http://gpu-box/prefix?token=abc';
    await core._ollamaListModels(); await core._ollamaGenerate('hi', 'm');
    return seen;`);
  assert.strictEqual(res.length, 2);
  assert.strictEqual(res[0].port, res[1].port);
  assert.strictEqual(res[0].port, '80');
  assert.ok(res[0].path.includes('token=abc'), JSON.stringify(res));
});

test('84 concurrent adapter MCP merge does not lose a competing write to .mcp.json', () => {
  const P = project();
  const mcp = path.join(P, '.mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { first: { command: 'x' } } }, null, 2) + '\n');
  const ready = path.join(arena, 'ready' + (++seq)), go = path.join(arena, 'go' + seq);
  const script = path.join(arena, 'holder' + seq + '.cjs');
  fs.writeFileSync(script, `module.exports = async () => {
    const fs = require('fs'), mcp = ${JSON.stringify(mcp)};
    await new Promise(resolve => core._withLock(mcp, () => {
      const j = JSON.parse(fs.readFileSync(mcp, 'utf8'));
      fs.writeFileSync(${JSON.stringify(ready)}, '1');
      const end = Date.now() + 90000; while (!fs.existsSync(${JSON.stringify(go)}) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      j.mcpServers.second = { command: 'y' }; fs.writeFileSync(mcp, JSON.stringify(j, null, 2) + '\\n'); resolve();
    }));
    return true; };`);
  const holder = cp.spawn(process.execPath, [driver, CLI, '["_withLock"]', script], { cwd: arena, env, windowsHide: true, stdio: 'ignore' });
  let merger = null;
  try {
    assert.ok(waitUntil(() => fs.existsSync(ready), 90000), 'holder did not start');
    merger = cp.spawn(process.execPath, [CLI, 'adapter', 'claude', '--path', P], { cwd: P, env, windowsHide: true, stdio: 'ignore' });
    waitUntil(() => !alive(merger.pid), 12000);
    fs.writeFileSync(go, '1');
    assert.ok(waitUntil(() => !alive(merger.pid) && !alive(holder.pid), 120000), 'processes did not finish');
  } finally { try { holder.kill(); } catch {} try { merger && merger.kill(); } catch {} }
  const j = JSON.parse(fs.readFileSync(mcp, 'utf8'));
  assert.ok(j.mcpServers.second && j.mcpServers.leerness && j.mcpServers.first, JSON.stringify(j));
});

test('84 adapter codex --global honours --dry-run', () => {
  const P = project();
  const r = run(P, ['adapter', 'codex', '--global', '--dry-run']);
  assert.strictEqual(r.status, 0, show(r));
  assert.ok(!fs.existsSync(path.join(env.USERPROFILE, '.codex', 'AGENTS.md')), 'global file written');
});

test('85 brief update and export refuse an uninitialised directory', () => {
  const D = emptyDir();
  const u = run(D, ['brief', 'update', '--direction', 'x']);
  assert.notStrictEqual(u.status, 0, show(u));
  const e = run(D, ['brief', 'export', '--out', 'out.md']);
  assert.notStrictEqual(e.status, 0, show(e));
  assert.deepStrictEqual(tree(D), []);
});

test('86 unknown subcommands of glossary, state and policy are rejected without writing', () => {
  const P = project();
  const before = tree(P);
  for (const args of [['glossary', 'shwo'], ['state', 'recrod'], ['policy', 'sett']]) {
    const r = run(P, args);
    assert.notStrictEqual(r.status, 0, args.join(' ') + '\n' + show(r));
    assert.ok(/unknown|알 수 없는/i.test(r.stdout + r.stderr), show(r));
  }
  assert.deepStrictEqual(tree(P), before);
  for (const args of [['glossary', 'show'], ['state', 'show'], ['policy', 'show']]) {
    const r = run(P, args); assert.strictEqual(r.status, 0, args.join(' ') + '\n' + show(r));
  }
});

test('88 env detect does not report an unmeasured Windows encoding or shell', () => {
  const P = project();
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = run(P, ['env', 'detect', '--json'], { SHELL: '/usr/bin/bash', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATH: process.env.PATH.split(path.delimiter).filter(p => !/[\\/](\.cargo|rustup)/i.test(p)).join(path.delimiter) });
    if (r.status === 0) break;
  }
  assert.strictEqual(r.status, 0, show(r));
  const j = JSON.parse(r.stdout);
  const snap = j.snapshot || j;
  assert.notStrictEqual(snap.locale.encoding, 'cp949(default)');
  assert.strictEqual(snap.shell.name, 'bash');
});

test('90 run records created in the same millisecond keep distinct ids and stay listed', () => {
  const P = project();
  const ids = inChild(['_recordRun'], `
    const real = Date.prototype.toISOString; Date.prototype.toISOString = function () { return '2026-01-01T00:00:00.000Z'; };
    try { return [core._recordRun(${JSON.stringify(P)}, { kind: 'a' }), core._recordRun(${JSON.stringify(P)}, { kind: 'b' }), core._recordRun(${JSON.stringify(P)}, { kind: 'c' })]; }
    finally { Date.prototype.toISOString = real; }`);
  assert.strictEqual(new Set(ids).size, 3, JSON.stringify(ids));
  const list = run(P, ['runs', 'list', '--json']);
  const j = JSON.parse(list.stdout);
  assert.strictEqual(j.items.length, 3, show(list));
});

test('91 skill impact does not count a longer id as a use of its prefix id', () => {
  const P = project();
  fs.writeFileSync(ws(P, 'skill-suggestions.md'), '- feature-implementation-extended\n- project-roadmap-generator\n');
  const r = run(P, ['skill', 'impact', '--json']);
  assert.strictEqual(r.status, 0, show(r));
  const by = Object.fromEntries(JSON.parse(r.stdout).skills.map(s => [s.id, s.uses]));
  assert.strictEqual(by['feature-implementation'], 0, JSON.stringify(by));
  assert.strictEqual(by['project-roadmap-generator'], 1, JSON.stringify(by));
});

test('91 REPL session messages carry the time of each message, not of the save', () => {
  const P = project();
  replSession(P, [['first message', '응답 실패', 6000], ['second message', '응답 실패', 3000]]);
  const dir = path.join(P, '.leerness', 'cache', 'agent-sessions');
  const file = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))[0];
  const rows = fs.readFileSync(path.join(dir, file), 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l)).filter(r => r.role === 'user');
  assert.strictEqual(rows.length, 2, JSON.stringify(rows));
  assert.ok(Date.parse(rows[1].at) - Date.parse(rows[0].at) >= 3000, JSON.stringify(rows));
});

test('92 role store failure is reported in the language of the --path project', () => {
  const A = project('en'), B = project('ko');
  fs.writeFileSync(path.join(B, '.leerness', 'agent-roles.json'), '{');
  const noLang = { ...env }; delete noLang.LEERNESS_LANG;
  const r = cp.spawnSync(process.execPath, [CLI, 'roles', 'list', '--path', B], { cwd: A, encoding: 'utf8', timeout: 120000, windowsHide: true, env: noLang });
  assert.notStrictEqual(r.status, 0, show(r));
  assert.ok(/[가-힣]/.test(r.stdout + r.stderr), show(r));
});

test('95 reuse autodetect --apply keeps the table intact and writes no release label', () => {
  const P = project();
  fs.mkdirSync(path.join(P, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(P, 'lib', 'a.js'), 'function fooBarBaz() {}\nmodule.exports = { fooBarBaz };\n');
  fs.writeFileSync(ws(P, 'reuse-map.md'), '# Reuse Map\n\n| Name | Where | Kind | Note |\n|------|-------|------|------|\n| Existing | x.js | util | keep');
  const r = run(P, ['reuse', 'autodetect', '--apply']);
  assert.strictEqual(r.status, 0, show(r));
  const text = fs.readFileSync(ws(P, 'reuse-map.md'), 'utf8');
  const lines = text.split('\n');
  assert.ok(lines.includes('| Existing | x.js | util | keep'), text);
  assert.ok(lines.some(l => /^\| fooBarBaz \| lib\/a\.js \| util \| autodetect \|$/.test(l)), text);
  assert.ok(!/autodetect 1\./.test(text), text);
});

const nutDir = path.join(arena, 'modules', '@nut-tree', 'nut-js'); fs.mkdirSync(nutDir, { recursive: true });
fs.writeFileSync(path.join(nutDir, 'index.js'), "class Point { constructor(x, y) { this.x = x; this.y = y; } }\n"
  + "module.exports = { Point, Button: { LEFT: 0 }, mouse: { move: async () => { throw new Error('boom-move'); }, click: async () => {} },\n"
  + "  keyboard: { type: async () => { throw new Error('boom-type'); } }, screen: { capture: async () => { throw new Error('boom-shot'); } } };\n");
test('97 a rejected nut-js action is reported and recorded as a failed run', () => {
  const P = project();
  assert.strictEqual(run(P, ['permissions', 'set', 'full']).status, 0);
  const NODE_PATH = path.join(arena, 'modules');
  for (const [args, kind, text] of [[['pc', 'click', '5', '6'], 'pc_click', 'boom-move'], [['pc', 'type', 'hi'], 'pc_type', 'boom-type'], [['pc', 'screenshot', '--out', path.join(P, 's.png')], 'pc_screenshot', 'boom-shot']]) {
    const r = run(P, args, { NODE_PATH });
    assert.notStrictEqual(r.status, 0, show(r));
    assert.ok((r.stdout + r.stderr).includes(text), show(r));
    const runs = path.join(P, '.leerness', 'cache', 'agent-runs');
    const rows = fs.existsSync(runs) ? fs.readdirSync(runs).flatMap(f => fs.readFileSync(path.join(runs, f), 'utf8').trim().split('\n').map(l => JSON.parse(l))) : [];
    assert.ok(rows.some(x => x.kind === kind && x.ok === false), kind + ' ' + JSON.stringify(rows));
  }
});

test('98 stale-version notice appears for subcommands and is skipped for session close', () => {
  const P = project();
  fs.mkdirSync(path.join(P, '.leerness', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(P, '.leerness', 'cache', 'update-check.json'), JSON.stringify({ at: Date.now(), nextLeerness: '99.0.0' }));
  const stale = { LEERNESS_NO_STALE_CHECK: '' };
  const list = spawn(P, ['task', 'list'], stale);
  assert.ok(/99\.0\.0/.test(list.stderr), show(list));
  const close = spawn(P, ['session', 'close', '.', '--dry-run'], stale);
  assert.ok(!/99\.0\.0/.test(close.stderr), show(close));
});

test('99 agent rejects an unknown --role', () => {
  const P = project();
  const r = run(P, ['agent', 'say hi', '--role', 'bogus', '--dry-run']);
  assert.notStrictEqual(r.status, 0, show(r));
  assert.ok(!/^role: bogus/m.test(r.stdout), show(r));
  assert.ok(/bogus/.test(r.stdout + r.stderr), show(r));
});

test('101a creds register rejects a non-positive or non-numeric token lifetime', () => {
  const P = project();
  for (const v of ['abc', '0', '-5']) {
    const r = run(P, ['creds', 'register', 'svc', '--env-var', 'SVC_TOKEN', '--token-lifetime-hours=' + v]);
    assert.notStrictEqual(r.status, 0, v + '\n' + show(r));
    assert.ok(!/creds registered/.test(r.stdout), v + '\n' + show(r));
  }
  const good = run(P, ['creds', 'register', 'svc', '--env-var', 'SVC_TOKEN', '--token-lifetime-hours', '24']);
  assert.strictEqual(good.status, 0, show(good));
  assert.strictEqual(JSON.parse(fs.readFileSync(ws(P, 'credentials.local.json'), 'utf8')).services.svc.tokenLifetimeHours, 24);
});

test('101c rule assess does not report an internal formatter failure as invalid input', () => {
  const hook = path.join(arena, 'break-format.cjs');
  fs.writeFileSync(hook, "const m = require(" + JSON.stringify(path.resolve(__dirname, '../lib/rule-assessment-cli.js')) + "); m.formatRuleAssessment = () => { throw new Error('internal-format-boom'); };\n");
  const input = JSON.stringify({ schema: 'leerness.rule-assessment-input/v1', task: { id: 'T-1', taskType: 'migration', environment: 'staging', operation: 'copy' },
    rules: [{ id: 'R-1', text: 'Direct IAM check', source: { kind: 'gate', ref: 'runbook.md#iam' }, appliesWhen: { taskType: 'migration', environment: 'staging' } }] });
  const D = emptyDir();
  const r = cp.spawnSync(process.execPath, ['--require', hook, CLI, 'rule', 'assess', '--input', input], { cwd: D, encoding: 'utf8', timeout: 120000, windowsHide: true, env });
  assert.ok(!/Invalid rule assessment input/.test(r.stdout + r.stderr), show(r));
  assert.ok(/internal-format-boom/.test(r.stdout + r.stderr), show(r));
  const bad = spawn(D, ['rule', 'assess', '--input', '{']);
  assert.ok(/Invalid rule assessment input/.test(bad.stdout + bad.stderr), show(bad));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
