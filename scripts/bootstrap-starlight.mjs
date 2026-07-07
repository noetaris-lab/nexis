#!/usr/bin/env node
// nexis:wiki --target starlight — deterministic Astro Starlight project bootstrap.
//
// Usage:
//   node bootstrap-starlight.mjs --root <path> [--title <string>] [--description <string>]
//
// Copies the bundled template at ../templates/starlight into --root and patches
// the site title/description, but only when --root is empty or missing. Never
// runs npm install — the caller is told to do that itself. Read-only detection,
// then either a full scaffold or no writes at all (no partial states).
//
// stdout is JSON only, so a caller can parse it. Shape:
//   { root, status: "already_bootstrapped" | "scaffolded" | "conflict",
//     content_dir, reason?, title?, description?, files_written? }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : fallback;
}

function fail(msg) {
  process.stdout.write(JSON.stringify({ error: msg }, null, 2) + '\n');
  process.exit(1);
}

const ROOT = argVal('--root', null);
if (!ROOT) fail('--root is required');

const CONTENT_DIR = 'src/content/docs'; // fixed by the bundled template's collection name
const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'starlight');

const TITLE = argVal('--title', path.basename(path.resolve(ROOT)));
const DESCRIPTION = argVal('--description', '');

function emit(obj) {
  process.stdout.write(JSON.stringify({ root: ROOT, content_dir: CONTENT_DIR, ...obj }, null, 2) + '\n');
}

// ---------- detect ----------

const astroConfigPath = ['astro.config.mjs', 'astro.config.ts']
  .map(f => path.join(ROOT, f))
  .find(fs.existsSync);

if (astroConfigPath) {
  const isStarlight = /@astrojs\/starlight/.test(fs.readFileSync(astroConfigPath, 'utf8'));
  if (isStarlight) {
    emit({ status: 'already_bootstrapped' });
  } else {
    emit({ status: 'conflict', reason: `${astroConfigPath} exists but does not configure @astrojs/starlight` });
  }
  process.exit(0);
}

const rootExists = fs.existsSync(ROOT);
const nonHiddenEntries = rootExists
  ? fs.readdirSync(ROOT).filter(e => !e.startsWith('.'))
  : [];

if (nonHiddenEntries.length > 0) {
  emit({
    status: 'conflict',
    reason: `${ROOT} is non-empty (${nonHiddenEntries.slice(0, 5).join(', ')}) but has no astro.config.* — refusing to overwrite`,
  });
  process.exit(0);
}

// ---------- scaffold ----------

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function jsEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function npmName(s) {
  const kebab = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return kebab || 'wiki';
}

const PACKAGE_NAME = npmName(TITLE);

const filesWritten = [];
for (const rel of walk(TEMPLATE_DIR)) {
  const src = path.join(TEMPLATE_DIR, rel);
  const dest = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let text = fs.readFileSync(src, 'utf8');
  if (rel === 'astro.config.mjs') {
    text = text.replace('__SITE_TITLE__', jsEscape(TITLE)).replace('__SITE_DESCRIPTION__', jsEscape(DESCRIPTION));
  } else if (rel === 'package.json') {
    text = text.replace('__PACKAGE_NAME__', PACKAGE_NAME);
  }
  fs.writeFileSync(dest, text);
  filesWritten.push(rel);
}

emit({ status: 'scaffolded', title: TITLE, description: DESCRIPTION, files_written: filesWritten });
