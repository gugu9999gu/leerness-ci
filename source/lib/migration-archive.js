'use strict';

// This module is also copied into a compact migration snapshot as restore.cjs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const removalModule = require.resolve(path.basename(__filename) === 'restore.cjs' ? './safe-remove.cjs' : './safe-remove');
const { removeSync } = require(removalModule);

const THRESHOLD = 64 * 1024;
const BLOCK = 1024 * 1024;
const FORMAT = 'leerness.migration-files/v1';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readBlock(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > BLOCK + 65536) throw new Error('Invalid archive block');
  return zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: BLOCK });
}

// Link only compressed objects from the preceding snapshot. Live files are never linked.
function reuseBlock(previous, target, digest, bytes) {
  if (!previous) return false;
  try { fs.linkSync(path.join(previous, digest + '.gz'), target); }
  catch { return false; } // Absent object, unsupported links or concurrently rotated snapshot.
  try { if (readBlock(target).equals(bytes)) return true; }
  catch { /* Rebuild an unreadable prior object from the current source. */ }
  fs.unlinkSync(target);
  return false;
}

function createPacker(stage, previous) {
  const objects = path.join(stage, 'objects');
  const files = [];
  const seen = new Set();
  const buffer = Buffer.allocUnsafe(BLOCK);

  function pack(source, relative, before) {
    const fd = fs.openSync(source, 'r');
    const blocks = [];
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs
        || opened.ctimeMs !== before.ctimeMs || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Backup source changed: ' + source);
      for (let offset = 0; offset < opened.size;) {
        const size = Math.min(BLOCK, opened.size - offset);
        let used = 0;
        while (used < size) {
          const count = fs.readSync(fd, buffer, used, size - used, offset + used);
          if (!count) throw new Error('Backup source truncated: ' + source);
          used += count;
        }
        offset += size;
        const bytes = buffer.subarray(0, size);
        const digest = hash(bytes);
        blocks.push(digest);
        if (seen.has(digest)) continue;
        if (!seen.size) fs.mkdirSync(objects);
        const target = path.join(objects, digest + '.gz');
        if (!reuseBlock(previous, target, digest, bytes)) {
          fs.writeFileSync(target, zlib.gzipSync(bytes, { level: 1 }), { flag: 'wx', mode: 0o600 });
        }
        seen.add(digest);
      }
      const after = fs.lstatSync(source);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error('Backup source changed: ' + source);
      files.push({ path: relative.split(path.sep), bytes: opened.size, mode: opened.mode & 0o777, blocks });
    } finally { fs.closeSync(fd); }
  }

  function finish() {
    if (!files.length) return false;
    fs.writeFileSync(path.join(stage, 'packed-files.json'), JSON.stringify({ format: FORMAT, files }) + '\n', { flag: 'wx' });
    fs.copyFileSync(__filename, path.join(stage, 'restore.cjs'), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(removalModule, path.join(stage, 'safe-remove.cjs'), fs.constants.COPYFILE_EXCL);
    return true;
  }
  return { pack, finish };
}

function restore(snapshot, destination) {
  const root = fs.realpathSync(snapshot);
  const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const target = path.join(parent, path.basename(path.resolve(destination)));
  const inside = path.relative(root, parent);
  if (inside === '' || (!inside.startsWith('..' + path.sep) && inside !== '..' && !path.isAbsolute(inside))) throw new Error('Choose a destination outside the snapshot');
  if (fs.existsSync(target)) throw new Error('Restore destination must be new');
  const indexFile = path.join(root, 'packed-files.json');
  if (!fs.lstatSync(indexFile).isFile()) throw new Error('Invalid archive index file');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  if (index.format !== FORMAT || !Array.isArray(index.files)) throw new Error('Invalid archive index');
  const objects = path.join(root, 'objects');
  if (!fs.lstatSync(objects).isDirectory()) throw new Error('Invalid archive objects directory');
  const stage = fs.mkdtempSync(path.join(parent, '.leerness-restore-'));
  let reserved = false;
  try {
    const files = path.join(root, 'files');
    if (!fs.lstatSync(files).isDirectory()) throw new Error('Invalid archive files directory');
    fs.cpSync(files, stage, { recursive: true, filter(file) {
      const st = fs.lstatSync(file);
      if (!st.isFile() && !st.isDirectory()) throw new Error('Unsupported archive entry: ' + file);
      return true;
    } });
    for (const entry of index.files) {
      if (!Array.isArray(entry.path) || !entry.path.length || entry.path.some(part => typeof part !== 'string'
        || !part || part === '.' || part === '..' || part.includes('\0') || part.includes('/') ||
        (process.platform === 'win32' && /[\\:<>|"?*]|[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw new Error('Invalid archive path');
      if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !Array.isArray(entry.blocks)
        || entry.blocks.length !== Math.ceil(entry.bytes / BLOCK)) throw new Error('Invalid archive length');
      const out = path.join(stage, ...entry.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const fd = fs.openSync(out, 'wx', 0o600);
      try {
        let remaining = entry.bytes;
        for (const digest of entry.blocks) {
          if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid archive hash');
          const bytes = readBlock(path.join(objects, digest + '.gz'));
          if (bytes.length !== Math.min(BLOCK, remaining) || hash(bytes) !== digest) throw new Error('Archive integrity check failed');
          fs.writeFileSync(fd, bytes);
          remaining -= bytes.length;
        }
        fs.fchmodSync(fd, entry.mode & 0o777);
      } finally { fs.closeSync(fd); }
    }
    fs.mkdirSync(target); // Atomically reserve a fresh destination before publishing.
    reserved = true;
    fs.renameSync(stage, path.join(target, 'files'));
  } catch (error) {
    if (reserved) fs.rmdirSync(target);
    throw error;
  } finally {
    if (fs.existsSync(stage)) removeSync(stage, { recursive: true, force: true });
  }
}

module.exports = { THRESHOLD, createPacker, restore };
if (require.main === module) {
  if (process.argv.length !== 3) { console.error('Usage: node restore.cjs <new-destination>'); process.exitCode = 1; }
  else {
    try { restore(__dirname, process.argv[2]); console.log('Restored migration files to ' + path.resolve(process.argv[2], 'files')); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
