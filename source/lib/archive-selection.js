'use strict';
const { readArchiveEntries, readArchiveCheck, withoutArchiveCheck, archiveCheckLine } = require('./memory-archive');
const { _dropHeader } = require('./pure-utils');

function selectArchiveEntry(surface, blocks, target) {
  const matches = [];
  for (const block of blocks) {
    const header = _dropHeader(block);
    if (!header) continue;
    const clean = withoutArchiveCheck(block);
    const lines = clean.split('\n');
    const parts = lines.slice(1).join('\n').split(/(?=^### )/m);
    const entries = [];
    for (const [index, part] of parts.entries()) {
      if (!part.startsWith('### ')) continue;
      if (surface === 'plan') {
        const heading = part.split('\n', 1)[0].slice(4).trim();
        const milestone = /^(M-\d+)\.\s*(.+)$/.exec(heading);
        entries.push({ index, keys: milestone ? milestone.slice(1) : [heading] });
      } else {
        const { entries: parsed, damaged } = readArchiveEntries(surface, part);
        if (damaged || parsed.length !== 1) continue;
        const entry = parsed[0];
        entries.push({ index, keys: [entry.id, surface === 'decisions' ? entry.title : entry.text] });
      }
    }
    const hits = entries.filter(entry => entry.keys.includes(target));
    if (!hits.length && header.target === target && !entries.length) return { error: 'archive_entry_invalid' };
    for (const hit of hits) matches.push({ block, parts, entries, hit });
  }
  if (matches.length !== 1) return { error: matches.length ? 'ambiguous_target' : 'archive_entry_not_found' };
  const { block, parts, entries, hit } = matches[0];
  if (entries.length === 1 || surface === 'plan') {
    if (entries.length !== 1) return { error: 'archive_entry_invalid' };
    return { original: block, selected: block };
  }
  const check = readArchiveCheck(block);
  const all = readArchiveEntries(surface, parts.join(''));
  if (all.damaged || all.entries.length !== entries.length || ['changed', 'malformed'].includes(check.state)
    || (check.state === 'ok' && check.count !== entries.length)) return { error: 'archive_changed' };
  const header = block.slice(0, block.indexOf('\n') + 1);
  const selected = parts[hit.index];
  const remaining = parts.filter((_, index) => index !== hit.index).join('');
  const render = (data, count) => header + (check.state === 'ok' ? archiveCheckLine(count, data) : '') + data;
  return { original: block, selected: render(selected, 1), remainder: render(remaining, entries.length - 1) };
}

module.exports = { selectArchiveEntry };
