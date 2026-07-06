---
description: Bootstrap atomic notes from an existing codebase, and keep them in sync as the code changes. Surveys a brownfield software project — code is the source of truth, not docs — and delegates per-module deep-dives to sub-agents that distill architecture, decisions, invariants, and risks into .nexis/ notes. A checkpointed, resumable bootstrap on first run; an incremental re-survey (git-diff-scoped) on later runs. Best run on an Opus session.
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
- `--depth quick|standard|deep` — per-unit budget tier (default `standard`)
- `--plan` — stop after partitioning and print the plan; write no notes
- `--rebuild` — discard any existing survey checkpoint and start fresh, bypassing every gate below

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
   - Else, every repo `unchanged` and none `new`/`removed` → **no-op**: report "up to date, nothing changed since `<last_surveyed>`" and stop.
   - Else (some repo `changed`, or there are `new`/`removed` repos) → **Re-survey**.

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
- **depth budget**: `quick` → read ≤ 8 files, ≤ 6 notes; `standard` → ≤ 20 files, ≤ 10 notes; `deep` → ≤ 40 files, ≤ 18 notes
- the backbone system note ID
- the full unit list (slugs + role hypotheses) — for proposing cross-unit dependencies *by slug*
- the accumulated note manifest (waves > 1) and the unit's overlapping existing index rows (Step 5)
- **if this unit already has an `entity_id`** (a re-survey refresh, from Step 3.5): `resurvey: true` plus its own prior notes brief (Step 5) — this licenses the analyst to *supersede* its own stale descriptive notes, per the rules in `survey-analyst.md`. Units without a prior `entity_id` are fresh; omit this.
- the Step 0 timestamp

The analyst reads selectively, writes its notes directly to `.nexis/notes/`, **never touches `index.md`**, and returns a compact result manifest (note lines, unit-entity ID, cross-unit deps by slug, contradictions, any notes it superseded — resurvey only — skip counts). Collect every manifest. Re-spawn any analyst that failed. A failed run may have written a few notes before failing, so a retry can leave near-duplicates on disk — the Step 7 dedup check catches them, and the `doctor.mjs` gate (Step 8) reconciles any note that ended up on disk without an index row.

## Step 7 — Weave

After all waves:

1. **Resolve cross-unit dependencies.** Map each reported dep slug to that unit's entity note ID (from the manifest's `entity_id` column) and patch a `depends-on` link (with the reported reason as the link `note` where non-obvious) onto the dependent unit's entity note. Report any slug that can't be resolved.
2. **Dedup check.** Scan the collected note lines for near-duplicate titles/tags across units. For a genuine duplicate pair: keep the richer note, set the thinner one `status: archived` with a `relates_to` link to the keeper (bump its `updated`), and drop it from the index rows to be written. For merely-related notes, add a `relates_to` link instead. Expect few — the wave briefing prevents most.
3. **Propagate supersessions (re-survey only).** For every note id an analyst reported as superseded this run: grep for referrers (`grep -rl "<old-id>" .nexis/notes/`, excluding the old note and its superseding note), and if any exist, delegate to `nexis:reconcile` with `mode: supersession` (`superseded`, `superseding`, `referrers`, the Step 0 timestamp) — identical to the flow `/nexis:ingest` Step 3.5 already uses. Batch independent reconcile tasks in parallel.
4. **Propagate archival (re-survey only).** For every note archived in Step 3.5: grep for referrers the same way, and if any exist, delegate to `nexis:reconcile` with `mode: archival` (`archived`: the note's id, `reason`: e.g. "unit `<slug>` removed from the codebase", `referrers`, the Step 0 timestamp).
5. **Write the index.** You are the **single index writer**. Append one row per new note to `.nexis/index.md` (create it if missing — with an empty frontmatter block: the literal three lines `---`, blank, `---`), filling the `summary` column from the one-sentence summary that note's analyst returned. Update rows for any note patched this session (archived/superseded notes, notes revised by reconcile). **Never write or modify `last_ingested`** — that field belongs to `/nexis:ingest`; setting it would make the next ingest silently skip conversation history.
6. **Update repo rows (re-survey only).** For every repo processed this run (all of them — a gate failure on any one would already have refused the whole run before reaching here), set its `last_surveyed_commit` to the commit captured at the start of this run. Drop the row entirely for any `removed` repo.

Note: survey does **not** supersede notes it doesn't own. Where a unit's code contradicts an already-stored note that isn't its own prior output (another unit's, or one from `/nexis:ingest`), the analyst records a `contradicts` note (high-value cross-source disagreement) rather than overriding — the old note stays untouched.

## Step 8 — QA gate

Run the deterministic validator:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

If it reports fixable defects, run it once with `--fix`. Any remaining errors: repair what this session introduced (they are yours), and list pre-existing ones in the report. Do not finish with new defects in the store.

## Step 9 — Finalize manifest

Update `.nexis/survey.manifest.md`: `last_surveyed` = the Step 0 timestamp, every unit's `status: done` (or `archived`, if set in Step 3.5) with its `entity_id` and `note_ids` recorded, and the **Repos** table reflecting Step 7.6's updates (Build: every detected repo at its current branch/commit; Re-survey: as updated in Step 7).

## Manifest format

`.nexis/survey.manifest.md` (machine state for resume/re-survey — never rendered, never hand-edited):

```markdown
---
last_surveyed: <ISO8601>
depth: standard
scope: .            # or the --paths value
system_note: <id>
---

## Repos
| repo_path | branch | last_surveyed_commit |
|-----------|--------|-----------------------|
| . | main | 4f9a2e1... |

## Units
| slug | paths | kind | status | entity_id | role | repo_path | note_ids |
|------|-------|------|--------|-----------|------|-----------|-----------|
| auth-service | services/auth | foundation | done | 7f3a1c | JWT auth + session issuing | . | 7f3a1c,88ab3c |
```

A single-repo project's Repos table is just this table's one-row case — there is no separate flat-field schema for it. `status` is one of `pending | done | archived`. `note_ids` is a comma-separated list of every note id the unit's analyst has produced across all runs (used to brief re-survey analysts and to drive the archival sweep).

## Quality checklist

Before the completion report, verify:
- [ ] No source-file bodies were read in this (orchestrator) context — only inventory stats, manifests, and result manifests.
- [ ] Index was written only by you, in Step 7; `last_ingested` untouched.
- [ ] Every pending unit reached `done` or `archived` (or is reported as failed with its error).
- [ ] Every cross-unit dep reported by an analyst was resolved to a real note ID or reported as unresolvable.
- [ ] `doctor.mjs` passes with no errors introduced by this session.
- [ ] Survey manifest is consistent: Repos table reflects every processed repo's current commit; unit statuses, `entity_id`s, and `note_ids` recorded.
- [ ] (Re-survey) every note an analyst reported as superseded, and every note archived this run, had its referrers grepped and — if any existed — handed to `nexis:reconcile`.

## Completion report

Report: mode (Build / Resume / Re-survey), repos processed (and their branch/commit), units surveyed or re-analyzed, notes created by type, notes superseded or archived (re-survey), duplicates merged, cross-unit links added, doc-vs-code contradictions found (call these out — they are high-value), notes revised by reconcile to propagate a supersession/archival, any failed units, and the doctor QA result. On refusal, state exactly which gate(s) failed, for which repo(s), and the remedy.
