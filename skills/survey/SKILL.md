---
description: Bootstrap atomic notes from an existing codebase, and keep them in sync as the code changes. Surveys a brownfield software project — code is the source of truth, not docs — and delegates per-module deep-dives to sub-agents that distill architecture, decisions, invariants, and risks into .nexis/ notes. With --history it additionally mines the git log for decisions the current code cannot show you — what was tried, reverted, and abandoned. A checkpointed, resumable bootstrap on first run; an incremental re-survey (git-diff-scoped) on later runs. Best run on an Opus session.
disable-model-invocation: true
---

You are running **nexis:survey**. You bootstrap and — on later invocations — incrementally refresh the `.nexis/` note store from the **code** of the current project. You are the orchestrator: you inventory, partition, delegate, and weave — you **never read source-file bodies in bulk**. All code reading happens inside `nexis:survey-analyst` sub-agents, each scoped to one analysis unit. Your context holds only deterministic inventory stats and compact manifests.

Two principles govern everything:

- **Code is the source of truth.** Docs, READMEs, and comments are hints to be verified against code, never facts. Where they disagree, the code wins — and the disagreement is itself note-worthy.
- **Selectivity over coverage.** The output is durable project knowledge (architecture, decisions, invariants, risks), not per-file documentation. Fewer, denser notes beat many shallow ones.

This is a **git-based** skill: it locks each repo to a branch at first survey, and detects drift by diffing against the commit last surveyed. It refuses rather than guesses whenever that lineage can't be trusted — see Step 0 and Step 1.

## Step 0 — Precondition + timestamp

