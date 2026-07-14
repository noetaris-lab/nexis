#!/usr/bin/env node
// nexis:survey history mining — deterministic git archaeology for /nexis:survey --history.
//
// Usage:
//   node history-mine.mjs scan --repo <path> [--since <ref|date>] [--from <sha>]
//                              [--max-candidates <n>] [--top-churn <n>]
//   node history-mine.mjs pack --repo <path> --commits <sha,sha,...>
//                              [--max-diff-lines <n>]
//
// Read-only, no model involvement (same category as survey-topology.mjs and
// doctor.mjs). Git facts for history mining are produced *here* and nowhere
// else: no model ever constructs a git command, and no model ever sees an
// untruncated diff. That is what makes the token cost of --history a number
// you can compute before you spend it.
//
// `scan` walks the log once, applies the Layer-0 signal rules, and emits
// ranked *candidates* (metadata only, no diffs) plus per-signal stats.
// `pack` builds bounded evidence packs for the commits a triage pass selected.
//
// Notes on git behavior this script deliberately guards against:
//   * `git log --since=<garbage>` does NOT error and does NOT return
//     everything — git resolves the unparseable date to *now* and returns
//     zero commits. A typo'd window would therefore mine nothing while the
//     caller records the window as covered. resolveWindow() rejects it.
//   * Rename detection makes git read blobs, which on a partial clone
//     (--filter=blob:none) triggers network fetches: measured 16.6s vs 0.029s
//     for 2000 commits. We always pass --no-renames and infer mass renames
//     from delete/add basename pairs instead.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const US = '\x1f'; // unit separator — between fields
const RS = '\x1e'; // record separator — between commits

// ---------- arg parsing ----------

const argv = process.argv.slice(2);
const SUB = argv[0];

function argVal(flag, fallback) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : fallback;
}
const REPO = argVal('--repo', '.');
const SINCE = argVal('--since', null); // ref or git date expression
const FROM = argVal('--from', null); // explicit commit, for incremental mining
const UNTIL = argVal('--until', null); // older bound — used to mine a widened window's uncovered span
const MAX_CANDIDATES = parseInt(argVal('--max-candidates', '500'), 10);
const TOP_CHURN = parseInt(argVal('--top-churn', '30'), 10);
const MAX_DIFF_LINES = parseInt(argVal('--max-diff-lines', '200'), 10);
// Wall-clock ceiling for the dependency-diff pass (see depDecisionCommits).
const DEP_BUDGET_MS = parseInt(argVal('--dep-budget-ms', '15000'), 10);
const OUT = argVal('--out', null); // scan: write candidates here, print only the summary

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}
function fail(error, extra = {}) {
  emit({ error, ...extra });
  process.exit(1);
}

function git(args, { max = 64 * 1024 * 1024, timeout = 0 } = {}) {
  const opts = { encoding: 'utf8', maxBuffer: max };
  if (timeout > 0) { opts.timeout = timeout; opts.killSignal = 'SIGKILL'; }
  return spawnSync('git', ['-C', REPO, ...args], opts);
}

/**
 * Clone shapes that change what git can answer cheaply.
 *
 * A *partial* clone (--filter=blob:none) has no historical blobs on disk, so
 * any command that reads file content lazily fetches them from the remote —
 * one round-trip at a time. A *shallow* clone simply doesn't have the older
 * history at all. Both are common in CI, and both are silent: git degrades to
 * network I/O rather than failing, which is how a scan turns into a hang.
 */
