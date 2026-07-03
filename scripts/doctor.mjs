#!/usr/bin/env node
// nexis:doctor — deterministic validator + safe repairer for a .nexis note store.
//
// Usage:
//   node doctor.mjs [--root <dir>] [--fix]
//
// Default (no --fix): read-only. Prints a JSON report of every defect to stdout
//                     and never writes.
// --fix:              additionally applies SAFE Tier-1/2 repairs in place
//                     (back-link symmetry, status/superseded_by consistency,
//                     tag normalization, index reconcile) and lists them under
//                     "fixes_applied". Never deletes notes, never edits bodies,
//                     never touches Tier-3 (semantic) candidates.
//
// stdout is JSON only, so a caller can parse it. Shape:
//   { root, counts, structural[], graph[], index[], propagation_candidates[],
//     fixes_applied[] }

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const APPLY = args.includes('--fix');
const rootIdx = args.indexOf('--root');
const NEXIS = rootIdx !== -1 ? args[rootIdx + 1] : '.nexis';
const NOTES_DIR = path.join(NEXIS, 'notes');
const INDEX = path.join(NEXIS, 'index.md');

const TYPES = new Set(['concept', 'entity', 'decision', 'problem']);
const STATUSES = new Set(['active', 'superseded', 'archived']);
const RELS = new Set([
  'supersedes', 'superseded_by', 'extends', 'relates_to', 'contradicts',
  'depends-on', 'implements', 'motivated-by', 'decided-by', 'part-of',
]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const structural = []; // schema / per-note defects
const graph = [];       // cross-note referential defects
const indexDefects = []; // index <-> notes drift
const fixes = [];       // applied repairs (only under --fix)

function fail(msg) {
  process.stdout.write(JSON.stringify({ error: msg }, null, 2) + '\n');
  process.exit(1);
}

// ---------- frontmatter parsing (tailored to the nexis note shape) ----------

function splitRaw(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  return { fm: m[1], rest: raw.slice(m[0].length) };
}

function stripQuotes(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function parseFrontmatter(fm) {
  const lines = fm.split('\n');
  const obj = { links: [], _missing: [] };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.startsWith(' ') || line.startsWith('\t')) { i++; continue; }
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const val = m[2];
    if (key === 'links') {
      i++;
      const links = [];
      let cur = null;
      while (i < lines.length &&
             (lines[i].startsWith(' ') || lines[i].startsWith('\t') || !lines[i].trim())) {
        const l = lines[i];
        if (!l.trim()) { i++; continue; }
        const item = l.match(/^\s*-\s*(\w[\w-]*):\s*(.*)$/);
        if (item) {
          if (cur) links.push(cur);
          cur = {};
          cur[item[1]] = stripQuotes(item[2]);
        } else {
          const kv = l.match(/^\s*(\w[\w-]*):\s*(.*)$/);
          if (kv && cur) cur[kv[1]] = stripQuotes(kv[2]);
        }
        i++;
      }
      if (cur) links.push(cur);
      obj.links = links;
      continue;
    } else if (key === 'tags') {
      const t = val.trim();
      obj.tags = t.startsWith('[')
        ? t.replace(/^\[/, '').replace(/\]$/, '').split(',').map(s => stripQuotes(s)).filter(Boolean)
        : [];
      obj._tagsInline = t.startsWith('[');
    } else {
      obj[key] = stripQuotes(val);
    }
    i++;
  }
  return obj;
}

// ---------- targeted frontmatter edits (safe repair) ----------

function setScalar(fmLines, key, value) {
  for (let i = 0; i < fmLines.length; i++) {
    if (!fmLines[i].startsWith(' ') && new RegExp(`^${key}:\\s`).test(fmLines[i])) {
      fmLines[i] = `${key}: ${value}`;
      return;
    }
  }
  const at = fmLines.findIndex(l => /^created:\s/.test(l));
  fmLines.splice(at === -1 ? fmLines.length : at, 0, `${key}: ${value}`);
}

