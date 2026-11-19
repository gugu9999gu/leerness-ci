'use strict';
require('./temp-cleanup').trackTemp(module);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const test = require('node:test');
const cli = path.resolve(__dirname, '../bin/leerness.js');
const arena = fs.mkdtempSync(path.join(os.tmpdir(), 'leerness-policy-'));
const env = { ...process.env, LEERNESS_OFFLINE:'1', LEERNESS_INTERNAL:'1', LEERNESS_NO_STALE_CHECK:'1' };
function run(dir, args, expected = 0) {
  const res = cp.spawnSync(process.execPath, [cli, ...args, '--path', dir, '--json'], {cwd:dir,env,encoding:'utf8',timeout:90000,windowsHide:true});
  assert.ifError(res.error);
  assert.equal(res.status,expected, res.stdout + res.stderr);
  return JSON.parse(res.stdout.trim());
}
function project(name) {
  const dir = path.join(arena,name);
  fs.mkdirSync(dir);
  run(dir,['init','--minimal','--yes','--language','en','--no-auto-roadmap']);
  return dir;
}
test.after(() => require('../lib/safe-remove').removeSync(arena,{recursive:true,force:true}));

test('request editing, memo append, unique milestone and reservation of removed IDs', () => {
  const dir = project('tasks'), join = file => path.join(dir,'.leerness',file);
  const a=run(dir,['plan','add','Milestone alpha']);
  const b=run(dir,['plan','add','Milestone beta']);
  run(dir,['task','update',a.task,'--request','Edited request']);
  run(dir,['task','update',a.task,'--memo','First memo']);
  run(dir,['task','update',a.task,'--memo','Second memo']);
  assert.match(fs.readFileSync(join('progress-tracker.md'),'utf8'),/Edited request/);
  assert.match(fs.readFileSync(join('task-log.md'),'utf8'),/First memo[\s\S]*Second memo/);
  run(dir,['task','update',a.task,'--note','Legacy request']);
  assert.match(fs.readFileSync(join('progress-tracker.md'),'utf8'),/Legacy request/);
  assert.equal(run(dir,['plan','remove','Milestone'],1).code,'milestone_not_found');
  const duplicate = run(dir,['plan','add','Milestone beta']);
  assert.equal(run(dir,['plan','remove','Milestone beta'],1).code,'ambiguous_target');
  run(dir,['plan','remove',duplicate.milestone]);
  run(dir,['plan','remove',b.milestone]);
  assert.equal(run(dir,['memory','restore','plan','Milestone'],1).code,'archive_entry_not_found');
  assert.equal(run(dir,['memory','restore','plan','Milestone beta'],1).code,'ambiguous_target');
  run(dir,['memory','restore','plan',b.milestone]);
  const next=run(dir,['plan','add','New milestone']);
  assert(Number(next.milestone.slice(2)) > Number(duplicate.milestone.slice(2)));
});