function repoShape() {
  const promisor = git(['config', '--get-regexp', String.raw`^remote\..*\.promisor$`]).stdout.trim();
  const partialExt = git(['config', '--get', 'extensions.partialclone']).stdout.trim();
  const shallow = git(['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
  return { partial: Boolean(promisor || partialExt), shallow };
}

// ---------- classification tables ----------

const DEP_MANIFESTS = new Set([
  'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'requirements.txt', 'Gemfile',
  'composer.json', 'setup.py', 'Pipfile', 'mix.exs', 'pubspec.yaml',
]);

// Excluded from evidence-pack diffs: high-volume, zero-signal content. A
// lockfile diff can be 10k lines and tells a reader nothing the manifest
// diff didn't already say.
const DIFF_EXCLUDE_BASENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
  'go.sum', 'Cargo.lock', 'poetry.lock', 'composer.lock', 'Gemfile.lock',
  'Pipfile.lock', 'pubspec.lock', 'mix.lock',
]);
// Vendored and generated trees. Churn here is upstream's history, not this
// project's decisions — e.g. redis carries jemalloc/lua/hiredis under deps/,
// whose vendor-drop commits otherwise rank as major "subsystem deletions".
const DIFF_EXCLUDE_DIRS = [
  'node_modules/', 'vendor/', 'vendored/', 'dist/', 'build/', 'target/', 'out/',
  '.yarn/', 'third_party/', 'thirdparty/', 'external/', 'extern/', 'deps/',
];
const DIFF_EXCLUDE_PATTERNS = [
  /\.min\.(js|css)$/, /\.snap$/, /\.pb\.go$/, /_pb2\.py$/, /\.generated\./,
  /\.(png|jpe?g|gif|svg|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|wasm)$/i,
];

function isDiffExcluded(file) {
  const base = path.posix.basename(file);
  if (DIFF_EXCLUDE_BASENAMES.has(base)) return true;
  if (DIFF_EXCLUDE_DIRS.some(d => file.startsWith(d) || file.includes('/' + d))) return true;
  if (DIFF_EXCLUDE_PATTERNS.some(re => re.test(file))) return true;
  return false;
}

const BOT_AUTHOR = /dependabot|renovate|greenkeeper|snyk-bot|\[bot\]|github-actions/i;

// Trailers carry no rationale — they must not inflate the body-length signal,
// which is our single best proxy for "someone wrote down why".
const TRAILER = /^(Signed-off-by|Co-authored-by|Co-Authored-By|Change-Id|Reviewed-by|Acked-by|Tested-by|Reported-by|Suggested-by|Cc|Fixes|Closes|Refs|PR-URL|Reviewed-By|Helped-by):/i;

// Churn is a proxy for unresolved design tension — but only over *code*. A
// raw churn ranking is topped by package.json, History.md and Readme.md
// (measured on express: 1209 / 985 / 282 touches), which would make `hotspot`
// co-fire with every release commit in the repo.
const CHURN_EXCLUDE_PATTERNS = [
  /(^|\/)(readme|history|changelog|changes|news|authors|contributing|license|copying|notice|security|code_of_conduct)(\.\w+)?$/i,
  /\.(md|rst|txt|adoc)$/i,
  /(^|\/)docs?\//i,
  /(^|\/)\.github\//,
];

function isChurnExcluded(file) {
  if (isDiffExcluded(file)) return true;
  if (DEP_MANIFESTS.has(path.posix.basename(file))) return true;
  return CHURN_EXCLUDE_PATTERNS.some(re => re.test(file));
}

// Fallback only, for repos where reading manifest diffs is not affordable (see
// depDecisionCommits). Subject-matching is far blunter than diffing dependency
// names — it cannot tell "added redis client" from "bumped redis client" unless
// the author said so — hence `dep_precision: heuristic` in the report.
const BUMP_SUBJECT = new RegExp([
  String.raw`^(chore|build|ci)(\(.*\))?!?:\s*(bump|update|upgrade|pin|lock)\b`,
  String.raw`^deps?(\(.*\))?!?:`, // express's house style: "deps: qs@^6.14.1"
  String.raw`^(bump|upgrade|update)\b`,
  String.raw`^v?\d+\.\d+\.\d+`, // bare release commits: "5.2.1"
  String.raw`^release[:\s]`,
  String.raw`^merge\b`,
].join('|'), 'i');

// ---------- window resolution ----------

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Resolve the requested history window into concrete git log arguments.
 *
 * Precedence: --from (an exact commit, used for incremental mining) beats
 * --since (the user-facing window), which beats "everything".
 *
 * Refuses rather than guesses on an unresolvable --since: see the header note
 * on git's silent-zero-commits behavior for unparseable dates.
 */
