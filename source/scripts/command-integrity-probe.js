'use strict';
require('./temp-cleanup').trackTemp(module);
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), crypto = require('crypto');
const CLI = path.resolve(__dirname, '../bin/leerness.js');
const arena = fs.mkdtempSync(path.join(os.tmpdir(), 'leerness-command-integrity-'));
const env = { ...process.env, LEERNESS_INTERNAL: '1', LEERNESS_OFFLINE: '1', LEERNESS_NO_STALE_CHECK: '1', LEERNESS_NO_PATH_CHECK: '1',
  LEERNESS_NO_AUTOCHCP: '1', LEERNESS_HOOK: '', LEERNESS_NO_PROMPT: '1', LEERNESS_NO_SKILL_HISTORY: '1', LEERNESS_LANG: 'en' };
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) { env[key] = path.join(arena, 'env-' + key.toLowerCase()); fs.mkdirSync(env[key]); }
const hook = path.join(arena, 'fail-writes.cjs');
fs.writeFileSync(hook, "const fs = require('fs'); const re = new RegExp(process.env.FAIL_WRITE_RE); const orig = fs.writeFileSync;\n"
  + "fs.writeFileSync = function (p, ...rest) { if (typeof p === 'string' && re.test(p.replace(/\\\\/g, '/'))) { const e = new Error('injected write failure'); e.code = 'EACCES'; throw e; } return orig.call(this, p, ...rest); };\n");
let passed = 0, failed = 0, seq = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e && e.stack || e)); } };
const run = (dir, args, failRe = null) => cp.spawnSync(process.execPath, [...(failRe ? ['--require', hook] : []), CLI, ...args, '--path', dir], {
  cwd: dir, encoding: 'utf8', timeout: 180000, windowsHide: true, env: failRe ? { ...env, FAIL_WRITE_RE: failRe } : env });
const show = r => `exit ${r.status}\n${String(r.stdout || '').slice(0, 1500)}\n${String(r.stderr || '').slice(0, 800)}`;
const sha = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
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

test('a user request whose save fails is not reported as recorded or completed', () => {
  const P = project();
  const added = run(P, ['requests', 'add', 'first request']);
  assert.ok(added.status === 0 && /recorded UR-0001/.test(added.stdout), show(added));
  const before = sha(ws(P, 'user-requests.json'));
  const done = run(P, ['requests', 'complete', 'UR-0001'], 'user-requests\\.json\\.tmp-');
  assert.ok(done.status !== 0 && !/completed UR-0001/.test(done.stdout), show(done));
  const second = run(P, ['requests', 'add', 'second request'], 'user-requests\\.json\\.tmp-');
  assert.ok(second.status !== 0 && !/recorded/.test(second.stdout), show(second));
  assert.strictEqual(sha(ws(P, 'user-requests.json')), before);
});

test('idempotency auto-fix reports a failed user-request save as an error, not as dropped', () => {
  const P = project();
  for (let i = 0; i < 2; i++) fs.writeFileSync(ws(P, 'user-requests.json'), JSON.stringify({ requests: [
    { id: 'UR-0001', text: 'same request', status: 'open' }, { id: 'UR-0002', text: 'same request', status: 'open' }] }, null, 2));
  const before = sha(ws(P, 'user-requests.json'));
  const r = run(P, ['idempotency', 'audit', '--auto-fix', '--json'], 'user-requests\\.json\\.tmp-');
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  const fix = j && (j.autoFixed || []).find(f => f.kind === 'user-request-duplicate');
  assert.ok(r.status !== 0 && fix && fix.action === 'error', show(r));
  assert.strictEqual(sha(ws(P, 'user-requests.json')), before);
});

