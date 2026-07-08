#!/usr/bin/env node
// nexis:wiki — Mermaid diagram validator + safe auto-fixer.
//
// astro-mermaid renders diagrams *client-side*, so `astro build` never fails on
// a broken diagram — it silently ships an error box. This script is the gate
// that actually validates them. It extracts every ```mermaid fence from the
// wiki's Markdown and checks each one.
//
// Two validation tiers:
//   • Authoritative — if `mermaid` + `jsdom` resolve from the target project's
//     node_modules (i.e. after `npm install`), each block is run through the
//     real `mermaid.parse()`; a block is invalid iff the parser rejects it.
//   • Structural fallback — before install, a deliberately *narrow*, high-
//     confidence set of checks for the only classes empirically observed to
//     break mermaid.parse() (each verified against the real parser):
//        A. a reserved keyword used as a node/participant id — the sets below
//           are diagram-type-specific and confirmed to actually collide
//           (e.g. `loop` breaks a sequence participant but not a flowchart node)
//        B. unquoted "(" / ")" inside a flowchart node or edge label
//        D. ";" inside sequence message/note text (mermaid ends the statement)
//        E. an HTML character entity in a label (e.g. &#40; for "(") — a *render*
//           defect that mermaid.parse() ACCEPTS but the browser shows literally,
//           so this class is checked structurally in every mode, parser or not.
//     (A "\n" line break parses fine in mermaid v11, so it is NOT flagged — the
//     fallback stays conservative to avoid false positives when it can't parse.)
//
// With --fix it applies the safe, mechanical corrections for those classes.
// When the real parser is available every candidate fix must *parse* before it
// is written (else it is reverted) — so --fix never introduces a worse diagram.
//
// Usage:
//   node mermaid-lint.mjs --root <content_dir> [--project <astro_root>] [--fix] [--json]
//
// Exit code: 0 if every diagram is valid (after any fixes), 1 if any remain
// invalid, 2 on a usage error. stdout ends with a JSON report when --json.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- args -------
const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function val(name, fallback) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : fallback; }

const ROOT = val('--root', null);
const FIX = flag('--fix');
const JSON_OUT = flag('--json');
if (!ROOT) { process.stderr.write('mermaid-lint: --root <content_dir> is required\n'); process.exit(2); }
if (!fs.existsSync(ROOT)) { process.stderr.write(`mermaid-lint: root not found: ${ROOT}\n`); process.exit(2); }
// Default the dependency-resolution root to the content root's project. For a
// Starlight wiki the caller passes --project <output_root>; otherwise we walk up.
const PROJECT = val('--project', ROOT);

// Keywords empirically confirmed to break mermaid.parse() when used as a bare
// identifier — kept per-diagram-type because the collisions differ.
const SEQ_RESERVED = new Set([
  'loop', 'alt', 'opt', 'par', 'and', 'else', 'end', 'note', 'rect', 'actor',
  'box', 'break', 'critical', 'create', 'destroy', 'activate', 'deactivate', 'participant',
]);
const FLOW_RESERVED = new Set([
  'end', 'class', 'graph', 'style', 'subgraph', 'flowchart', 'classdef', 'linkstyle',
]);

// ---------------------------------------------------- real parser (optional) -
async function loadParser(project) {
  try {
    const req = createRequire(path.join(path.resolve(project), '__nexis_resolve__.js'));
    const mermaidUrl = pathToFileURL(req.resolve('mermaid')).href;
    const jsdomUrl = pathToFileURL(req.resolve('jsdom')).href;
    const jsdomMod = await import(jsdomUrl);
    const JSDOM = jsdomMod.JSDOM || (jsdomMod.default && jsdomMod.default.JSDOM);
    if (!JSDOM) return null;
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    try { Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true }); } catch { /* keep existing */ }
    const mermaid = (await import(mermaidUrl)).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
    return async (code) => {
      try { await mermaid.parse(code); return null; }
      catch (e) { return String((e && e.message) || e).split('\n').slice(0, 3).join(' ').trim(); }
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- scan -------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && full.endsWith('.md')) out.push(full);
  }
  return out;
}