function resolveWindow() {
  if (FROM) {
    const ok = git(['rev-parse', '--verify', `${FROM}^{commit}`]);
    if (ok.status !== 0) fail('unresolvable_from', { value: FROM });
    return { mode: 'range', from: ok.stdout.trim(), logArgs: [`${FROM}..HEAD`] };
  }

  // An older bound, set when a previously-mined window is being *widened*: the
  // span from the new (older) start up to what was already covered. Without it,
  // widening `--history v2.0.0` to `--history` would re-mine everything the
  // first run already paid for.
  //
  // The caller must pass the previous window's *start bound* here — the ref or
  // date it was opened at — never the oldest commit that walk happened to
  // reach. Git history is a DAG: `v1.6.0..HEAD` and "ancestors of the oldest
  // commit in that range" are not complements, and treating them as such
  // silently drops the commits on side branches that join in between (measured
  // on axios: 262 of 2131 commits lost).
  let untilSha = null;
  let untilDate = null;
  if (UNTIL) {
    const u = git(['rev-parse', '--verify', `${UNTIL}^{commit}`]);
    if (u.status === 0) {
      untilSha = u.stdout.trim();
    } else {
      // Not a ref — a date bound, from a previous window opened with one. Same
      // trap as --since: git resolves an unparseable date to "now" rather than
      // erroring, so an epoch at "now" means it failed to parse, not that the
      // user meant now. Verified: `rev-parse --until=nonsense-ref` returns
      // --min-age=<current epoch>.
      const asDate = git(['rev-parse', `--until=${UNTIL}`]);
      const m = /--min-age=(\d+)/.exec(asDate.stdout || '');
      if (!m) fail('unresolvable_until', { value: UNTIL });
      const epoch = parseInt(m[1], 10);
      if (Math.abs(nowEpoch() - epoch) < 5) {
        fail('unresolvable_until', {
          value: UNTIL,
          hint: 'not a git ref, and git could not parse it as a date (it resolved to "now")',
        });
      }
      untilDate = UNTIL;
    }
  }

  if (SINCE) {
    // 1. a ref? (tag, branch, sha, HEAD~500)
    const asRef = git(['rev-parse', '--verify', `${SINCE}^{commit}`]);
    if (asRef.status === 0) {
      const sha = asRef.stdout.trim();
      const logArgs = untilSha
        ? [`${sha}..${untilSha}`]
        : untilDate
          ? [`${sha}..HEAD`, `--until=${untilDate}`]
          : [`${sha}..HEAD`];
      return { mode: 'range', from: sha, ref: SINCE, until: untilSha || untilDate, logArgs };
    }

    // 2. a git date expression? git resolves an *unparseable* date to "now",
    //    silently yielding zero commits — so an epoch within a few seconds of
    //    now means git failed to parse it, not that the user asked for "now".
    const asDate = git(['rev-parse', `--since=${SINCE}`]);
    const m = /--max-age=(\d+)/.exec(asDate.stdout || '');
    if (!m) fail('unresolvable_window', { value: SINCE });
    const epoch = parseInt(m[1], 10);
    if (Math.abs(nowEpoch() - epoch) < 5) {
      fail('unresolvable_window', {
        value: SINCE,
        hint: 'not a git ref, and git could not parse it as a date (it resolved to "now", which would silently mine zero commits)',
      });
    }
    const logArgs = [`--since=${SINCE}`];
    if (untilDate) logArgs.push(`--until=${untilDate}`);
    return { mode: 'since', since: SINCE, since_epoch: epoch, until: untilSha, logArgs };
  }

  // Everything. With an older bound, "everything" means every ancestor of that
  // bound — i.e. the uncovered span below an already-mined window.
  if (untilSha) return { mode: 'all', until: untilSha, logArgs: [untilSha] };
  if (untilDate) return { mode: 'all', until: untilDate, logArgs: [`--until=${untilDate}`] };
  return { mode: 'all', logArgs: [] };
}

