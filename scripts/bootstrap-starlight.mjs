#!/usr/bin/env node
// nexis:wiki --target starlight — deterministic Astro Starlight project bootstrap.
//
// Usage (scaffold / detect):
//   node bootstrap-starlight.mjs --root <path> [--title <string>] [--description <string>]
//       [--default-locale-code <code>] [--default-locale-label <string>]
//
// Usage (register an additional locale on an existing project):
//   node bootstrap-starlight.mjs --root <path> --add-locale <code> --add-locale-label <string>
//
// Copies the bundled template at ../templates/starlight into --root and patches
// the site title/description/default-locale, but only when --root is empty or
// missing. Never runs npm install — the caller is told to do that itself.
// Read-only detection, then either a full scaffold or no writes at all (no
// partial states).
//
// --add-locale registers an additional locale on an *existing* bootstrapped
// project by rewriting the machine-owned nexis-locales.mjs (or, one time only,
// retrofitting i18n support into a pre-existing astro.config.mjs that predates
// this feature). Idempotent — adding an already-registered locale is a no-op.
//
// stdout is JSON only, so a caller can parse it. Shape:
//   { root, status: "already_bootstrapped" | "scaffolded" | "conflict"
//       | "locale_added" | "already_registered",
//     content_dir, reason?, title?, description?, files_written?, code?, label? }

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
const DEFAULT_LOCALE_CODE = argVal('--default-locale-code', 'en');
const DEFAULT_LOCALE_LABEL = argVal('--default-locale-label', 'English');

function emit(obj) {
  process.stdout.write(JSON.stringify({ root: ROOT, content_dir: CONTENT_DIR, ...obj }, null, 2) + '\n');
}

function jsEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ---------- add-locale mode ----------
// Registers a locale on an already-bootstrapped project. Separate from the
// scaffold/detect flow below since it never creates a project, only mutates
// an existing one.

const ADD_LOCALE = argVal('--add-locale', null);
if (ADD_LOCALE) {
  if (ADD_LOCALE === 'root') fail("'root' is reserved for the default locale");
  const ADD_LOCALE_LABEL = argVal('--add-locale-label', null);
  if (!ADD_LOCALE_LABEL) fail('--add-locale-label is required with --add-locale');
  addLocale(ADD_LOCALE, ADD_LOCALE_LABEL);
  process.exit(0);
}

function addLocale(code, label) {
  const astroConfigPath = ['astro.config.mjs', 'astro.config.ts']
    .map(f => path.join(ROOT, f))
    .find(fs.existsSync);

  if (!astroConfigPath) {
    emit({ status: 'conflict', reason: `no astro.config.mjs/.ts found under ${ROOT} — run the base bootstrap first` });
    return;
  }

  let configText = fs.readFileSync(astroConfigPath, 'utf8');
  if (!/@astrojs\/starlight/.test(configText)) {
    emit({ status: 'conflict', reason: `${astroConfigPath} exists but does not configure @astrojs/starlight` });
    return;
  }

  const localesPath = path.join(ROOT, 'nexis-locales.mjs');

  if (!fs.existsSync(localesPath)) {
    // One-time retrofit: this project was bootstrapped before i18n support
    // existed. Wire nexis-locales.mjs into astro.config.mjs via two anchors
    // already guaranteed present by the @astrojs/starlight check above.
    const importAnchor = /^import starlight from ['"]@astrojs\/starlight['"];[ \t]*$/m;
    const starlightCallAnchor = /^(\s*)starlight\(\{[ \t]*$/m;

    if (!importAnchor.test(configText) || !starlightCallAnchor.test(configText)) {
      emit({
        status: 'conflict',
        reason: `${astroConfigPath} does not match the expected nexis-bootstrapped shape (missing starlight import or "starlight({" call) — cannot safely retrofit i18n; manual setup required`,
      });
      return;
    }

    configText = configText.replace(importAnchor, m => `${m}\nimport { defaultLocale, locales } from './nexis-locales.mjs';`);
    configText = configText.replace(starlightCallAnchor, (m, indent) => `${m}\n${indent}  defaultLocale,\n${indent}  locales,`);
    fs.writeFileSync(astroConfigPath, configText);

    const localesTemplate = fs.readFileSync(path.join(TEMPLATE_DIR, 'nexis-locales.mjs'), 'utf8');
    const seeded = localesTemplate
      .replace('__DEFAULT_LOCALE_LABEL__', jsEscape(DEFAULT_LOCALE_LABEL))
      .replace('__DEFAULT_LOCALE_CODE__', DEFAULT_LOCALE_CODE)
      .replace(/^(export const locales = \{)[ \t]*$/m, m => `${m}\n  ${code}: { label: '${jsEscape(label)}', lang: '${code}' },`);
    fs.writeFileSync(localesPath, seeded);

    emit({ status: 'locale_added', code, label, content_dir: `${CONTENT_DIR}/${code}` });
    return;
  }

  const localesText = fs.readFileSync(localesPath, 'utf8');
  const codeKeyPattern = new RegExp(`^\\s*${code}\\s*:\\s*\\{`, 'm');
  if (codeKeyPattern.test(localesText)) {
    emit({ status: 'already_registered', code, label, content_dir: `${CONTENT_DIR}/${code}` });
    return;
  }

  const localesOpenAnchor = /^(export const locales = \{)[ \t]*$/m;
  if (!localesOpenAnchor.test(localesText)) {
    emit({ status: 'conflict', reason: `${localesPath} does not match the expected nexis-owned shape — cannot safely add a locale; manual setup required` });
    return;
  }
  const updated = localesText.replace(localesOpenAnchor, m => `${m}\n  ${code}: { label: '${jsEscape(label)}', lang: '${code}' },`);
  fs.writeFileSync(localesPath, updated);

  emit({ status: 'locale_added', code, label, content_dir: `${CONTENT_DIR}/${code}` });
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
  } else if (rel === 'nexis-locales.mjs') {
    text = text.replace('__DEFAULT_LOCALE_LABEL__', jsEscape(DEFAULT_LOCALE_LABEL)).replace('__DEFAULT_LOCALE_CODE__', DEFAULT_LOCALE_CODE);
  }
  fs.writeFileSync(dest, text);
  filesWritten.push(rel);
}

emit({ status: 'scaffolded', title: TITLE, description: DESCRIPTION, files_written: filesWritten });
