#!/usr/bin/env node
// nexis:wiki-translate — internal link validator + safe locale-prefix fixer.
//
// A translated locale's pages live at src/content/docs/<lang>/... but a page
// authored with a site-absolute internal link (e.g. `/foundation/core`) keeps
// pointing at the *default*-locale route unless that link is rewritten to
// `/<lang>/foundation/core`. wiki-translate-page.md deliberately leaves link
// targets untouched (only link *text* is a translation concern) — this script
// is the mechanical gate that does the locale-prefix rewrite afterward, and
// also catches links that don't resolve to any known page at all.
//
// It only ever rewrites the missing-prefix case (100% mechanical, always
// safe). Everything else — a link already prefixed but pointing nowhere, a
// link into a different locale, a link to a route that doesn't exist in the
// default locale either — is reported, never guessed at, since a script
// cannot know the intended correct target.
//
// Usage:
//   node link-lint.mjs --content-root <content_dir> --locales-file <path/to/nexis-locales.mjs> --lang <code> [--fix] [--json]
//
// Exit code: 0 if nothing remains flagged (after any fix), 1 if findings
// remain, 2 on a usage error. stdout ends with a JSON report when --json.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- args -------
const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function val(name, fallback) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : fallback; }

const CONTENT_ROOT = val('--content-root', null);
const LOCALES_FILE = val('--locales-file', null);
const LANG = val('--lang', null);
const FIX = flag('--fix');
const JSON_OUT = flag('--json');

if (!CONTENT_ROOT || !LOCALES_FILE || !LANG) {
  process.stderr.write('link-lint: --content-root <dir>, --locales-file <path>, and --lang <code> are all required\n');
  process.exit(2);
}
if (!fs.existsSync(CONTENT_ROOT)) { process.stderr.write(`link-lint: content root not found: ${CONTENT_ROOT}\n`); process.exit(2); }
if (!fs.existsSync(LOCALES_FILE)) { process.stderr.write(`link-lint: locales file not found: ${LOCALES_FILE}\n`); process.exit(2); }

const ASSET_EXT = /\.(svg|png|jpe?g|gif|ico|webp|css|js|mjs|json|txt|pdf|woff2?|ttf|eot)$/i;

// ---------------------------------------------------------------- scan -------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && /\.mdx?$/.test(e.name)) out.push(full);
  }
  return out;
}

// route (no leading/trailing slash, '' = home) for a file relative to some root
function routeFor(relPath) {
  let r = relPath.split(path.sep).join('/').replace(/\.mdx?$/, '');
  r = r.replace(/(^|\/)index$/, '').replace(/\/$/, '');
  return r;
}

const localesUrl = pathToFileURL(path.resolve(LOCALES_FILE)).href;
const { locales } = await import(localesUrl);
const localeCodes = new Set(Object.keys(locales || {}).filter(c => c !== 'root'));
if (!localeCodes.has(LANG)) localeCodes.add(LANG); // tolerate a lang not yet registered

// Known base (default-locale) routes: everything under content root except
// the registered locale subtrees.
const baseFiles = [];
for (const e of fs.readdirSync(CONTENT_ROOT, { withFileTypes: true })) {
  if (e.isDirectory() && localeCodes.has(e.name)) continue;
  const full = path.join(CONTENT_ROOT, e.name);
  if (e.isDirectory()) walk(full, baseFiles);
  else if (e.isFile() && /\.mdx?$/.test(e.name)) baseFiles.push(full);
}
const knownRoutes = new Set(baseFiles.map(f => routeFor(path.relative(CONTENT_ROOT, f))));

const localeRoot = path.join(CONTENT_ROOT, LANG);
const targetFiles = fs.existsSync(localeRoot) ? walk(localeRoot) : [];

// ------------------------------------------------------------- link scan -----
// Matches `[text](target)` and `![alt](target)`, optionally with a trailing
// "title" — target is captured up to the first unescaped ')' or whitespace.
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;