// ---------- log walking ----------

/** Commit metadata: one git invocation, one pass. */
function readCommits(logArgs) {
  const fmt = ['%H', '%aI', '%an', '%P', '%s', '%b'].join(US) + RS;
  const res = git(['log', `--pretty=format:${fmt}`, ...logArgs]);
  if (res.status !== 0) fail('git_log_failed', { stderr: (res.stderr || '').trim() });

  const commits = [];
  for (const rec of res.stdout.split(RS)) {
    const chunk = rec.replace(/^\n/, '');
    if (!chunk.trim()) continue;
    const [sha, date, author, parents, subject, body = ''] = chunk.split(US);
    if (!sha) continue;
    commits.push({
      sha,
      date,
      author,
      is_merge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
      subject: subject || '',
      body: body || '',
      files: [],
    });
  }
  return commits;
}

/**
 * File touches per commit: a second single pass.
 *
 * --no-renames is not an optimization detail, it is a correctness/latency
 * requirement — rename detection reads blobs, which on a partial clone means
 * network round-trips (16.6s vs 0.029s for 2000 commits, measured).
 */
function readFileTouches(logArgs, commits) {
  const byId = new Map(commits.map(c => [c.sha, c]));
  const res = git([
    'log', `--pretty=format:${RS}%H`, '--name-status', '--no-renames', ...logArgs,
  ]);
  if (res.status !== 0) fail('git_log_failed', { stderr: (res.stderr || '').trim() });

  for (const rec of res.stdout.split(RS)) {
    if (!rec.trim()) continue;
    const lines = rec.split('\n');
    const c = byId.get(lines[0].trim());
    if (!c) continue;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      c.files.push({ status: line.slice(0, tab).trim()[0], path: line.slice(tab + 1).trim() });
    }
  }
}

// ---------- signal rules (Layer 0) ----------

function bodyLines(body) {
  return body
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !TRAILER.test(l) && !/^#/.test(l));
}

/**
 * The body-length bar, calibrated to the repo's own commit culture.
 *
 * A fixed threshold cannot serve both cultures: measured at >=3 lines, express
 * flags 2% of commits (a body is genuinely exceptional there) while redis flags
 * 27% (writing a body is simply the house style). The signal we actually want
 * is "the author wrote unusually much *for this project*", so we take the 90th
 * percentile of commits that have a body at all — p90 lands at 4 lines on
 * express, 10 on axios, 16 on redis, and each yields a comparable ~3-5% of the
 * log. The floor of 3 keeps a terse-but-tiny repo from setting a bar of 1.
 *
 * The bar is always measured over the repo's *full* history, never over the
 * requested window: it describes the project's commit culture, which does not
 * change just because this run happens to be mining 40 new commits. Calibrating
 * it on a small incremental window would make the bar jitter run to run.
 */
function longBodyThreshold() {
  const res = git(['log', `--pretty=format:%b${RS}`]);
  const nz = (res.stdout || '')
    .split(RS)
    .map(b => bodyLines(b).length)
    .filter(n => n > 0)
    .sort((a, b) => a - b);
  if (nz.length === 0) return 3;
  return Math.max(3, nz[Math.floor(nz.length * 0.9)]);
}

function headDirs() {
  const res = git(['ls-files']);
  const dirs = new Set();
  for (const f of res.stdout.split('\n')) {
    if (!f.trim()) continue;
    const parts = f.split('/');
    for (let i = 1; i <= parts.length - 1; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}

/** Top-churn files across the window — churn tracks unresolved design tension. */
function churnSet(commits, n) {
  const counts = new Map();
  for (const c of commits) {
    for (const f of c.files) {
      if (isChurnExcluded(f.path)) continue;
      counts.set(f.path, (counts.get(f.path) || 0) + 1);
    }
  }
  return new Set(
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0])
  );
}

/**
 * Extract the dependency *name* a manifest diff line declares, or null.
 *
 * The distinction that matters: adding or dropping a dependency is a
 * technology decision; bumping its version is not. Comparing name sets across
 * a commit's +/- lines separates them — a bump puts the same name on both
 * sides and cancels out.
 */