// Extract mermaid fences from one file's text → [{ code, fenceLine, bodyStart, bodyEnd }]
// bodyStart/bodyEnd are 0-based line indices of the code (exclusive of fences).
function extract(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```mermaid\s*$/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) j++;
      blocks.push({ fenceLine: i + 1, bodyStart: i + 1, bodyEnd: j, code: lines.slice(i + 1, j).join('\n') });
      i = j;
    }
  }
  return blocks;
}

// Decode HTML character entities that a writer used to "escape" a special char
// (e.g. &#40;/&lpar; for "("). Inside a mermaid label these are NOT decoded by
// the renderer — they show up literally as "migrate&#40;&#41;". The plain char
// is what should be there (labels containing them just need quoting, class B).
// Skips a few chars whose plain form would change the *syntax*: " (34) closes a
// quoted label, ; (59) ends a sequence statement, | (124) is an edge-label delim.
const ENTITY_UNSAFE = new Set([34, 59, 124]);
const ENTITY_NAMED = {
  lpar: '(', rpar: ')', amp: '&', num: '#', colon: ':', lt: '<', gt: '>',
  sol: '/', period: '.', comma: ',', ast: '*', commat: '@', equals: '=',
};
function decodeSafeEntities(s) {
  const codeOk = (n) => n >= 32 && n <= 126 && !ENTITY_UNSAFE.has(n);
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { const n = parseInt(h, 16); return codeOk(n) ? String.fromCharCode(n) : m; })
    .replace(/&#(\d+);/g, (m, d) => { const n = parseInt(d, 10); return codeOk(n) ? String.fromCharCode(n) : m; })
    .replace(/&([a-zA-Z]+);/g, (m, name) => Object.prototype.hasOwnProperty.call(ENTITY_NAMED, name) ? ENTITY_NAMED[name] : m);
}

// ------------------------------------------------- structural detection ------
function diagramType(code) {
  const first = code.split('\n').map(l => l.trim()).find(Boolean) || '';
  if (/^sequenceDiagram\b/.test(first)) return 'sequence';
  if (/^(flowchart|graph)\b/.test(first)) return 'flowchart';
  return 'other';
}

// Returns an array of { class, line, detail } structural issues for a block.
function structuralIssues(code) {
  const type = diagramType(code);
  const lines = code.split('\n');
  const issues = [];
  lines.forEach((raw, idx) => {
    const line = raw;
    const ln = idx + 1;
    // E — HTML character entity that will render literally (parser can't see this)
    if (decodeSafeEntities(line) !== line) {
      issues.push({ class: 'E', line: ln, detail: 'HTML character entity in a label renders literally; use the plain character (quote the label if needed)' });
    }

    if (type === 'flowchart') {
      // B — unquoted parens inside a node label [...]/{...}/(...) or pipe edge label |...|
      for (const m of line.matchAll(/(\[\(|\(\[|\[\[|\(\(|\{\{|\[|\(|\{)([^\]\)\}]*?)(\]\)|\]\]|\)\)|\}\}|\]|\)|\})/g)) {
        const inner = m[2];
        if (/[()]/.test(inner) && !/^\s*"/.test(inner)) {
          issues.push({ class: 'B', line: ln, detail: `unquoted "()" in node label: ${m[0].slice(0, 40)}` });
        }
      }
      for (const m of line.matchAll(/\|([^|]*)\|/g)) {
        if (/[()]/.test(m[1]) && !/^\s*"/.test(m[1])) {
          issues.push({ class: 'B', line: ln, detail: `unquoted "()" in edge label: |${m[1].slice(0, 30)}|` });
        }
      }
      // A — reserved keyword as a node id (identifier immediately before a shape bracket)
      for (const m of line.matchAll(/(^|\s|>|-|\|)([A-Za-z_]\w*)\s*(\[|\(|\{)/g)) {
        if (FLOW_RESERVED.has(m[2].toLowerCase())) issues.push({ class: 'A', line: ln, detail: `reserved word "${m[2]}" used as a node id` });
      }
    }

    if (type === 'sequence') {
      // A — reserved keyword as a participant id
      const p = line.match(/^\s*(?:participant|actor)\s+([A-Za-z_]\w*)\b/);
      if (p && SEQ_RESERVED.has(p[1].toLowerCase())) issues.push({ class: 'A', line: ln, detail: `reserved word "${p[1]}" used as a participant id` });
      // D — ";" inside message/note text (after the first ":")
      const msg = line.match(/:\s*(.*)$/);
      if (msg && /;/.test(msg[1]) && /(->>|-->>|->|-->|-x|--x|-\)|--\))/.test(line)) {
        issues.push({ class: 'D', line: ln, detail: 'contains ";" in message text (mermaid ends the statement there)' });
      }
      if (/^\s*Note\b/i.test(line) && /:\s*[^:]*;/.test(line)) {
        issues.push({ class: 'D', line: ln, detail: 'contains ";" in note text' });
      }
    }
  });
  return issues;
}

// -------------------------------------------------------- safe auto-fix ------
// Applies the class B/D mechanical corrections + class A reserved-id rename.
// `parserAvailable` gates the flowchart node-id rename (a `\bword\b` rewrite
// that is only safe to write blind when the caller re-parses the result).
// Returns the fixed code (may equal input if nothing safe to do).
function autofix(code, parserAvailable) {
  const type = diagramType(code);
  let lines = code.split('\n');

  // E — decode over-escaped HTML entities everywhere first, so the flowchart B
  // pass below then quotes any label whose decoded "()" now needs it.
  lines = lines.map(decodeSafeEntities);

  if (type === 'flowchart') {
    // A — rename reserved node ids (verified by the caller's re-parse)
    if (parserAvailable) {
      const renames = new Map();
      for (const l of lines) {
        for (const m of l.matchAll(/(^|\s|>|-|\|)([A-Za-z_]\w*)\s*(\[|\(|\{)/g)) {
          if (FLOW_RESERVED.has(m[2].toLowerCase()) && !renames.has(m[2])) renames.set(m[2], m[2] + 'Node');
        }
      }
      if (renames.size) lines = lines.map(l => { let s = l; for (const [f, t] of renames) s = s.replace(new RegExp(`\\b${f}\\b`, 'g'), t); return s; });
    }
    lines = lines.map(l => {
      let s = l;
      // B — pipe edge labels
      s = s.replace(/\|([^|]*)\|/g, (full, inner) => {
        if (/[()]/.test(inner) && !/^\s*".*"\s*$/.test(inner)) return `|"${inner.replace(/"/g, '')}"|`;
        return full;
      });
      // B — node labels: quote a label that contains an unquoted "(" or ")".
      // Only quote the *inner* text; never restructure the delimiters (that
      // would turn a cylinder [(x)] into a rectangle). Multi-char shapes are
      // handled first; the single-char passes are lookaround-guarded so they
      // never poach a [[ ]], ([ ]), [( )] or (( )) construct.
      const quote = (open, close) => (full, inner) =>
        (/[()]/.test(inner) && !/^\s*".*"\s*$/.test(inner)) ? `${open}"${inner.replace(/"/g, '')}"${close}` : full;
      // hexagon / subroutine / stadium / cylinder / circle
      s = s.replace(/\{\{([^{}]*?)\}\}/g, quote('{{', '}}'));
      s = s.replace(/\[\[([^\[\]]*?)\]\]/g, quote('[[', ']]'));
      s = s.replace(/\(\[([^\[\]]*?)\]\)/g, quote('([', '])'));
      s = s.replace(/\[\(([^()]*?)\)\]/g, quote('[(', ')]'));
      s = s.replace(/\(\(([^()]*?)\)\)/g, quote('((', '))'));
      // diamond / rectangle / round — guarded so they skip the doubled/combined forms
      s = s.replace(/(?<![\[({])\{(?!\{)([^{}]*?)\}(?!\})/g, quote('{', '}'));
      s = s.replace(/(?<![\[(])\[(?![\[(])([^\[\]]*?)\](?![\])])/g, quote('[', ']'));
      s = s.replace(/(?<![\[(])\((?![([])([^()]*?)\)(?![)\]])/g, quote('(', ')'));
      return s;
    });
  }

  if (type === 'sequence') {
    // A — rename reserved participant ids throughout the block (contained + safe)
    const renames = new Map();
    for (const l of lines) {
      const p = l.match(/^\s*(?:participant|actor)\s+([A-Za-z_]\w*)\b/);
      if (p && SEQ_RESERVED.has(p[1].toLowerCase()) && !renames.has(p[1])) renames.set(p[1], p[1] + 'Node');
    }
    if (renames.size) {
      lines = lines.map(l => {
        let s = l;
        for (const [from, to] of renames) s = s.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
        return s;
      });
    }
    // D — ";" -> "," inside message/note text only (right of the first ":")
    lines = lines.map(l => {
      const isMsg = /(->>|-->>|->|-->|-x|--x|-\)|--\))/.test(l) || /^\s*Note\b/i.test(l);
      if (!isMsg) return l;
      const ci = l.indexOf(':');
      if (ci === -1) return l;
      return l.slice(0, ci + 1) + l.slice(ci + 1).replace(/;/g, ',');
    });
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------- run --------
const parse = await loadParser(PROJECT);
const files = walk(ROOT);
const report = { root: ROOT, parser: parse ? 'mermaid' : 'structural', files: files.length, diagrams: 0, invalid: 0, fixed: 0, remaining: 0, findings: [] };

for (const file of files) {
  let text = fs.readFileSync(file, 'utf8');
  let blocks = extract(text);
  if (!blocks.length) continue;
  let mutated = false;

  // Process bottom-up so line indices stay valid across in-place edits.
  for (let b = blocks.length - 1; b >= 0; b--) {
    const block = blocks[b];
    report.diagrams++;
    const rel = path.relative(ROOT, file);
    const parseErr = parse ? await parse(block.code) : null;
    const structural = structuralIssues(block.code);
    // Class E (entities) is a *render* defect the parser accepts, so it must
    // count as invalid on its own even when parseErr is null.
    const renderOnly = structural.filter(s => s.class === 'E');
    const invalid = (parse ? parseErr !== null : structural.length > 0) || renderOnly.length > 0;
    if (!invalid) continue;
    report.invalid++;

    let status = 'invalid';
    if (FIX) {
      const fixed = autofix(block.code, parse !== null);
      let accept = fixed !== block.code;
      if (accept && parse) accept = (await parse(fixed)) === null; // only write if it now parses
      if (accept) {
        const cur = text.split('\n');
        cur.splice(block.bodyStart, block.bodyEnd - block.bodyStart, ...fixed.split('\n'));
        text = cur.join('\n');
        mutated = true;
        report.fixed++;
        status = 'fixed';
      }
    }
    if (status !== 'fixed') report.remaining++;
    report.findings.push({
      file: rel, line: block.fenceLine, status,
      parseError: parseErr || undefined,
      classes: [...new Set(structural.map(s => s.class))].sort(),
      detail: (parseErr || structural.map(s => `[${s.class}] ${s.detail}`).join('; ')) || 'invalid',
    });
  }

  if (mutated) fs.writeFileSync(file, text);
}

// ---------------------------------------------------------------- output -----
report.findings.reverse();
if (!JSON_OUT || !flag('--quiet')) {
  const via = parse ? 'real mermaid parser' : 'structural checks (install deps for full validation)';
  process.stderr.write(`mermaid-lint: ${report.diagrams} diagram(s) across ${report.files} file(s), validated via ${via}\n`);
  for (const f of report.findings) {
    const tag = f.status === 'fixed' ? 'FIXED ' : 'INVALID';
    process.stderr.write(`  ${tag} ${f.file}:${f.line} — ${f.detail}\n`);
  }
  if (FIX) process.stderr.write(`mermaid-lint: fixed ${report.fixed}, ${report.remaining} still need manual attention\n`);
  else if (report.invalid) process.stderr.write(`mermaid-lint: ${report.invalid} invalid; re-run with --fix to auto-correct the safe ones\n`);
  else process.stderr.write('mermaid-lint: all diagrams valid\n');
}
if (JSON_OUT) process.stdout.write(JSON.stringify(report, null, 2) + '\n');

process.exit(report.remaining > 0 || (!FIX && report.invalid > 0) ? 1 : 0);
