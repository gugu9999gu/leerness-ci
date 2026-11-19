'use strict';
const crypto = require('node:crypto');

function inertFinding(rule, file, source, offset, match) {
  if (!/\.(?:c?js|mjs|tsx?|jsx)$/i.test(file)) return null;
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = source.indexOf('\n', offset);
  const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
  const declarations = source.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('//'));
  if (rule === 'Generic private key') {
    const marker = /^(?:export\s+)?const\s+\w+\s*=\s*(["'])-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----\1\s*;?$/;
    if (!marker.test(line) || !declarations.every(value => marker.test(value))) return null;
  } else if (rule === 'Hardcoded credential (unquoted)') {
    const reference = /^(?:export\s+)?const\s+\w+\s*=\s*([A-Za-z_]\w*)\s*;?$/.exec(line);
    if (!reference || declarations.length !== 2 || declarations[1] !== line) return null;
    const scalar = /^const\s+([A-Za-z_]\w*)\s*=\s*(?:true|false|null)\s*;?$/.exec(declarations[0]);
    if (!scalar || scalar[1] !== reference[1]) return null;
  } else return null;
  const wholeFile = crypto.createHash('sha256').update(source).digest('hex');
  return crypto.createHash('sha256').update(JSON.stringify([rule, file, wholeFile, offset, match])).digest('hex');
}
function validRecord(record, timestamp = Date.now()) {
  return record && /^[a-f0-9]{64}$/.test(record.findingId) && typeof record.file === 'string' && ['Generic private key', 'Hardcoded credential (unquoted)'].includes(record.rule)
    && typeof record.reason === 'string' && record.reason.trim().length > 0
    && typeof record.approvedBy === 'string' && record.approvedBy.trim().length > 0
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.expiresAt)
    && Date.parse(record.expiresAt) > timestamp;
}
module.exports = { inertFinding, validRecord };