function depKey(rawLine) {
  const line = rawLine.slice(1); // strip the leading +/-

  // JSON manifests: require the value to look like a version spec, so that
  // npm "scripts" entries (values are shell commands) don't read as deps.
  const json = /^\s*"([^"]+)"\s*:\s*"([^"]*)"/.exec(line);
  if (json) {
    return /^([\^~><=]|\d|\*|latest\b|file:|git[:+]|https?:|link:|workspace:|npm:)/i.test(json[2])
      ? json[1]
      : null;
  }
  const gem = /^\s*gem\s+["']([^"']+)["']/.exec(line);
  if (gem) return gem[1];

  const gomod = /^\s*([\w.\-]+(?:\/[\w.\-]+)+)\s+v\d/.exec(line); // require ( ... )
  if (gomod) return gomod[1];

  const pinned = /^\s*([A-Za-z0-9_.\-]+(?:\[[^\]]+\])?)\s*(==|>=|<=|~=|!=|>|<)/.exec(line); // requirements.txt
  if (pinned) return pinned[1];

  const toml = /^\s*([A-Za-z0-9_.\-]+)\s*=\s*[{"']/.exec(line); // Cargo.toml, pyproject
  if (toml) return toml[1];

  return null;
}

/**
 * Commits in which a dependency was actually added or removed.
 *
 * One `git log -p` pass per dependency manifest — the manifests are small, so
 * on an ordinary clone this is local and effectively free (measured: 0.064s
 * over express's 1209 package.json revisions). It is the only place the
 * scanner reads diff content at all, and it is what makes `dep_change` mean
 * "a technology decision" rather than "a version was bumped" — without it the
 * signal fires on 1146 of express's 6157 commits, drowning the real ones.
 *
 * The catch: on a *partial* clone those historical blobs aren't on disk, so
 * git lazily fetches each one from the remote and the same pass takes minutes
 * (measured: >60s on axios before we killed it). We therefore run the pass
 * under a wall-clock budget and, if it doesn't finish, fall back to the blunt
 * subject heuristic and say so in the report. Degrading loudly beats hanging.
 */
function depDecisionCommits(logArgs, commits, shape) {
  const tracked = git(['ls-files']).stdout.split('\n')
    .map(s => s.trim())
    .filter(f => f && DEP_MANIFESTS.has(path.posix.basename(f)) && !isDiffExcluded(f));

  const heuristic = () => {
    const hits = new Set();
    for (const c of commits) {
      if (BUMP_SUBJECT.test(c.subject)) continue;
      if (c.files.some(f => DEP_MANIFESTS.has(path.posix.basename(f.path)))) hits.add(c.sha);
    }
    return hits;
  };

  if (tracked.length === 0) return { hits: new Set(), precision: 'exact', warnings: [] };

  // On a partial clone the pass is near-certain to blow the budget on any
  // sizeable manifest history, so probe briefly rather than spending the full
  // allowance discovering what the clone shape already told us. An explicit
  // --dep-budget-ms always wins: a user who knows their remote is fast (or who
  // has warmed the blob cache) can still ask for exact detection.
  const budget = shape.partial && !argv.includes('--dep-budget-ms')
    ? Math.min(DEP_BUDGET_MS, 4000)
    : DEP_BUDGET_MS;

  const hits = new Set();
  const deadline = Date.now() + budget;

  for (const manifest of tracked) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        hits: heuristic(),
        precision: 'heuristic',
        warnings: [
          `dependency-diff pass exceeded its ${budget}ms budget${shape.partial ? ' (partial clone: git is lazily fetching historical blobs from the remote)' : ''} — dep_change fell back to subject matching, so it may miss renamed/added deps and admit some version bumps. Run in a full clone for exact detection.`,
        ],
      };
    }

    const res = git(
      ['log', `--pretty=format:${RS}%H`, '-p', '--no-renames', '--unified=0', ...logArgs, '--', manifest],
      { timeout: remaining }
    );
    // Killed by the timeout, or died fetching from a promisor remote.
    if (res.signal || res.status !== 0) {
      return {
        hits: heuristic(),
        precision: 'heuristic',
        warnings: [
          `dependency-diff pass could not complete on \`${manifest}\`${shape.partial ? ' (partial clone: historical blobs are not local)' : ''} — dep_change fell back to subject matching. Run in a full clone for exact detection.`,
        ],
      };
    }

    for (const rec of res.stdout.split(RS)) {
      if (!rec.trim()) continue;
      const lines = rec.split('\n');
      const sha = lines[0].trim();
      const added = new Set();
      const removed = new Set();
      for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('+++') || l.startsWith('---')) continue;
        if (l.startsWith('+')) { const k = depKey(l); if (k) added.add(k); }
        else if (l.startsWith('-')) { const k = depKey(l); if (k) removed.add(k); }
      }
      const introduced = [...added].some(k => !removed.has(k));
      const dropped = [...removed].some(k => !added.has(k));
      if (introduced || dropped) hits.add(sha);
    }
  }

  return { hits, precision: 'exact', warnings: [] };
}