test('shell-guard --record does not claim a record it could not save, and refuses a corrupt store', () => {
  const P = project();
  const json = run(P, ['shell-guard', '--record', '--cmd', 'npm run build', '--exit', '1', '--json'], 'shell-failures\\.json\\.tmp-');
  assert.ok(json.status !== 0 && !/"recorded":\s*true/.test(json.stdout), show(json));
  const text = run(P, ['shell-guard', '--record', '--cmd', 'npm run build', '--exit', '1'], 'shell-failures\\.json\\.tmp-');
  assert.ok(text.status !== 0 && !/✓/.test(text.stdout), show(text));
  fs.writeFileSync(ws(P, 'shell-failures.json'), '{"failures": [{"cmd": "kept"}');
  const before = sha(ws(P, 'shell-failures.json'));
  const corrupt = run(P, ['shell-guard', '--record', '--cmd', 'npm test', '--exit', '1', '--json']);
  assert.ok(corrupt.status !== 0 && !/"recorded":\s*true/.test(corrupt.stdout), show(corrupt));
  assert.strictEqual(sha(ws(P, 'shell-failures.json')), before);
});

test('constraints add reports a failed save and refuses inherited object keys as platform ids', () => {
  const P = project();
  const failedSave = run(P, ['constraints', 'add', 'acme', '--constraint', 'rate:10/min'], 'platform-constraints\\.json\\.tmp-');
  assert.ok(failedSave.status !== 0 && !/✓/.test(failedSave.stdout), show(failedSave));
  for (const id of ['__proto__', 'constructor', 'toString']) {
    const before = sha(ws(P, 'platform-constraints.json'));
    const r = run(P, ['constraints', 'add', id, '--constraint', 'rate:10/min', '--json']);
    assert.ok(r.status !== 0 && !/✓/.test(r.stdout), id + ' ' + show(r));
    assert.strictEqual(sha(ws(P, 'platform-constraints.json')), before, id);
  }
});

test('pre-wake-audit keeps a report history it cannot parse instead of replacing it', () => {
  const P = project();
  fs.writeFileSync(ws(P, 'pre-wake-report.json'), '{"reports": [{"auditedAt": "kept"}');
  const before = sha(ws(P, 'pre-wake-report.json'));
  const r = run(P, ['pre-wake-audit', '--json']);
  assert.strictEqual(sha(ws(P, 'pre-wake-report.json')), before, show(r));
});

test('persona ids cannot leave .leerness/personas or name inherited object keys', () => {
  const P = project();
  fs.writeFileSync(path.join(P, 'outside.md'), '# Outside\nsecret body\n');
  const add = run(P, ['persona', 'add', '../../escaped']);
  assert.ok(add.status !== 0 && !fs.existsSync(path.join(path.dirname(P), 'escaped.md')) && !fs.existsSync(path.join(P, 'escaped.md')), show(add));
  for (const id of ['../../outside', 'constructor', 'toString']) {
    const r = run(P, ['persona', 'show', id, '--json']);
    assert.ok(r.status !== 0 && !/secret body/.test(r.stdout), id + ' ' + show(r));
  }
  for (const id of ['domain-expert', '보안-전문가']) {
    const ok = run(P, ['persona', 'add', id]);
    assert.ok(ok.status === 0 && fs.existsSync(path.join(P, '.leerness', 'personas', id + '.md')), id + ' ' + show(ok));
  }
});

test('a successful deploy auto does not rewrite credentials or mark the token as refreshed', () => {
  const P = project();
  fs.writeFileSync(path.join(P, 'deploy-step.js'), "require('fs').writeFileSync('deployed.txt', 'ok')\n");
  const reg = run(P, ['creds', 'register', 'svc', '--env-var', 'PROBE_DEPLOY_TOKEN', '--deploy', 'node deploy-step.js']);
  assert.strictEqual(reg.status, 0, show(reg));
  assert.strictEqual(run(P, ['permissions', 'set', 'extended']).status, 0);
  const file = ws(P, 'credentials.local.json'), before = sha(file);
  const r = cp.spawnSync(process.execPath, [CLI, 'deploy', 'auto', 'svc', '--path', P], { cwd: P, encoding: 'utf8', timeout: 180000, windowsHide: true, env: { ...env, PROBE_DEPLOY_TOKEN: 'x' } });
  assert.ok(r.status === 0 && fs.existsSync(path.join(P, 'deployed.txt')), show(r));
  assert.strictEqual(sha(file), before, 'credentials.local.json changed after deploy: ' + fs.readFileSync(file, 'utf8'));
});

