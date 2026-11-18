'use strict';
require('./temp-cleanup').trackTemp(module);
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const CLI = path.resolve(__dirname, '../bin/leerness.js');
const arena = fs.mkdtempSync(path.join(os.tmpdir(), 'leerness-release-cmd-'));
const env = { ...process.env, LEERNESS_INTERNAL: '1', LEERNESS_OFFLINE: '1', LEERNESS_NO_STALE_CHECK: '1', LEERNESS_NO_PATH_CHECK: '1',
  LEERNESS_NO_AUTOCHCP: '1', LEERNESS_HOOK: '', LEERNESS_NO_PROMPT: '1', LEERNESS_NO_SKILL_HISTORY: '1', LEERNESS_LANG: 'en',
  GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid', GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid',
  GIT_TERMINAL_PROMPT: '0' };
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) { env[key] = path.join(arena, 'env-' + key.toLowerCase()); fs.mkdirSync(env[key]); }
env.GIT_CONFIG_GLOBAL = path.join(arena, 'gitconfig'); fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
let passed = 0, failed = 0, seq = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e && e.stack || e)); } };
const run = (dir, args, extraEnv = null) => cp.spawnSync(process.execPath, [CLI, ...args, '--path', dir], {
  cwd: dir, encoding: 'utf8', timeout: 180000, windowsHide: true, env: extraEnv ? { ...env, ...extraEnv } : env });
const show = r => `exit ${r.status}\n${String(r.stdout || '').slice(0, 1500)}\n${String(r.stderr || '').slice(0, 800)}`;
const git = (dir, args) => { const r = cp.spawnSync('git', args, { cwd: dir, encoding: 'utf8', env, windowsHide: true }); assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return (r.stdout || '').trim(); };
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
const read = f => fs.readFileSync(f, 'utf8');
const fresh = prefix => { const d = path.join(arena, prefix + (++seq)); fs.mkdirSync(d); return d; };

const stubDir = path.join(arena, 'stubs'); fs.mkdirSync(stubDir);
const ghLog = path.join(arena, 'gh.log');
const ghCalled = () => fs.existsSync(ghLog) && /release create/.test(fs.readFileSync(ghLog, "utf8"));
if (process.platform === 'win32') {
  const stubSrc = path.join(arena, 'stub.cs');
  fs.writeFileSync(stubSrc, 'using System; using System.IO; public class P { public static int Main(string[] a) { string log = Environment.GetEnvironmentVariable("PROBE_STUB_LOG"); if (!string.IsNullOrEmpty(log)) File.AppendAllText(log, string.Join(" ", a) + Environment.NewLine); return 1; } }');
  const built = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -OutputAssembly $env:PROBE_EXE -OutputType ConsoleApplication -TypeDefinition (Get-Content -LiteralPath $env:PROBE_SRC -Raw)'],
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, PROBE_EXE: path.join(stubDir, 'gh.exe'), PROBE_SRC: stubSrc } });
  assert.strictEqual(built.status, 0, 'stub build failed: ' + built.stderr);
  fs.copyFileSync(path.join(stubDir, 'gh.exe'), path.join(stubDir, 'tar.exe'));
} else {
  const stub = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PROBE_STUB_LOG"\nexit 1\n';
  for (const name of ['gh', 'tar']) fs.writeFileSync(path.join(stubDir, name), stub, { mode: 0o755 });
}
const withStubs = () => { const p = stubDir + path.delimiter + (process.env.Path || process.env.PATH); return { PATH: p, Path: p, PROBE_STUB_LOG: ghLog }; };