const WEIGHTS = {
  revert: 5,
  subsystem_deletion: 4,
  breaking: 4,
  long_body: 3,
  dep_change: 2,
  mass_rename: 2,
  hotspot: 1,
};

function classify(c, { hotspots, liveDirs, depDecisions, longBodyBar }) {
  const signals = [];
  const bl = bodyLines(c.body);
  const isBot = BOT_AUTHOR.test(c.author || '');

  // revert — the single highest-precision signal in any repo: a decision that
  // something did not work, usually with the reason attached.
  if (/^revert[\s:"']/i.test(c.subject) || /this reverts commit/i.test(c.body)) {
    signals.push('revert');
  }

  // breaking change — an explicitly announced decision
  if (/^[a-z]+(\([^)]*\))?!:/.test(c.subject) || /BREAKING[ -]CHANGE/.test(c.body)) {
    signals.push('breaking');
  }

  // long body — an unusually thorough message *for this repo* (see
  // longBodyThreshold): almost always someone explaining *why*
  if (bl.length >= longBodyBar && !isBot) signals.push('long_body');

  // dependency change — a technology decision. Fires only where a dependency
  // was actually added or dropped (see depDecisionCommits), never on a bump.
  if (!isBot && depDecisions.has(c.sha)) signals.push('dep_change');

  // Structural signals below read only first-party paths: a vendor drop under
  // deps/ or node_modules/ is upstream's history, not a decision by this project.
  const ownFiles = c.files.filter(f => !isDiffExcluded(f.path));

  // subsystem deletion — an abandoned approach, invisible in the current tree
  // by definition. This is the class of knowledge only history can recover.
  const deleted = ownFiles.filter(f => f.status === 'D').map(f => f.path);
  if (deleted.length >= 5) {
    const byDir = new Map();
    for (const p of deleted) {
      const d = path.posix.dirname(p);
      if (d === '.') continue;
      byDir.set(d, (byDir.get(d) || 0) + 1);
    }
    for (const [d, n] of byDir) {
      if (n >= 5 && !liveDirs.has(d)) {
        signals.push('subsystem_deletion');
        break;
      }
    }
  }

  // mass rename — restructuring. Inferred from delete/add basename pairs
  // because we never let git do (blob-reading) rename detection.
  const delBases = new Set(deleted.map(p => path.posix.basename(p)));
  const addBases = ownFiles.filter(f => f.status === 'A').map(f => path.posix.basename(f.path));
  const paired = addBases.filter(b => delBases.has(b)).length;
  if (paired >= 10) signals.push('mass_rename');

  // hotspot — touches load-bearing, high-churn code
  if (c.files.some(f => hotspots.has(f.path))) signals.push('hotspot');

  const score = signals.reduce((s, sig) => s + (WEIGHTS[sig] || 0), 0);
  return { signals, score, body_lines: bl.length, is_bot: isBot };
}

// ---------- scan ----------