test('lazy-detect keeps working when known-todos.json holds valid JSON that is not a list', () => {
  const P = project();
  fs.writeFileSync(path.join(P, 'work.js'), '// TODO: finish the parser\nmodule.exports = 1;\n');
  for (const value of ['{}', 'null', '"text"']) {
    fs.writeFileSync(ws(P, 'known-todos.json'), value);
    const r = run(P, ['lazy', 'detect', P, '--json']);
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    assert.ok(j && !j.error && j.todoCount === 1, value + ' ' + show(r));
  }
});

test('--json prints only JSON on empty and error paths, and an unknown agent exits non-zero', () => {
  const P = project();
  const parse = (args, expectExit = 0) => {
    const r = run(P, args);
    let value; try { value = JSON.parse(r.stdout); } catch { assert.fail(args.join(' ') + ' stdout is not JSON: ' + show(r)); }
    assert.strictEqual(r.status, expectExit, args.join(' ') + ' ' + show(r));
    return value;
  };
  assert.ok(Array.isArray(parse(['lessons', '--auto', '--json']).lessons));
  fs.rmSync(path.join(P, '.leerness', 'skills'), { recursive: true, force: true });
  assert.strictEqual(typeof parse(['skill', 'match', 'parser work', '--json']).matched, 'number');
  assert.strictEqual(parse(['resume', '--json']), null);
  assert.strictEqual(parse(['pre-wake-audit', '--last', '--json']), null);
  assert.ok(parse(['slash-commands', 'no-such-agent', '--json'], 1).error);
  const todo = path.join(P, 'todo.json');
  fs.writeFileSync(todo, JSON.stringify([{ content: 'sync item', status: 'pending', activeForm: 'syncing' }]));
  assert.strictEqual(parse(['task', 'sync', '--from', todo, '--json']).imported, 1);
});

test('benchmark --scenario runs its fixtures outside the project and leaves the project files as they were', () => {
  const P = project();
  const tree = () => { const out = {}; const walk = r => { for (const e of fs.readdirSync(path.join(P, r), { withFileTypes: true })) { const p = r ? r + '/' + e.name : e.name; if (p === '.leerness/cache') continue; if (e.isDirectory()) walk(p); else out[p] = sha(path.join(P, p)); } }; walk(''); return out; };
  const before = tree();
  const r = run(P, ['benchmark', P, '--scenario', 'all', '--json']);
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  assert.ok(r.status === 0 && j && j.total === 4, show(r));
  assert.deepStrictEqual(tree(), before);
});

test('names that are inherited object keys are unknown, not crashes, and a service cannot be registered under them', () => {
  const P = project();
  for (const args of [['skill', 'info', 'constructor'], ['lens', 'constructor'], ['route', 'toString']]) {
    const r = run(P, args);
    assert.ok(r.status !== 0 && !/TypeError|is not a function|Cannot read prop/.test(r.stdout + r.stderr), args.join(' ') + ' ' + show(r));
  }
  const creds = ws(P, 'credentials.local.json'), before = sha(creds);
  for (const name of ['__proto__', 'constructor']) {
    const r = run(P, ['creds', 'register', name, '--env-var', 'PROBE_TOKEN']);
    assert.ok(r.status !== 0, name + ' ' + show(r));
  }
  assert.strictEqual(sha(creds), before);
  const korean = run(P, ['creds', 'register', '락프로브', '--env-var', 'PROBE_TOKEN']);
  assert.ok(korean.status === 0, 'a non-ASCII service name must stay usable ' + show(korean));
});

test('creds list reports a malformed service record instead of crashing, and plan sync claims nothing', () => {
  const P = project();
  fs.writeFileSync(ws(P, 'credentials.local.json'), JSON.stringify({ services: { broken: {}, good: { envVars: ['PROBE_TOKEN'] } } }));
  const list = run(P, ['creds', 'list']);
  assert.ok(list.status === 0 && /good/.test(list.stdout) && !/TypeError|Cannot read prop/.test(list.stdout + list.stderr), show(list));
  const log = ws(P, 'task-log.md'), before = sha(log);
  const sync = run(P, ['plan', 'sync']);
  assert.ok(sync.status === 0 && sha(log) === before, 'plan sync wrote to task-log.md: ' + show(sync));
});