function addLink(fmLines, id, rel) {
  let li = fmLines.findIndex(l => /^links:/.test(l));
  const entry = [`  - id: ${id}`, `    rel: ${rel}`];
  if (li === -1) {
    const at = fmLines.findIndex(l => /^created:\s/.test(l));
    fmLines.splice(at === -1 ? fmLines.length : at, 0, 'links:', ...entry);
    return;
  }
  if (/^links:\s*\[\s*\]\s*$/.test(fmLines[li])) fmLines[li] = 'links:';
  let end = li + 1;
  while (end < fmLines.length &&
         (fmLines[end].startsWith(' ') || fmLines[end].startsWith('\t') || !fmLines[end].trim())) end++;
  fmLines.splice(end, 0, ...entry);
}

function writeNoteEdits(note, edits) {
  const { fm, rest } = splitRaw(note.raw);
  const fmLines = fm.split('\n');
  for (const e of edits) {
    if (e.op === 'setScalar') setScalar(fmLines, e.key, e.value);
    else if (e.op === 'addLink') addLink(fmLines, e.id, e.rel);
  }
  const out = '---\n' + fmLines.join('\n') + '\n---\n' + rest;
  fs.writeFileSync(note.file, out);
  note.raw = out;
  note.fm = parseFrontmatter(fmLines.join('\n')); // refresh so index reconcile sees the fixes
}

// ---------- load ----------

if (!fs.existsSync(NOTES_DIR)) fail(`notes directory not found: ${NOTES_DIR}`);

const notes = [];
const byId = new Map();
const idCollisions = [];

for (const fname of fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md')).sort()) {
  const file = path.join(NOTES_DIR, fname);
  const raw = fs.readFileSync(file, 'utf8');
  const split = splitRaw(raw);
  if (!split) {
    structural.push({ severity: 'error', code: 'no-frontmatter', file, message: 'file has no parseable YAML frontmatter' });
    continue;
  }
  const fm = parseFrontmatter(split.fm);
  const note = { file, fname, raw, fm };
  notes.push(note);
  if (fm.id) {
    if (byId.has(fm.id)) idCollisions.push(fm.id);
    else byId.set(fm.id, note);
  }
}

// ---------- Tier 1: per-note schema ----------