Git must be present — everything downstream (inventory's churn signal, branch locking, repo topology, drift diffing) depends on it:

```bash
git --version >/dev/null 2>&1 || echo "NO_GIT"
```

If that printed `NO_GIT`, **refuse and stop**: "`/nexis:survey` requires git; install it and retry." This is a hard, whole-skill gate — it applies to a fresh Build too, not just re-survey.

Then capture the timestamp. Use this result for every `created`, `updated`, and `last_surveyed` value written this session, and pass it to every analyst:

```bash
node -e "console.log(new Date().toISOString())"
```

Do not derive the timestamp from conversation context.

## Step 1 — Parse arguments and detect mode

Parse `$ARGUMENTS` for:
- `--paths <dir>` — restrict the survey to a subtree (useful for a trial run)
- `--effort quick|standard|deep` — per-unit budget tier (default `standard`). Governs how much each analyst reads and writes, and how many commits history mining distils. It is the single cost dial.
- `--history [<since>]` — additionally mine the git log for decisions (see Step 6.5). The optional value bounds how far back: a git ref (`v2.0.0`, `HEAD~500`, a SHA) or a git date expression (`"18 months ago"`, `2024-01-01`). Bare `--history` means the whole history. **The value is optional, so a following token beginning with `--` is a flag, not the window.**
- `--no-history` — skip mining for this run even on a store that has previously been mined
- `--plan` — stop after partitioning and print the plan; write no notes
- `--rebuild` — discard any existing survey checkpoint and start fresh, bypassing every gate below

`--effort` and `--history` are independent axes: how deeply each unit's *code* is read, and how far back its *history* is mined. Neither implies the other.

Run the topology script once, before anything else:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/survey-topology.mjs" --root . --manifest .nexis/survey.manifest.md
```

(Pass `--root` and `--manifest` relative to `--paths` if given.) Read its JSON. This script is the **only** source of git truth for this skill — never construct a `git diff`/`git merge-base`/etc. call yourself; if you need a fact this script doesn't report, that's a sign the script needs updating, not a one-off shell command here.

Interpret the report, in order:

1. `git_available: false` → **refuse**: git is not installed (Step 0 should have already caught this, but the script checks independently — treat it the same way).
2. `any_repo_found: false` → **refuse**: "no git repository found in this workspace (checked root + immediate children) — /nexis:survey requires a git project."
3. `--rebuild` passed → **Build**, on the current topology, ignoring everything else below. The repos table and every unit is reseeded fresh.
4. `legacy_manifest: true` → **refuse**: "this store predates re-survey support (no repo-lock recorded in survey.manifest.md) — pass --rebuild to adopt the new tracking." (This discards the old checkpoint; that's expected — there's no way to safely infer the commit an old-format survey actually reflected.)
5. No manifest at all → **Build**.
6. Manifest exists (modern schema), some unit `status: pending` → **Resume**. Before continuing, apply gate 7 below anyway (cheap, already computed) — a user could have switched branches, rewritten history, or dirtied a repo mid-interruption; refuse the same way if so.
7. Manifest exists, all units `done` or `archived`:
   - Any repo reported `branch_mismatch` / `history_rewritten` / `dirty` → **refuse**, listing **every** flagged repo together (not just the first), each with its specific reason and remedy (checkout the locked branch / pass `--rebuild` / commit-or-stash).
   - Else, every repo `unchanged` and none `new`/`removed` → **no-op**, *unless* history mining is newly requested or has an uncovered span (see Step 1.5) — a user running `/nexis:survey --history` on an unchanged repo is asking for the archaeology, not for a code re-survey. In that case skip straight to Step 6.5. Otherwise report "up to date, nothing changed since `<last_surveyed>`" and stop.
   - Else (some repo `changed`, or there are `new`/`removed` repos) → **Re-survey**.

## Step 1.5 — Resolve the history window

Decide whether mining runs this session, and over what span. **Mining never starts on its own, and once started it never silently stops.**

| situation | mining |
|---|---|
| `--no-history` given | **off** — always wins |
| `--history [<since>]` given | **on**, over the given window (bare = whole history) |
| neither, and the manifest records no history window | **off**. Still run the free scan for the report teaser (Step 6.5 end) |
| neither, and the manifest records a history window | **on** — *sticky*. Mine incrementally over what's new. Skipping would leave a hole in exactly the record the feature exists to keep, and a few new commits cost almost nothing |
| `--rebuild` | window is cleared with everything else; mining runs only if `--history` is passed again |

If mining is on, resolve the window **against every repo** before spending anything, and **refuse rather than guess**:

- A **ref** (`v2.0.0`) that does not resolve in one of the repos → **refuse**, naming each repo where it failed. A tag is meaningless in a sibling repo that never carried it. Say so, and point out that **a date expression is the form that generalizes across a multi-repo workspace** — recommend it.
- An unresolvable value in general → the script exits with `unresolvable_window`. Do not fall back to full history: a typo'd date makes git return *zero* commits, not all of them, so falling back would record a window as covered while mining nothing. Surface the error and stop.

**Record the requested window in the manifest (`history_window`) before any fan-out**, so an interrupted run can be resumed without the user having to remember the flag.

## Step 2 — Inventory (deterministic, shell only)

Build a compact picture of the repo **without reading any source-file bodies**. Use commands like:

```bash
git ls-files                                  # respects .gitignore; filter to source/config extensions
git ls-files | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -40   # files per directory
git log --since="12 months ago" --format= --name-only | sort | uniq -c | sort -rn | head -50   # churn hotspots
```

In a multi-repo workspace, run these per detected repo (`git -C <repo_path> ...`) and keep the inventory grouped by repo.

Also collect (Read is fine for these — they are manifests, not source): package/build manifests (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, …), workspace/monorepo configs, top-level `README` (as a *hypothesis source only*), CI/entry-point configs. Note languages, frameworks, and declared entry points.

If `--paths` was given, restrict all of the above to that subtree. In **Resume** mode, skip this step — reuse the recorded plan. In **Re-survey** mode, skip this step too — Step 3.5 replaces it with a targeted diff instead of a fresh inventory.

## Step 3 — Partition into analysis units (Build mode)

From the inventory alone, partition the relevant source into **analysis units** — coherent modules an analyst can deep-dive independently:

- Start from directory / package-manifest boundaries (a monorepo package is a unit).
- Target ≤ ~60 relevant files per unit: split oversized directories by subdirectory; merge trivial ones into their parent.
- Classify each unit **foundation** or **leaf**. Foundation = shared/core/platform code most other units depend on (`core/`, `common/`, `shared/`, `lib/`, base packages, the main framework wiring). When unsure, leaf.
- For each unit record: `slug` (kebab-case, unique), `paths`, a one-line **role hypothesis** (from names and manifests — to be verified by the analyst), `foundation|leaf`, its churn hotspot files from the inventory, and `repo_path` — the detected repo (from the Step 1 topology report) whose path is the longest matching prefix of the unit's paths (`.` if the workspace root itself is the repo).

Write the plan to `.nexis/survey.manifest.md` (see **Manifest format**) with every unit `status: pending`, and seed the **Repos** table from the topology report (every detected repo, its current branch and commit). Aim for roughly 8–30 units on typical projects; a small project may be 2–4. A tiny project (≤ ~60 relevant files total) is fine as a **single unit** — no waves needed.

**If `--plan` was given:** print the unit table (slug, paths, file count, foundation/leaf, role hypothesis, repo_path) plus the estimated analyst count, then stop. Write no notes. (The manifest plan is kept, so a later plain `/nexis:survey` resumes from it.)

## Step 3.5 — Partition delta (Re-survey mode only)

Using the topology report's per-repo `status` and `changed_files`:

- **`changed` repos:** intersect `changed_files` against the `paths` of every existing unit whose `repo_path` matches. Any unit with a hit gets reset to `status: pending` — this is a **refresh**, not a new unit, so keep its `entity_id` and `slug`. It re-enters the fan-out in Step 6 exactly like a pending unit from an interrupted Build, reusing the same checkpoint machinery.
- **Changed files not covered by any existing unit** (new files/directories inside a changed repo): run the Step 3 partitioning logic scoped to just those paths — merge into an existing leaf unit if small, otherwise create new unit(s), `status: pending`, `repo_path` set to that repo.
- **`new` repos:** run full Step 3 partitioning scoped to that repo's whole tree — new units, `status: pending`.
- **Archival check:** for every unit whose `repo_path` is a `removed` repo, or whose `paths` no longer contain any tracked file (`git -C <repo_path> ls-files -- <paths>` returns empty) inside a `changed` repo, set `status: archived` — deterministic bookkeeping, not a model call. Do this immediately (don't wait for Step 7): flip `status: active → archived` on every note id in that unit's `note_ids`, bump `updated` to the Step 0 timestamp. Collect these archived note ids for the propagation pass in Step 7.
- **Backbone note:** if there are any `new`/`removed` repos, or any unit was archived, the project-level topology changed — supersede the existing backbone entity note with an updated one (same mechanic as an analyst superseding its own descriptive note, except you write it directly, as in Step 4): new note with `rel: supersedes`, old one patched to `status: superseded` + `superseded_by` back-link. Skip this if only ordinary code churn happened (no repos/units added or removed) — the backbone describes topology, not code detail.

**If `--plan` was given:** print the affected/new/archived units (and any backbone supersession) and stop. Write nothing.

## Step 4 — Backbone system note (Build mode only)

Write **one** system-level `entity` note describing the project as a whole — languages, major components (the units), entry points, deployment shape, and (in a multi-repo workspace) the constituent repos. Use **only inventory-derived facts** (manifests, file tree, verified entry points); no claims that would require reading source bodies. Generate its ID the standard way:

```bash
node -e "console.log(require('crypto').randomBytes(3).toString('hex'))"
```

(Verify `.nexis/notes/<id>.md` doesn't exist; retry if it does.) Ensure `.nexis/` and `.nexis/notes/` exist first. This note is the `part-of` anchor every unit entity links to. Record its ID in the survey manifest (`system_note`).

## Step 5 — Prepare per-unit briefs

If `.nexis/index.md` already has rows (from prior `/nexis:ingest` runs, or from earlier survey runs), select for each **pending** unit the rows that plausibly overlap it (by tags, title keywords, path mentions) — these go into the analyst's brief so it **links to, extends, or contradicts** existing notes instead of duplicating them. Keep briefs compact: index rows only (with IDs), never note bodies. If there is no index yet, briefs are empty.

For a unit being **re-surveyed** (has a prior `entity_id`), additionally resolve its own `note_ids` (from the manifest) to `id | title | type | tags` rows — this is the "own prior notes" brief the analyst needs to decide supersede-vs-contradict (see Step 6 and `survey-analyst.md`).

## Step 6 — Fan out analysts (wave-ordered)

Spawn one `nexis:survey-analyst` per pending unit, in waves of **≤ 5 concurrent**:

- **Wave 1: foundation units first** (in ≤5-concurrent chunks if there are more than five).
- Every wave after the first is briefed with the **accumulated note manifest** — one line per note created so far this survey (`id | title | type | tags`) plus the backbone note ID — so later analysts *link to* shared concepts instead of re-creating them.
- After each wave completes: mark those units `done` in the survey manifest (checkpoint — an interrupted survey resumes here), record each unit's returned `entity_id` and the full set of note ids it produced (`note_ids`, appended to — not replacing — any it already had if this was a re-survey refresh), and append the returned note lines — **trimmed to `id | title | type | tags`, dropping the summary** — to the accumulated manifest.

Each analyst's task message contains:
- unit `slug`, `paths`, role hypothesis, hotspot files, `repo_path`
- **effort budget**: `quick` → read ≤ 8 files, ≤ 6 notes; `standard` → ≤ 20 files, ≤ 10 notes; `deep` → ≤ 40 files, ≤ 18 notes
- the backbone system note ID
- the full unit list (slugs + role hypotheses) — for proposing cross-unit dependencies *by slug*
- the accumulated note manifest (waves > 1) and the unit's overlapping existing index rows (Step 5)
- **if this unit already has an `entity_id`** (a re-survey refresh, from Step 3.5): `resurvey: true` plus its own prior notes brief (Step 5) — this licenses the analyst to *supersede* its own stale descriptive notes, per the rules in `survey-analyst.md`. Units without a prior `entity_id` are fresh; omit this.
- the Step 0 timestamp

The analyst reads selectively, writes its notes directly to `.nexis/notes/`, **never touches `index.md`**, and returns a compact result manifest (note lines, unit-entity ID, cross-unit deps by slug, contradictions, any notes it superseded — resurvey only — skip counts). Collect every manifest. Re-spawn any analyst that failed. A failed run may have written a few notes before failing, so a retry can leave near-duplicates on disk — the Step 7 dedup check catches them, and the `doctor.mjs` gate (Step 8) reconciles any note that ended up on disk without an index row.

## Step 6.5 — Mine the history (when mining is in effect)

The code analysts have established what the system **is**. This step recovers **why** — the decisions, and the approaches that were tried and abandoned, which the current tree cannot show you by definition. It runs *after* the analyst waves so that the code notes already exist to anchor the decisions to.

`scripts/history-mine.mjs` is the **only** source of git-history truth here, exactly as `survey-topology.mjs` is for topology. Never construct a `git log`/`git show` call yourself, and never let a diff into your own context.

Run this **per repo** (a repo with no candidates is simply skipped):

**1. Scan** — deterministic, free, no model:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/history-mine.mjs" scan \
  --repo <repo_path> [window flags] \
  --max-candidates 1000 \
  --out .nexis/.cache/history-<repo-slug>.scan.json
```

Window flags, by situation:
- **first mine**: `--since <window>` (omit entirely if the window is the whole history)
- **incremental** (repo has a `last_mined_commit`): `--from <last_mined_commit>`
- **widening** (the requested window reaches further back than the recorded `history_from`): `--since <new-window> --until <history_from>` — this mines *only the uncovered older span*. Also run the incremental scan if HEAD has moved since `last_mined_commit`.

`--out` writes the candidate rows to a file and prints **only a summary**. Read the summary; **never read the candidates file yourself** — it is hundreds of rows, and it belongs in the triage agent's context, not yours.

Note from the summary: `candidate_count`, `signal_stats`, `dep_precision`, `warnings[]`, `truncated`, and `newest_commit` — the newest commit actually reached, which becomes `last_mined_commit`. (`oldest_commit` is reported too, but it is *informational only*: see item 5 for why it must never be recorded as the window's lower bound.)

**2. Triage** — spawn `nexis:history-triage` (Haiku, cheap) with: the `candidates_file` path, `select_max` (below), `dep_precision`, the `warnings[]`, and `repo_path`. It returns the SHAs worth a deep read. In a multi-repo workspace, divide `select_max` across repos in proportion to their candidate counts (minimum 5 each).

**3. Pack** — build bounded evidence packs for the selected commits only, in batches of ≤ 8:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/history-mine.mjs" pack \
  --repo <repo_path> --commits <sha,sha,...> \
  --out .nexis/.cache/history-<repo-slug>-batch<n>.packs.json
```

Again `--out` keeps the packs (~2.4k tokens each) out of your context. A pack carries the commit message, a file-change summary, a size-capped diff, and — for a revert — the message of the commit it undid.

**4. Distil** — spawn one `nexis:history-analyst` per batch, **≤ 4 concurrent**, each briefed with: its `packs_file`, `note_cap` (= the number of packs in its batch — at most one note per commit), the backbone system note ID, the **accumulated note manifest** (every note this survey has produced, so decisions link to the code notes they explain rather than restating them), `repo_path`, and the Step 0 timestamp.

If this run reached Step 6.5 **without** running any analyst waves — the history-only path, where the code is unchanged and the user asked purely for the archaeology (Step 1, gate 7) — there is no accumulated manifest from this session. Build the brief from `.nexis/index.md` rows instead (`id | title | type | tags`, the same shape). The history analysts must always see the code notes they are meant to anchor to; without that brief they will restate what the code notes already say.

Each returns notes, **anchors** (back-links it wants patched onto existing code notes — it may not write them itself), and a skip count. Re-spawn any failed batch.

The budgets, all driven by the one `--effort` dial:

| `--effort` | commits triage may select | analyst batches |
|---|---|---|
| `quick` | 12 | 2 |
| `standard` | 30 | 4 |
| `deep` | 60 | 6 |

**5. Record the covered window** — per repo, set `history_from` (the *start bound* of the window: the resolved ref/SHA or the date expression, or `root` for a full mine) and `last_mined_commit` (the newest commit reached). Record the **start bound**, never the oldest commit walked — git history is a DAG, and treating "ancestors of the oldest commit reached" as the complement of a range silently drops the commits on side branches that merged in between.

**Expect skips, and do not treat them as failure.** An analyst that reads twelve commits and writes three notes is working correctly — a fabricated rationale is far worse than a missing one, and the agents are instructed to skip rather than invent.

**If `--plan` was given**, run only the scan (step 1 — it is free) and print what mining *would* cost: per repo, the commits in the window, the candidate count and signal breakdown, how many commits would be selected at this `--effort`, and the resulting number of evidence packs. Then stop, having written nothing and spawned no agent. The user should be able to see the bill before agreeing to it.

**When mining is *off*,** still run the scan (step 1) once per repo — it is deterministic and free — purely to report the yield: *"312 high-signal commits detected (18 reverts, 40 dependency changes, 6 subsystem deletions) — run with `--history` to distil them."* Then delete the scan file. This costs no model tokens and tells the user what they're leaving on the table. Skip this in **Resume** mode.

## Step 7 — Weave

After all waves:

1. **Resolve cross-unit dependencies.** Map each reported dep slug to that unit's entity note ID (from the manifest's `entity_id` column) and patch a `depends-on` link (with the reported reason as the link `note` where non-obvious) onto the dependent unit's entity note. Report any slug that can't be resolved.
1a. **Patch history anchors (history mining only).** For every `anchor` a `nexis:history-analyst` reported, patch the link onto the **existing code note** — which the analyst was forbidden to touch — and bump that note's `updated`. This is what makes the archaeology pay off: whoever later retrieves *"how config loading works"* also gets *"and here is why it works that way."*

    The schema constrains the rel, and `doctor.mjs` enforces it — check before writing:

    | rel patched onto the code note | the history note it points at must be |
    |---|---|
    | `decided-by` | type `decision` |
    | `motivated-by` | type `decision` or `problem` |
    | `relates_to` | any type |

    `relates_to` exists here because the causal rels are often simply **false**: they assert the code note exists *because of* the history note, which is backwards whenever the history note records something that happened *after* the thing it illuminates (a revert commenting on a design decision it post-dates). Do not upgrade a reported `relates_to` to a causal rel to make the graph look richer.

    Drop (and report) any anchor whose target type doesn't satisfy this, or whose note id doesn't exist. Adding a link does not change a note's claims, so this needs no `nexis:reconcile` pass.
2. **Dedup check.** Scan the collected note lines for near-duplicate titles/tags across units. For a genuine duplicate pair: keep the richer note, set the thinner one `status: archived` with a `relates_to` link to the keeper (bump its `updated`), and drop it from the index rows to be written. For merely-related notes, add a `relates_to` link instead. Expect few — the wave briefing prevents most. Include the history notes in this check: parallel analyst batches can independently land on the same decision.
3. **Propagate supersessions (re-survey only).** For every note id an analyst reported as superseded this run: grep for referrers (`grep -rl "<old-id>" .nexis/notes/`, excluding the old note and its superseding note), and if any exist, delegate to `nexis:reconcile` with `mode: supersession` (`superseded`, `superseding`, `referrers`, the Step 0 timestamp) — identical to the flow `/nexis:ingest` Step 3.5 already uses. Batch independent reconcile tasks in parallel.
4. **Propagate archival (re-survey only).** For every note archived in Step 3.5: grep for referrers the same way, and if any exist, delegate to `nexis:reconcile` with `mode: archival` (`archived`: the note's id, `reason`: e.g. "unit `<slug>` removed from the codebase", `referrers`, the Step 0 timestamp).
5. **Write the index.** You are the **single index writer**. Append one row per new note to `.nexis/index.md` (create it if missing — with an empty frontmatter block: the literal three lines `---`, blank, `---`), filling the `summary` column from the one-sentence summary that note's analyst returned. Update rows for any note patched this session (archived/superseded notes, notes revised by reconcile). **Never write or modify `last_ingested`** — that field belongs to `/nexis:ingest`; setting it would make the next ingest silently skip conversation history.
6. **Update repo rows (re-survey only).** For every repo processed this run (all of them — a gate failure on any one would already have refused the whole run before reaching here), set its `last_surveyed_commit` to the commit captured at the start of this run. Drop the row entirely for any `removed` repo. If history was mined, also write each repo's `history_from` / `last_mined_commit` as resolved in Step 6.5 (item 5).

Note: survey does **not** supersede notes it doesn't own. Where a unit's code contradicts an already-stored note that isn't its own prior output (another unit's, or one from `/nexis:ingest`), the analyst records a `contradicts` note (high-value cross-source disagreement) rather than overriding — the old note stays untouched.

## Step 8 — QA gate

Run the deterministic validator:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

If it reports fixable defects, run it once with `--fix`. Any remaining errors: repair what this session introduced (they are yours), and list pre-existing ones in the report. Do not finish with new defects in the store.

## Step 9 — Finalize manifest

Update `.nexis/survey.manifest.md`: `last_surveyed` = the Step 0 timestamp, `history_window` = the window requested (if mining ran), every unit's `status: done` (or `archived`, if set in Step 3.5) with its `entity_id` and `note_ids` recorded, and the **Repos** table reflecting Step 7.6's updates (Build: every detected repo at its current branch/commit; Re-survey: as updated in Step 7).

Then delete `.nexis/.cache/` — the scan and pack files are scratch, not state.

## Manifest format

`.nexis/survey.manifest.md` (machine state for resume/re-survey — never rendered, never hand-edited):

```markdown
---
last_surveyed: <ISO8601>
effort: standard
scope: .            # or the --paths value
system_note: <id>
history_window: v2.0.0   # the window requested; `all`, a ref, a date expr, or absent if never mined
---

## Repos
| repo_path | branch | last_surveyed_commit | history_from | last_mined_commit |
|-----------|--------|----------------------|--------------|-------------------|
| . | main | 4f9a2e1... | v2.0.0 | 4f9a2e1... |

## Units
| slug | paths | kind | status | entity_id | role | repo_path | note_ids |
|------|-------|------|--------|-----------|------|-----------|-----------|
| auth-service | services/auth | foundation | done | 7f3a1c | JWT auth + session issuing | . | 7f3a1c,88ab3c |
```

A single-repo project's Repos table is just this table's one-row case — there is no separate flat-field schema for it. `status` is one of `pending | done | archived`. `note_ids` is a comma-separated list of every note id the unit's analyst has produced across all runs (used to brief re-survey analysts and to drive the archival sweep).

`history_from` / `last_mined_commit` bound the span of history already distilled for that repo, and are empty until it is first mined. Together they are what makes mining amortize: a re-survey only ever mines `last_mined_commit..HEAD`, and widening the window mines only the span below `history_from`. `history_from` records the window's **start bound** (the ref, date expression, or `root`) — never the oldest commit the walk happened to reach.

## Quality checklist

Before the completion report, verify:
- [ ] No source-file bodies were read in this (orchestrator) context — only inventory stats, manifests, and result manifests.
- [ ] No candidate list, evidence pack, or diff entered this context — history bulk went to `.nexis/.cache/` and was read only by the sub-agents.
- [ ] Index was written only by you, in Step 7; `last_ingested` untouched.
- [ ] Every pending unit reached `done` or `archived` (or is reported as failed with its error).
- [ ] Every cross-unit dep reported by an analyst was resolved to a real note ID or reported as unresolvable.
- [ ] (History) every reported anchor was patched onto a real code note with a schema-legal rel, or dropped and reported.
- [ ] `doctor.mjs` passes with no errors introduced by this session.
- [ ] Survey manifest is consistent: Repos table reflects every processed repo's current commit; unit statuses, `entity_id`s, and `note_ids` recorded; `history_from`/`last_mined_commit` set for every repo mined.
- [ ] `.nexis/.cache/` deleted.
- [ ] (Re-survey) every note an analyst reported as superseded, and every note archived this run, had its referrers grepped and — if any existed — handed to `nexis:reconcile`.

## Completion report

Report: mode (Build / Resume / Re-survey), repos processed (and their branch/commit), units surveyed or re-analyzed, notes created by type, notes superseded or archived (re-survey), duplicates merged, cross-unit links added, doc-vs-code contradictions found (call these out — they are high-value), notes revised by reconcile to propagate a supersession/archival, any failed units, and the doctor QA result. On refusal, state exactly which gate(s) failed, for which repo(s), and the remedy.

**When history was mined**, additionally report: the window covered per repo, commits scanned → candidates → selected → notes written, how many commits were **skipped for want of a recorded rationale** (this is a fact about the repo's commit hygiene and worth saying plainly), the decisions and abandoned approaches recovered (call out reverts — they are the highest-value class), and the anchors patched onto code notes. If `dep_precision` came back `heuristic`, say so and why (a partial clone), because it means dependency decisions may have been missed.

**When history was *not* mined**, close with the free scan's yield and the invitation to mine it — and state the honest cost alongside it, not just the prize.