test('a CSS variable from the project cannot add attributes to the generated roadmap page', () => {
  const P = project();
  fs.writeFileSync(path.join(P, 'styles.css'), ':root {\n  --brand: #123456;\n  --evil: #fff" onmouseover="alert(1);\n}\n');
  const out = path.join(P, 'roadmap-test.html');
  const r = run(P, ['roadmap', P, '--out', out]);
  const html = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  assert.ok(r.status === 0 && html.includes('style="background:#123456"'), show(r));
  assert.ok(!/onmouseover="alert/.test(html), 'raw attribute injected into the roadmap page');
});

async function webhookBindsLoopbackAndChecksSignatures() {
  const P = project(), secret = 'probe-secret';
  const child = cp.spawn(process.execPath, [CLI, 'webhook', 'serve', '--port', '0', '--secret', secret, '--path', P], { cwd: P, env, windowsHide: true });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  try {
    const deadline = Date.now() + 60000;
    while (!/listening on /.test(out)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('webhook server did not start: ' + out);
      await new Promise(r => setTimeout(r, 100));
    }
    const m = /listening on (\S+):(\d+)/.exec(out);
    assert.ok(m && m[1] === '127.0.0.1', 'webhook serve must bind loopback by default: ' + out);
    const body = JSON.stringify({ error: 'probe incident' });
    const post = sig => new Promise((resolve, reject) => {
      const req = require('http').request({ host: '127.0.0.1', port: Number(m[2]), path: '/incident', method: 'POST', headers: { 'content-type': 'application/json', 'x-leerness-signature': sig } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(body);
    });
    const good = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.deepStrictEqual([await post('x'), await post(good.replace(/.$/, c => (c === '0' ? '1' : '0'))), await post(good)], [401, 401, 202], out);
  } finally { child.kill(); }
}

async function orchestrateUsesTheChatEndpointOnSuccess() {
  const P = project(), hits = [];
  const server = require('http').createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      hits.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/chat'
        ? { message: { content: '{"plan":["write the validator"]}' }, prompt_eval_count: 5, eval_count: 7 }
        : { response: 'generate endpoint used' }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const out = await new Promise(resolve => {
      const child = cp.spawn(process.execPath, [CLI, 'orchestrate', 'write a JSON validator', '--agents', '1', '--path', P], {
        cwd: P, windowsHide: true, env: { ...env, LEERNESS_OLLAMA_BASE_URL: `http://127.0.0.1:${server.address().port}` } });
      let text = ''; child.stdout.on('data', d => { text += d; }); child.stderr.on('data', d => { text += d; });
      child.on('close', code => resolve({ code, text }));
    });
    assert.ok(out.code === 0 && hits.length === 1 && hits[0] === '/api/chat', JSON.stringify(hits) + '\n' + out.text.slice(0, 1500));
    assert.ok(/prompt 합계: 5 · response 합계: 7/.test(out.text), out.text.slice(0, 1500));
  } finally { server.close(); }
}

(async () => {
  try { await webhookBindsLoopbackAndChecksSignatures(); passed++; console.log('PASS webhook serve binds loopback by default and rejects wrong signatures'); }
  catch (e) { failed++; console.error('FAIL webhook serve binds loopback by default and rejects wrong signatures: ' + (e && e.stack || e)); }
  try { await orchestrateUsesTheChatEndpointOnSuccess(); passed++; console.log('PASS orchestrate calls the chat endpoint and reports its token counts'); }
  catch (e) { failed++; console.error('FAIL orchestrate calls the chat endpoint and reports its token counts: ' + (e && e.stack || e)); }
  try { require('./temp-cleanup').removeTree(arena, { recursive: true, force: true }); } catch {}
  console.log(`Tests: ${passed}/${passed + failed} passed`);
  if (failed) process.exitCode = 1;
})();