function scan() {
  const win = resolveWindow();
  const commits = readCommits(win.logArgs);
  readFileTouches(win.logArgs, commits);

  const shape = repoShape();
  const warnings = [];
  if (shape.shallow) {
    warnings.push(
      'shallow repository — history before the graft point is not present, so the mined window is truncated regardless of what was requested.'
    );
  }

  const liveDirs = headDirs();
  const hotspots = churnSet(commits, TOP_CHURN);
  const dep = depDecisionCommits(win.logArgs, commits, shape);
  const depDecisions = dep.hits;
  warnings.push(...dep.warnings);
  const longBodyBar = longBodyThreshold();

  const candidates = [];
  const stats = {};
  for (const c of commits) {
    const { signals, score, body_lines, is_bot } = classify(c, { hotspots, liveDirs, depDecisions, longBodyBar });
    if (signals.length === 0) continue;

    // A merge commit only qualifies on rationale it carries itself; merge
    // bubbles otherwise re-flag every signal already counted on their parents.
    if (c.is_merge && !signals.includes('revert') && !signals.includes('long_body')) continue;

    // A lone `hotspot` hit is a weak signal — it says the commit touched busy
    // code, not that it decided anything. It earns a candidacy only alongside
    // some other signal.
    if (signals.length === 1 && signals[0] === 'hotspot') continue;

    for (const s of signals) stats[s] = (stats[s] || 0) + 1;
    candidates.push({
      sha: c.sha,
      short: c.sha.slice(0, 8),
      date: c.date,
      author: c.author,
      subject: c.subject,
      body_lines,
      files_changed: c.files.length,
      is_bot,
      signals,
      score,
    });
  }

  candidates.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
  const truncated = candidates.length > MAX_CANDIDATES;

  const summary = {
    repo: REPO,
    window: win,
    repo_shape: shape,
    dep_precision: dep.precision,
    warnings,
    total_commits: commits.length,
    // The actual bounds reached, which the caller records as its covered window.
    // These are facts about what was walked, not about what was requested — a
    // window asking for more history than the repo has must not be recorded as
    // covering more than was actually seen.
    newest_commit: commits.length ? commits[0].sha : null,
    oldest_commit: commits.length ? commits[commits.length - 1].sha : null,
    long_body_threshold: longBodyBar,
    candidate_count: candidates.length,
    candidate_rate: commits.length ? +(candidates.length / commits.length * 100).toFixed(1) : 0,
    truncated,
    signal_stats: stats,
  };
  const full = { ...summary, candidates: candidates.slice(0, MAX_CANDIDATES) };

  // With --out, the candidate list goes to a file and only the summary is
  // printed. This is what lets /nexis:survey stay context-starved: the
  // orchestrator reads the cheap summary, and hands the *path* to the triage
  // agent, which is the only context that ever holds hundreds of candidate rows.
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(full, null, 2));
    emit({ ...summary, candidates_file: OUT });
    return;
  }
  emit(full);
}

// ---------- pack ----------

function commitMessage(rev) {
  const p = git(['show', '-s', `--pretty=format:%H${US}%aI${US}%s${US}%b`, rev]);
  if (p.status !== 0) return null;
  const [sha, date, subject, body = ''] = p.stdout.split(US);
  if (!sha) return null;
  return { sha, short: sha.slice(0, 8), date, subject, body };
}

/**
 * The commit a revert undid — message only, never its diff (the diff is just
 * the inverse of the revert's own, so it costs tokens and carries nothing).
 *
 * Two forms exist in the wild and both must be handled:
 *   * git's auto-generated "This reverts commit <sha>". Here the revert body is
 *     frequently *empty* (measured on express: `Revert "build: use minimatch@3.0.4
 *     for Node.js < 4"` has no body at all), so the parent's message is the only
 *     place the reason could possibly live. Resolving it is not optional.
 *   * A hand-written revert that names no sha (redis's maintainers cite PR
 *     numbers instead). These bodies usually explain themselves — but we can
 *     still recover the parent from the quoted subject in `Revert "<subject>"`.
 */