for (const n of notes) {
  const { fm, file, fname } = n;
  const req = ['id', 'title', 'type', 'status', 'created', 'updated'];
  for (const k of req) {
    if (!fm[k]) structural.push({ severity: 'error', code: 'missing-field', file, field: k, message: `missing required field "${k}"` });
  }
  if (fm.id && fname !== `${fm.id}.md`) {
    structural.push({ severity: 'error', code: 'id-filename-mismatch', file, message: `id "${fm.id}" does not match filename "${fname}"` });
  }
  if (fm.type && !TYPES.has(fm.type)) {
    structural.push({ severity: 'error', code: 'bad-type', file, message: `type "${fm.type}" not in vocabulary` });
  }
  if (fm.status && !STATUSES.has(fm.status)) {
    structural.push({ severity: 'error', code: 'bad-status', file, message: `status "${fm.status}" not in vocabulary` });
  }
  if (!fm.tags || fm.tags.length < 2 || fm.tags.length > 5) {
    structural.push({ severity: 'warn', code: 'tag-count', file, message: `tags count ${fm.tags ? fm.tags.length : 0} outside 2–5` });
  }
  const badTags = (fm.tags || []).filter(t => t !== t.toLowerCase() || t.startsWith('#'));
  if (badTags.length) {
    const fixed = fm.tags.map(t => t.replace(/^#/, '').toLowerCase());
    const fix = { op: 'setScalar', key: 'tags', value: `[${fixed.join(', ')}]` };
    structural.push({ severity: 'warn', code: 'tag-format', file, message: `tags not normalized: ${badTags.join(', ')}`, fixable: true });
    (n.edits ||= []).push(fix);
  }
  for (const k of ['created', 'updated']) {
    if (fm[k] && !ISO.test(fm[k])) structural.push({ severity: 'error', code: 'bad-timestamp', file, field: k, message: `${k} "${fm[k]}" is not ISO8601` });
  }
  if (fm.created && fm.updated && ISO.test(fm.created) && ISO.test(fm.updated) && fm.updated < fm.created) {
    structural.push({ severity: 'error', code: 'updated-before-created', file, message: `updated (${fm.updated}) precedes created (${fm.created})` });
  }
}

for (const id of new Set(idCollisions)) {
  graph.push({ severity: 'error', code: 'duplicate-id', id, message: `id "${id}" is used by more than one note file` });
}

// ---------- Tier 2: link + graph integrity ----------

function hasLink(note, id, rel) {
  return note.fm.links.some(l => l.id === id && l.rel === rel);
}

for (const n of notes) {
  for (const lk of n.fm.links) {
    if (!lk.rel || !RELS.has(lk.rel)) {
      graph.push({ severity: 'error', code: 'bad-rel', file: n.file, message: `link rel "${lk.rel}" not in vocabulary` });
    }
    if (!lk.id) { graph.push({ severity: 'error', code: 'link-no-id', file: n.file, message: `link with rel "${lk.rel}" has no id` }); continue; }
    if (lk.id === n.fm.id) { graph.push({ severity: 'error', code: 'self-link', file: n.file, message: `note links to itself` }); continue; }
    const target = byId.get(lk.id);
    if (!target) { graph.push({ severity: 'error', code: 'dangling-link', file: n.file, message: `link target "${lk.id}" (rel ${lk.rel}) does not exist` }); continue; }
    if (lk.rel === 'decided-by' && target.fm.type !== 'decision') {
      graph.push({ severity: 'error', code: 'decided-by-target', file: n.file, message: `decided-by target "${lk.id}" is type ${target.fm.type}, expected decision` });
    }
    if (lk.rel === 'motivated-by' && !['decision', 'problem'].includes(target.fm.type)) {
      graph.push({ severity: 'error', code: 'motivated-by-target', file: n.file, message: `motivated-by target "${lk.id}" is type ${target.fm.type}, expected decision|problem` });
    }
  }
}

// supersede symmetry + status consistency
for (const A of notes) {
  for (const lk of A.fm.links.filter(l => l.rel === 'supersedes')) {
    const B = byId.get(lk.id);
    if (!B) continue; // already reported as dangling
    if (!hasLink(B, A.fm.id, 'superseded_by')) {
      graph.push({ severity: 'error', code: 'missing-backlink', file: B.file, message: `${B.fm.id} is superseded by ${A.fm.id} but lacks a superseded_by back-link`, fixable: true });
      (B.edits ||= []).push({ op: 'addLink', id: A.fm.id, rel: 'superseded_by' });
    }
    if (B.fm.status === 'active') {
      graph.push({ severity: 'error', code: 'superseded-still-active', file: B.file, message: `${B.fm.id} is superseded by ${A.fm.id} but status is active`, fixable: true });
      (B.edits ||= []).push({ op: 'setScalar', key: 'status', value: 'superseded' });
    }
  }
}
for (const B of notes) {
  for (const lk of B.fm.links.filter(l => l.rel === 'superseded_by')) {
    const A = byId.get(lk.id);
    if (!A) continue;
    if (!hasLink(A, B.fm.id, 'supersedes')) {
      graph.push({ severity: 'error', code: 'missing-supersedes', file: A.file, message: `${B.fm.id} claims superseded_by ${A.fm.id} but ${A.fm.id} lacks a supersedes link`, fixable: true });
      (A.edits ||= []).push({ op: 'addLink', id: B.fm.id, rel: 'supersedes' });
    }
  }
  if (B.fm.status === 'superseded' && !B.fm.links.some(l => l.rel === 'superseded_by')) {
    graph.push({ severity: 'warn', code: 'orphan-superseded', file: B.file, message: `${B.fm.id} status is superseded but has no superseded_by link` });
  }
  if (B.fm.status === 'active' && B.fm.links.some(l => l.rel === 'superseded_by')) {
    graph.push({ severity: 'error', code: 'active-with-superseded-by', file: B.file, message: `${B.fm.id} is active but carries a superseded_by link`, fixable: true });
    (B.edits ||= []).push({ op: 'setScalar', key: 'status', value: 'superseded' });
  }
}

// supersede cycle detection
{
  const succ = new Map();
  for (const n of notes) {
    for (const lk of n.fm.links.filter(l => l.rel === 'supersedes')) {
      if (byId.has(lk.id)) (succ.get(n.fm.id) || succ.set(n.fm.id, []).get(n.fm.id)).push(lk.id);
    }
  }
  const state = new Map(); // 0=visiting 1=done
  const inCycle = new Set();
  function dfs(id, stack) {
    state.set(id, 0);
    for (const nx of succ.get(id) || []) {
      if (state.get(nx) === 0) { for (const s of stack.slice(stack.indexOf(nx))) inCycle.add(s); inCycle.add(nx); }
      else if (state.get(nx) === undefined) dfs(nx, [...stack, nx]);
    }
    state.set(id, 1);
  }
  for (const id of succ.keys()) if (state.get(id) === undefined) dfs(id, [id]);
  if (inCycle.size) graph.push({ severity: 'error', code: 'supersede-cycle', ids: [...inCycle], message: `supersede links form a cycle: ${[...inCycle].join(' -> ')}` });
}

// ---------- Tier 3 candidate filter: supersession-propagation debt ----------
// Deterministic PRE-FILTER only. A note B is "overridden" if something supersedes
// it — determined from the link GRAPH, not B's status field, so this still fires
// when the status flag is itself wrong. For each overridden B, list active
// referrers whose `updated` predates the override — i.e. notes that link to B and
// were never revised after B was superseded. The skill (model) judges whether each
// candidate's content is actually stale; the script never edits them.
const overriders = new Map(); // B-id -> [{ id, at }]
for (const A of notes) {
  for (const lk of A.fm.links.filter(l => l.rel === 'supersedes')) {
    if (byId.has(lk.id)) (overriders.get(lk.id) || overriders.set(lk.id, []).get(lk.id)).push({ id: A.fm.id, at: A.fm.created || A.fm.updated });
  }
}
for (const B of notes) {
  for (const lk of B.fm.links.filter(l => l.rel === 'superseded_by')) {
    const A = byId.get(lk.id);
    if (A && !(overriders.get(B.fm.id) || []).some(o => o.id === A.fm.id)) {
      (overriders.get(B.fm.id) || overriders.set(B.fm.id, []).get(B.fm.id)).push({ id: A.fm.id, at: A.fm.created || A.fm.updated });
    }
  }
}

const propagation = [];
for (const [bId, ovs] of overriders) {
  const supersededAt = ovs.map(o => o.at).filter(Boolean).sort()[0]; // earliest override
  for (const C of notes) {
    if (C.fm.status !== 'active') continue;
    if (C.fm.id === bId) continue;
    const link = C.fm.links.find(l => l.id === bId);
    if (!link) continue;
    if (link.rel === 'superseded_by' || link.rel === 'supersedes') continue; // supersede chain itself
    const stale = !supersededAt || !C.fm.updated || C.fm.updated < supersededAt;
    if (stale) {
      propagation.push({
        referrer: C.fm.id, referrer_file: C.file, rel: link.rel,
        superseded: bId, superseded_by: ovs.map(o => o.id), superseded_at: supersededAt,
        referrer_updated: C.fm.updated,
      });
    }
  }
}

// ---------- index reconcile ----------

let indexFront = '';
let indexRows = new Map(); // id -> { title, type, tags, status, summary }
if (fs.existsSync(INDEX)) {
  const raw = fs.readFileSync(INDEX, 'utf8');
  const fmm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  indexFront = fmm ? fmm[1] : '';
  for (const line of raw.split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    // table rows look like: | id | title | type | tags | status | summary |
    if (cells.length >= 7 && cells[1] && cells[1] !== 'id' && !/^-+$/.test(cells[1])) {
      indexRows.set(cells[1], { title: cells[2], type: cells[3], tags: cells[4], status: cells[5], summary: cells[6] });
    }
  }
} else {
  indexDefects.push({ severity: 'error', code: 'no-index', message: `${INDEX} does not exist` });
}

// Per-row checks only make sense when an index exists; the no-index defect
// already covers a wholly missing index (which doctor won't auto-create, since
// summaries live only in the index and cannot be recovered from notes).
if (fs.existsSync(INDEX)) {
  for (const n of notes) {
    const row = indexRows.get(n.fm.id);
    if (!row) { indexDefects.push({ severity: 'error', code: 'missing-index-row', id: n.fm.id, message: `note ${n.fm.id} has no index row`, fixable: true }); continue; }
    const tagStr = (n.fm.tags || []).join(',');
    if (row.type !== n.fm.type || row.status !== n.fm.status || row.title !== (n.fm.title || '') || row.tags !== tagStr) {
      indexDefects.push({ severity: 'warn', code: 'index-drift', id: n.fm.id, message: `index row for ${n.fm.id} disagrees with note frontmatter`, fixable: true });
    }
  }
  for (const id of indexRows.keys()) {
    if (!byId.has(id)) indexDefects.push({ severity: 'error', code: 'orphan-index-row', id, message: `index row ${id} has no note file`, fixable: true });
  }
}

function reconcileIndex() {
  const ordered = [...notes].sort((a, b) => (a.fm.created || '').localeCompare(b.fm.created || '') || a.fm.id.localeCompare(b.fm.id));
  const header = '| id | title | type | tags | status | summary |\n|----|-------|------|------|--------|---------|';
  const rows = ordered.map(n => {
    const prev = indexRows.get(n.fm.id);
    const summary = prev ? prev.summary : '';
    return `| ${n.fm.id} | ${n.fm.title || ''} | ${n.fm.type || ''} | ${(n.fm.tags || []).join(',')} | ${n.fm.status || ''} | ${summary} |`;
  });
  const front = indexFront ? `---\n${indexFront}\n---\n\n` : '';
  fs.writeFileSync(INDEX, front + header + '\n' + rows.join('\n') + '\n');
}

// ---------- apply safe fixes ----------

if (APPLY) {
  for (const n of notes) {
    if (n.edits && n.edits.length) {
      writeNoteEdits(n, n.edits);
      fixes.push({ file: n.file, applied: n.edits.map(e => e.op === 'setScalar' ? `set ${e.key}` : `add ${e.rel} link -> ${e.id}`) });
    }
  }
  if (fs.existsSync(INDEX) && indexDefects.some(d => d.fixable)) {
    reconcileIndex();
    fixes.push({ file: INDEX, applied: ['reconciled index rows (summaries preserved)'] });
  }
}

// ---------- report ----------

const all = [...structural, ...graph, ...indexDefects];
const report = {
  root: NEXIS,
  applied_fixes: APPLY,
  counts: {
    notes: notes.length,
    errors: all.filter(d => d.severity === 'error').length,
    warnings: all.filter(d => d.severity === 'warn').length,
    fixable: all.filter(d => d.fixable).length,
    propagation_candidates: propagation.length,
  },
  structural,
  graph,
  index: indexDefects,
  propagation_candidates: propagation,
  fixes_applied: fixes,
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
