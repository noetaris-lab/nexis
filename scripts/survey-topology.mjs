#!/usr/bin/env node
// nexis:survey topology — deterministic git introspection for /nexis:survey.
//
// Usage:
//   node survey-topology.mjs [--root <dir>] [--manifest <path>] [--max-depth <n>]
//
// Read-only, no model involvement (same category as doctor.mjs). Emits one
// JSON object to stdout describing the git topology of the workspace and,
// when a prior survey.manifest.md is given, a diff against it — so
// /nexis:survey's mode detection (Build / Resume / Re-survey / refuse) never
// has to construct a git command itself; it only reads this report.
//
// Shape:
//   { git_available, legacy_manifest, any_repo_found,
//     repos: [{ repo_path, branch, detached, commit, dirty, status,
//               manifest_branch?, manifest_commit?, changed_files? }] }
//
// status (per repo, only meaningful when a manifest was given):
//   new | removed | unchanged | changed | branch_mismatch | dirty | history_rewritten

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : fallback;
}
const ROOT = argVal('--root', '.');
const MAX_DEPTH = parseInt(argVal('--max-depth', '1'), 10);
const MANIFEST = argVal('--manifest', path.join(ROOT, '.nexis', 'survey.manifest.md'));

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function absPath(relPath) {
  return relPath === '.' ? ROOT : path.join(ROOT, relPath);
}

function git(relPath, gitArgs) {
  return spawnSync('git', ['-C', absPath(relPath), ...gitArgs], { encoding: 'utf8' });
}

// ---------- git binary present? ----------

{
  const res = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    emit({ git_available: false });
    process.exit(0);
  }
}

// ---------- detect repos: root + depth-1 children (bounded scan) ----------

function isGitEntry(p) {
  // covers both the directory form (ordinary repo) and the file form
  // (submodule / linked-worktree gitlink) without special-casing either
  return fs.existsSync(path.join(p, '.git'));
}

function listChildDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => path.join(p, d.name));
  } catch {
    return [];
  }
}

const candidates = [ROOT];
if (MAX_DEPTH >= 1) candidates.push(...listChildDirs(ROOT));

const detected = [];
for (const c of candidates) {
  if (isGitEntry(c)) {
    let rel = path.relative(ROOT, c);
    if (rel === '') rel = '.';
    detected.push(rel.split(path.sep).join('/'));
  }
}

if (detected.length === 0) {
  emit({ git_available: true, legacy_manifest: false, any_repo_found: false, repos: [] });
  process.exit(0);
}

// ---------- current state per detected repo ----------

function repoState(relPath) {
  const branch = git(relPath, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const detached = branch === 'HEAD';
  const commit = git(relPath, ['rev-parse', 'HEAD']).stdout.trim();
  const dirty = git(relPath, ['status', '--porcelain']).stdout.trim().length > 0;
  return { branch: detached ? null : branch, detached, commit, dirty };
}

const current = new Map();
for (const r of detected) current.set(r, repoState(r));

// ---------- parse the manifest's repos table, if any ----------
//
// Expected shape:
//   ## Repos
//   | repo_path | branch | last_surveyed_commit |
//   |-----------|--------|-----------------------|
//   | .         | main   | 4f9a2e1...            |
//
// A manifest that exists but has no "## Repos" section predates re-survey
// support entirely — flagged legacy_manifest so the skill refuses and asks
// for --rebuild rather than guessing at a lineage that was never recorded.

function parseManifestRepos(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { exists: false, legacy: false, rows: new Map() };
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const idx = raw.indexOf('## Repos');
  if (idx === -1) return { exists: true, legacy: true, rows: new Map() };
  const rows = new Map();
  const lines = raw.slice(idx).split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) break; // next section
    const cells = line.split('|').map(c => c.trim());
    if (cells.length >= 4 && cells[1] && cells[1] !== 'repo_path' && !/^-+$/.test(cells[1])) {
      rows.set(cells[1], { branch: cells[2], last_surveyed_commit: cells[3] });
    }
  }
  return { exists: true, legacy: false, rows };
}

const manifest = parseManifestRepos(MANIFEST);

// ---------- classify ----------

if (manifest.legacy) {
  emit({
    git_available: true,
    legacy_manifest: true,
    any_repo_found: true,
    repos: detected.map(r => ({ repo_path: r, ...current.get(r), status: 'unknown' })),
  });
  process.exit(0);
}

const repos = [];
const seen = new Set();

if (manifest.exists) {
  for (const [repoPath, mrow] of manifest.rows) {
    seen.add(repoPath);
    const st = current.get(repoPath);
    if (!st) {
      repos.push({ repo_path: repoPath, status: 'removed', manifest_branch: mrow.branch, manifest_commit: mrow.last_surveyed_commit });
      continue;
    }
    if (st.detached || st.branch !== mrow.branch) {
      repos.push({ repo_path: repoPath, ...st, status: 'branch_mismatch', manifest_branch: mrow.branch });
      continue;
    }
    if (st.dirty) {
      repos.push({ repo_path: repoPath, ...st, status: 'dirty' });
      continue;
    }
    const ancestor = git(repoPath, ['merge-base', '--is-ancestor', mrow.last_surveyed_commit, 'HEAD']);
    if (ancestor.status !== 0) {
      repos.push({ repo_path: repoPath, ...st, status: 'history_rewritten', manifest_commit: mrow.last_surveyed_commit });
      continue;
    }
    if (st.commit === mrow.last_surveyed_commit) {
      repos.push({ repo_path: repoPath, ...st, status: 'unchanged' });
      continue;
    }
    const changed_files = git(repoPath, ['diff', '--name-only', mrow.last_surveyed_commit])
      .stdout.split('\n').map(s => s.trim()).filter(Boolean);
    repos.push({ repo_path: repoPath, ...st, status: 'changed', changed_files });
  }
}

for (const r of detected) {
  if (!seen.has(r)) repos.push({ repo_path: r, ...current.get(r), status: 'new' });
}

emit({
  git_available: true,
  legacy_manifest: false,
  any_repo_found: true,
  repos,
});