function resolveRevertParent(sha, subject, body) {
  const bySha = /This reverts commit ([0-9a-f]{7,40})/i.exec(body || '');
  if (bySha) {
    return commitMessage(bySha[1]) || { sha: bySha[1], unresolved: true };
  }

  const quoted = /^Revert\s+"(.+)"\s*$/i.exec((subject || '').trim());
  if (quoted) {
    const original = quoted[1];
    // Nearest ancestor of the revert whose message contains that subject.
    const found = git([
      'log', '-1', '--format=%H', '--fixed-strings', `--grep=${original}`, `${sha}^`,
    ]);
    const parentSha = found.stdout.trim();
    if (parentSha) {
      const msg = commitMessage(parentSha);
      // Guard against the substring match landing on an unrelated commit that
      // merely mentions the same phrase.
      if (msg && msg.subject.trim() === original.trim()) return msg;
    }
    return { subject: original, unresolved: true };
  }

  return null;
}

/**
 * Bounded evidence pack per commit: message + stat + a diff truncated to the
 * line cap with zero-signal paths excluded. This is the token ceiling for the
 * whole feature — the model sees this and nothing else.
 */
function pack() {
  const list = (argVal('--commits', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) fail('no_commits_given');

  const packs = [];
  for (const sha of list) {
    const meta = git(['show', '-s', `--pretty=format:%H${US}%aI${US}%an${US}%s${US}%b`, sha]);
    if (meta.status !== 0) {
      packs.push({ sha, error: 'not_found' });
      continue;
    }
    const [full, date, author, subject, body = ''] = meta.stdout.split(US);

    const nameStatus = git(['show', '--name-status', '--no-renames', '--pretty=format:', sha]);
    const files = [];
    for (const line of nameStatus.stdout.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      files.push({ status: line.slice(0, tab).trim()[0], path: line.slice(tab + 1).trim() });
    }

    const included = files.filter(f => !isDiffExcluded(f.path)).map(f => f.path);
    const excluded = files.filter(f => isDiffExcluded(f.path)).map(f => f.path);

    const stat = git(['show', '--stat', '--no-renames', '--pretty=format:', sha]).stdout.trim();

    let diff = '';
    let diffTruncated = false;
    if (included.length > 0) {
      const res = git([
        'show', '--no-renames', '--pretty=format:', '--unified=3', sha, '--', ...included,
      ]);
      const lines = (res.stdout || '').split('\n');
      if (lines.length > MAX_DIFF_LINES) {
        diff = lines.slice(0, MAX_DIFF_LINES).join('\n');
        diffTruncated = true;
      } else {
        diff = res.stdout;
      }
    }

    // A revert on its own says only that something was undone. The *reason* is
    // usually split across two commits: the revert states the symptom, the
    // reverted commit states what was attempted. Resolve the parent's message
    // (message only — its diff is the inverse of this one, so it adds tokens
    // and no information) so the analyst can write "X was tried, it broke Y".
    const reverts = resolveRevertParent(full, subject, body);

    packs.push({
      sha: full,
      short: full.slice(0, 8),
      date,
      author,
      subject,
      body,
      reverts,
      stat,
      diff,
      diff_truncated: diffTruncated,
      excluded_from_diff: excluded,
    });
  }

  // Same context discipline as scan --out: the packs (~2.4k tokens each) go to
  // a file the history-analyst reads directly. They must never pass through the
  // orchestrator's context on the way there.
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ repo: REPO, pack_count: packs.length, packs }, null, 2));
    emit({
      repo: REPO,
      pack_count: packs.length,
      packs_file: OUT,
      shas: packs.map(p => p.short || p.sha),
    });
    return;
  }
  emit({ repo: REPO, pack_count: packs.length, packs });
}

// ---------- entry ----------

if (!fs.existsSync(path.join(REPO, '.git'))) fail('not_a_repo', { repo: REPO });

if (SUB === 'scan') scan();
else if (SUB === 'pack') pack();
else fail('usage', { hint: 'history-mine.mjs scan|pack --repo <path> [...]' });