// a git project whose origin looks like github but is a local bare repository
const gitProject = (opts = {}) => {
  const dir = project();
  const bare = path.join(arena, 'github.com', 'probe', 'repo' + (++seq) + '.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(arena, ['init', '--bare', '-b', 'main', bare]);
  git(dir, ['init', '-b', opts.branch || 'main']);
  git(dir, ['add', '-A']); git(dir, ['commit', '-m', 'base']);
  git(dir, ['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
  git(dir, ['config', 'user.email', 'probe@example.invalid']); git(dir, ['config', 'user.name', 'probe']);
  return { dir, bare };
};

test('63 gh-pages deploy publishes the new commit when gh-pages already exists on origin', () => {
  const { dir, bare } = gitProject();
  fs.writeFileSync(path.join(dir, 'page.html'), '<p>first</p>\n');
  const r1 = run(dir, ['release', 'publish', '--gh-pages', '--gh-pages-src', 'page.html']);
  assert.strictEqual(r1.status, 0, show(r1));
  fs.writeFileSync(path.join(dir, 'page.html'), '<p>second</p>\n');
  const r2 = run(dir, ['release', 'publish', '--gh-pages', '--gh-pages-src', 'page.html']);
  assert.strictEqual(r2.status, 0, show(r2));
  assert.strictEqual(git(bare, ['show', 'gh-pages:index.html']), '<p>second</p>', show(r2));
});

test('68 release publish fails when a requested gh-pages deploy or gh release fails', () => {
  const { dir } = gitProject();
  const noSrc = run(dir, ['release', 'publish', '--gh-pages', '--gh-pages-src', 'missing.html']);
  assert.ok(noSrc.status !== 0 && !/release publish 완료/.test(noSrc.stdout), show(noSrc));
  const gh = run(dir, ['release', 'publish', '--gh-release'], withStubs());
  assert.ok(ghCalled(), 'gh stub was not called\n' + show(gh));
  assert.ok(gh.status !== 0 && !/release publish 완료/.test(gh.stdout), show(gh));
});

test('64 skill publish --bundle-only never creates a release, and a release uploads the archive that exists', () => {
  const dir = project();
  fs.rmSync(ghLog, { force: true });
  const bundle = run(dir, ['skill', 'publish', '--no-security-check', '--bundle-only', '--gh-release'], withStubs());
  assert.ok(!ghCalled(), 'gh was called with --bundle-only\n' + show(bundle));
  const rel = run(dir, ['skill', 'publish', '--no-security-check', '--gh-release'], withStubs());
  assert.ok(ghCalled(), show(rel));
  const asset = read(ghLog).split(/\r?\n/).find(l => /release create/.test(l)).split(/\s+/).find(t => /leerness-skills-.*\.(tgz|zip)$/.test(t));
  assert.ok(asset && fs.existsSync(asset.replace(/^"|"$/g, '')), `release asset missing: ${asset}\n${show(rel)}`);
  assert.ok(rel.status !== 0, 'failed gh release must fail the command\n' + show(rel));
});

test('72 skill publish drops stale generated skill folders but keeps foreign ones', () => {
  const dir = project();
  const first = run(dir, ['skill', 'publish', '--no-security-check']);
  assert.strictEqual(first.status, 0, show(first));
  const out = ws(dir, 'skills-publish');
  const ids = fs.readdirSync(out, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  assert.ok(ids.length >= 2, 'need at least two generated skills: ' + ids);
  fs.mkdirSync(path.join(out, 'mine')); fs.writeFileSync(path.join(out, 'mine', 'SKILL.md'), '---\nname: mine\npublisher: me\n---\n');
  const second = run(dir, ['skill', 'publish', '--no-security-check', '--include', ids[0]]);
  assert.strictEqual(second.status, 0, show(second));
  const left = fs.readdirSync(out, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  assert.deepStrictEqual(left, [ids[0], 'mine'].sort(), show(second));
});

test('66 skill suggest honours --days for dated sources and rejects bad numbers', () => {
  const dir = project();
  const line = '- ran `leerness zzoldcmd go`\n';
  fs.writeFileSync(ws(dir, 'task-log.md'), '# Task log\n\n## 2019-01-01\n' + line.repeat(5) + '\n## ' + new Date().toISOString().slice(0, 10) + '\n- ran `leerness zzfreshcmd go`\n'.repeat(5));
  const j = run(dir, ['skill', 'suggest', '--min', '3', '--days', '30', '--json']);
  assert.strictEqual(j.status, 0, show(j));
  const keys = JSON.parse(j.stdout).candidates.map(c => c.keyword);
  assert.ok(keys.includes('zzfreshcmd go') && !keys.includes('zzoldcmd go'), JSON.stringify(keys));
  const bad = run(dir, ['skill', 'suggest', '--days', 'abc', '--json']);
  assert.ok(bad.status !== 0, show(bad));
});

test('67 ui consistency ignores the generated dashboard, css ids and short/long hex spellings', () => {
  const dir = project();
  fs.writeFileSync(ws(dir, 'design-system.md'), '# Design System\n\n| Token | Value |\n|---|---|\n| color-bg | #ffffff |\n');
  fs.writeFileSync(path.join(dir, 'leerness.html'), '<style>:root{--a:#111111;--b:#222222}</style>\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.css'), '#add-btn { color: #fff; }\n#bad .x { margin: 0; }\n.y { color: #123456; }\n');
  const r = run(dir, ['ui', 'consistency']);
  const out = r.stdout;
  assert.ok(/src\/a\.css:3\s+#123456/.test(out), 'a real violation must still be reported\n' + show(r));
  assert.ok(!/leerness\.html/.test(out) && !/#add-btn/.test(out) && !/#bad/.test(out) && !/#fff\b/.test(out), show(r));
});

test('69 sync-main refuses a detached HEAD and returns to the original branch', () => {
  const { dir, bare } = gitProject();
  git(dir, ['push', 'origin', 'main']);
  git(dir, ['checkout', '-b', 'release/a']); fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); git(dir, ['add', '-A']); git(dir, ['commit', '-m', 'a']);
  git(dir, ['checkout', '-b', 'release/b']); fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n'); git(dir, ['add', '-A']); git(dir, ['commit', '-m', 'b']);
  git(dir, ['checkout', 'release/a']);
  const viaBranch = run(dir, ['release', 'sync-main', '--no-npm', '--branch', 'release/b']);
  assert.strictEqual(viaBranch.status, 0, show(viaBranch));
  assert.strictEqual(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'release/a', 'original branch not restored\n' + show(viaBranch));
  const before = git(bare, ['rev-parse', 'main']);
  git(dir, ['checkout', '--detach']);
  const detached = run(dir, ['release', 'sync-main', '--no-npm']);
  assert.ok(detached.status !== 0 && !/main merged: HEAD/.test(detached.stdout), show(detached));
  assert.strictEqual(git(bare, ['rev-parse', 'main']), before);
});

test('70 release note keeps the entry under a version header that ends the file', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0 — 2026-01-01');
  const r = run(dir, ['release', 'note', 'new entry']);
  assert.strictEqual(r.status, 0, show(r));
  const text = read(path.join(dir, 'CHANGELOG.md'));
  assert.ok(text.startsWith('# Changelog\n') && /## 0\.1\.0 — 2026-01-01\n\n- new entry\n/.test(text), JSON.stringify(text));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0 — 2026-01-01\n\n- old\n');
  assert.strictEqual(run(dir, ['release', 'note', 'newer']).status, 0);
  assert.ok(/\n- newer\n- old\n/.test(read(path.join(dir, 'CHANGELOG.md'))), JSON.stringify(read(path.join(dir, 'CHANGELOG.md'))));
});

test('73 reuse register refuses an uninitialized folder and escapes table cells', () => {
  const empty = fresh('empty');
  const refused = run(empty, ['reuse', 'register', 'Thing']);
  assert.ok(refused.status !== 0 && !fs.existsSync(path.join(empty, '.leerness')), show(refused));
  const dir = project();
  assert.strictEqual(run(dir, ['reuse', 'register', 'Card', '--where', 'foo']).status, 0);
  const again = run(dir, ['reuse', 'register', 'foo']);
  assert.ok(!/already registered/.test(again.stdout), 'a name found in another column must not count as a duplicate\n' + show(again));
  assert.strictEqual(run(dir, ['reuse', 'register', 'A|B', '--note', 'x|y']).status, 0);
  const rows = read(ws(dir, 'reuse-map.md')).split('\n').filter(l => /^\| A/.test(l));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].split(/(?<!\\)\|/).length, 6, rows[0]);
});

test('74 rule stop / resume-all refuse an uninitialized folder', () => {
  for (const sub of ['stop', 'resume-all']) {
    const empty = fresh('empty');
    const r = run(empty, ['rule', sub]);
    assert.ok(r.status !== 0 && !fs.existsSync(path.join(empty, '.leerness')) && !/개 룰/.test(r.stdout), sub + '\n' + show(r));
  }
});

const releaseRepo = () => {
  const { dir } = gitProject();
  git(dir, ['checkout', '-b', 'work']);
  git(dir, ['checkout', 'main']);
  for (let i = 0; i < 7; i++) {
    git(dir, ['checkout', '-b', `release/1.0.${i}`]); fs.writeFileSync(path.join(dir, `r${i}.txt`), 'x'); git(dir, ['add', '-A']); git(dir, ['commit', '-m', 'r' + i]);
    git(dir, ['checkout', 'main']); git(dir, ['merge', '--no-ff', '-m', 'merge ' + i, `release/1.0.${i}`]);
  }
  return dir;
};

test('75 release cleanup deletes branches merged into main even when HEAD is elsewhere, and stops without main/master', () => {
  const dir = releaseRepo();
  git(dir, ['checkout', 'work']);
  const r = run(dir, ['release', 'cleanup', '--apply', '--keep', '5', '--json']);
  const j = JSON.parse(r.stdout);
  assert.ok(r.status === 0 && j.deleted === 2 && j.deleteFailed === 0, show(r));
  assert.ok(!git(dir, ['branch', '--list', 'release/*']).includes('release/1.0.0'));
  const noBase = gitProject({ branch: 'trunk' });
  const nb = run(noBase.dir, ['release', 'cleanup', '--json']);
  assert.ok(nb.status !== 0 && JSON.parse(nb.stdout).ok === false, show(nb));
});

test('76 verify-code treats a missing optional pytest as skipped on Windows too', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
  const nodeDir = path.dirname(process.execPath), sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const r = run(dir, ['verify-code'], { PATH: nodeDir + path.delimiter + sys32, Path: nodeDir + path.delimiter + sys32 });
  assert.ok(/test:python 스킵/.test(r.stdout) && !/test:python failed/.test(r.stdout), show(r));
  assert.strictEqual(r.status, 0, show(r));
});

test('77 guide --json survives --strict-exit and keeps the process argv untouched', () => {
  const dir = project();
  fs.writeFileSync(ws(dir, 'design-system.md'), '# Design System\n\n| Token | Value |\n|---|---|\n| color-bg | #ffffff |\n');
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'a.css'), '.y { color: #123456; }\n');
  const r = run(dir, ['guide', 'src/a.css', '--json', '--fail-on-violation', '--strict-exit']);
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  assert.ok(j && j.sections && /123456/.test(j.sections.uiConsistency), show(r));
  assert.strictEqual(r.status, 1, show(r));
});

test('78 release bump --json prints a success payload', () => {
  const dir = project();
  const r = run(dir, ['release', 'bump', '--patch', '--json']);
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  assert.ok(r.status === 0 && j && j.ok === true && j.from === '0.1.0' && j.to === '0.1.1', show(r));
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(arena, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