function classify(rawTarget) {
  if (!rawTarget) return { kind: 'skip' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget) || rawTarget.startsWith('//')) return { kind: 'skip' }; // external / mailto / protocol-relative
  if (rawTarget.startsWith('#')) return { kind: 'skip' }; // same-page anchor
  if (!rawTarget.startsWith('/')) return { kind: 'skip' }; // relative link — self-adjusts under the mirrored subtree

  const hashIdx = rawTarget.indexOf('#');
  const basePath = hashIdx === -1 ? rawTarget : rawTarget.slice(0, hashIdx);
  const suffix = hashIdx === -1 ? '' : rawTarget.slice(hashIdx);
  if (ASSET_EXT.test(basePath)) return { kind: 'skip' }; // static asset, not a wiki page route

  const segments = basePath.split('/').filter(Boolean);
  const first = segments[0];

  if (first && localeCodes.has(first)) {
    const rest = segments.slice(1).join('/');
    if (first !== LANG) return { kind: 'cross-locale', basePath, suffix };
    return knownRoutes.has(rest) ? { kind: 'ok' } : { kind: 'broken-prefixed', basePath, suffix };
  }

  const rest = segments.join('/');
  if (knownRoutes.has(rest)) return { kind: 'missing-prefix', basePath, suffix };
  return { kind: 'broken', basePath, suffix };
}

// ---------------------------------------------------------------- run --------
const report = {
  contentRoot: CONTENT_ROOT, lang: LANG, files: targetFiles.length,
  links: 0, fixed: 0, remaining: 0, findings: [],
};

for (const file of targetFiles) {
  const rel = path.relative(CONTENT_ROOT, file);
  let text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  let mutated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let newLine = line;
    let offset = 0;
    for (const m of line.matchAll(LINK_RE)) {
      const [full, linkText, rawTarget, titleSuffix] = m;
      report.links++;
      const c = classify(rawTarget);
      if (c.kind === 'skip' || c.kind === 'ok') continue;

      if (c.kind === 'missing-prefix' && FIX) {
        const fixedTarget = `/${LANG}${c.basePath}${c.suffix}`;
        const fixedFull = `[${linkText}](${fixedTarget}${titleSuffix || ''})`;
        const idx = newLine.indexOf(full, offset);
        newLine = newLine.slice(0, idx) + fixedFull + newLine.slice(idx + full.length);
        offset = idx + fixedFull.length;
        mutated = true;
        report.fixed++;
        report.findings.push({ file: rel, line: i + 1, status: 'fixed', target: rawTarget, fixedTo: fixedTarget, reason: 'missing locale prefix' });
        continue;
      }

      report.remaining++;
      const reason = {
        'missing-prefix': 'missing locale prefix (rerun with --fix)',
        'broken-prefixed': `already prefixed with /${LANG}/ but the target route does not exist`,
        'cross-locale': 'points into a different locale than the one being validated',
        broken: 'target route does not exist in the base wiki — likely a pre-existing base-wiki link defect, not introduced by translation',
      }[c.kind] || 'invalid link';
      report.findings.push({ file: rel, line: i + 1, status: 'flagged', target: rawTarget, reason });
    }
    lines[i] = newLine;
  }

  if (mutated) fs.writeFileSync(file, lines.join('\n'));
}

// ---------------------------------------------------------------- output -----
if (!JSON_OUT || !flag('--quiet')) {
  process.stderr.write(`link-lint: ${report.links} link(s) checked across ${report.files} file(s) under ${LANG}/\n`);
  for (const f of report.findings) {
    const tag = f.status === 'fixed' ? 'FIXED  ' : 'FLAGGED';
    const extra = f.fixedTo ? ` -> ${f.fixedTo}` : '';
    process.stderr.write(`  ${tag} ${f.file}:${f.line} — ${f.target}${extra} (${f.reason})\n`);
  }
  if (FIX) process.stderr.write(`link-lint: fixed ${report.fixed}, ${report.remaining} flagged for manual review\n`);
  else process.stderr.write(`link-lint: ${report.remaining + report.fixed} finding(s); re-run with --fix to auto-correct missing-prefix links\n`);
}
if (JSON_OUT) process.stdout.write(JSON.stringify(report, null, 2) + '\n');

process.exit(report.remaining > 0 ? 1 : 0);