test('grouped historical memory restores a single exact entry and retains other archive contents', () => {
  const { selectArchiveEntry }=require('../lib/archive-selection');
  const { renderLosslessArchiveEntries, archiveCheckLine,readArchiveCheck,readArchiveEntries }=require('../lib/memory-archive');
  const items=['one title','second title'].map(title=>({date:'2026-01-01',title,decision:'value',reason:'reason',alternatives:null,impact:null}));
  const body=renderLosslessArchiveEntries('decisions',items);
  const block='## 제거 2026-01-02 (target: "title")\n'+archiveCheckLine(items.length,body)+body;
  assert.equal(selectArchiveEntry('decisions',[block],'title').error,'archive_entry_not_found');
  const selection=selectArchiveEntry('decisions',[block],'second title');
  assert.equal(readArchiveCheck(selection.remainder).state,'ok');
  assert.equal(readArchiveCheck(selection.selected).state,'ok');
  assert.deepEqual(readArchiveEntries('decisions',selection.remainder).entries.map(e=>e.title),['one title']);
  assert.deepEqual(readArchiveEntries('decisions',selection.selected).entries.map(e=>e.title),['second title']);

  const dir = project('archive-groups');
  const archive = path.join(dir, '.leerness', 'decisions.archive.md');
  const content = '# Archive\n\n' + block + '\n' + block.replace('(target: "title")', '(target: "other")');
  fs.writeFileSync(archive, content);
  assert.equal(run(dir, ['memory', 'restore', 'decisions', '2026-01-02'], 1).code, 'archive_entry_not_found');
  assert.equal(fs.readFileSync(archive, 'utf8'), content);
  run(dir, ['memory', 'restore', 'decisions', 'title', '--archive-group']);
  const remaining = fs.readFileSync(archive, 'utf8');
  assert(remaining.includes('(target: "other")') && !remaining.includes('(target: "title")'));
});
test('guide v2 returns data and legacy JSON keeps text', () => {
  const dir=project('guide');
  fs.writeFileSync(path.join(dir,'module.js'),'module.exports={};');
  fs.writeFileSync(path.join(dir,'consumer.js'),"require('./module.js');");
  const legacy=run(dir,['guide','module.js']);
  assert.equal(typeof legacy.sections.impact,'string');
  const data=run(dir,['guide','module.js','--json-version','2']);
  assert.equal(data.schemaVersion,2);
  assert(data.sections.impact.high.includes('consumer.js'));
  assert(Array.isArray(data.sections.reuse.matches));
  assert(Array.isArray(data.sections.uiConsistency.findings));
  assert(Array.isArray(data.sections.lessons.lessons));
});
test('PNG decodes padded BGR pixels, agy transports Unicode prompts in stdin', () => {
  const { encodeRobotPng }=require('../lib/robot-png');
  const buf=encodeRobotPng({width:1,height:2,byteWidth:8,bytesPerPixel:4,image:Buffer.from([3,2,1,0,7,7,7,7,6,5,4,0,8,8,8,8])});
  assert.equal(buf.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(buf.readUInt32BE(16),1);assert.equal(buf.readUInt32BE(20),2);
  const length=buf.readUInt32BE(33);
  assert.equal(buf.toString('ascii',37,41),'IDAT');
  assert.deepEqual([...zlib.inflateSync(buf.subarray(41,41+length))],[0,1,2,3,0,4,5,6]);
  const agy=require('../lib/agy-input');
  const prompt='line 1\n한글 "comments"';
  const spec=require('../lib/agents')._benchLaunchSpec({id:'agy',bin:'agy'},prompt,false);
  assert(!spec.args.includes(prompt));assert.equal(spec.stdin,'pipe');
  assert.deepEqual(JSON.parse(spec.input),{event:'user',message:{content:prompt}});
  assert.equal(agy.response('{"event":"init"}\n{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n'),'done');
  assert.throws(()=>agy.response('{"event":"init"}\n'));
});
test('verified false positive expires, content changes re-arm, credential findings stay blocked', () => {
  const dir=project('receipt'), source=path.join(dir,'delimiters.js');
  const marker='-----BEGIN '+'PRIVATE KEY-----';
  fs.writeFileSync(source,'const delim = "'+marker+'";\n');
  const inspect=(exit=1)=>run(dir,['scan','secrets'],exit);
  const first=inspect().unacknowledged.find(row=>row.file==='delimiters.js');
  assert(first.findingId);
  const date=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
  const review=id=>['scan','secrets','--acknowledge',id,'--reason','literal delimiter','--approved-by','reviewer','--expires',date];
  assert.equal(run(dir,review(first.findingId)).recorded,1);
  assert.equal(inspect(0).acknowledgedCount,1);
  const receipt=path.join(dir,'.leerness','secret-baseline.json');
  const data=JSON.parse(fs.readFileSync(receipt,'utf8'));
  assert(!JSON.stringify(data).includes(marker));
  data.entries[0].expiresAt='2000-01-01T00:00:00.000Z';
  fs.writeFileSync(receipt,JSON.stringify(data));
  assert.equal(inspect().acknowledgedCount,0);
  run(dir,review(first.findingId));
  fs.appendFileSync(source,'// revised\n');
  assert.equal(inspect().unacknowledgedCount,1);
  fs.writeFileSync(path.join(dir,'private-material.txt'),marker+'\n');
  const key=inspect().unacknowledged.find(row=>row.file==='private-material.txt');
  assert.equal(key.findingId,undefined);
  assert.equal(run(dir,review(key.fp),1).code,'finding_not_eligible');
});
test('known lock inspection retries briefly and refuses persistent errors', () => {
  const dir=path.join(arena,'lock'), meta=path.join(dir,'.leerness');
  fs.mkdirSync(meta,{recursive:true});
  const target=path.join(meta,'execution-ledger.jsonl.lock');
  fs.mkdirSync(target);
  const layout=require('../lib/runtime-layout');
  function inspect(transient, code) {
    let attempts=0;
    const lstat=fs.lstatSync;
    fs.lstatSync=function(file,options) {
      if(file===target && attempts++ < transient) throw Object.assign(new Error('fixture'),{code});
      return lstat.call(fs,file,options);
    };
    try { return {report:layout.inspectRuntimeCompatibility(dir),attempts:()=>attempts}; } finally { fs.lstatSync=lstat; }
  }
  if (process.platform==='win32') { const once=inspect(1,'EBUSY'); assert(once.report.compatible, JSON.stringify([once.report,once.attempts()])); }
  const refused=inspect(Infinity,'EBUSY').report;
  assert(!refused.compatible);assert.equal(refused.diagnostic.osCode,'EBUSY');
  assert(refused.diagnostic.attempts>=1 && refused.diagnostic.attempts<=3);
  assert.equal(refused.diagnostic.syscall,'lstat');
  assert.equal(refused.diagnostic.path,path.join('.leerness','execution-ledger.jsonl.lock'));
  assert.equal(inspect(Infinity,'EIO').report.diagnostic.attempts,1);
});
