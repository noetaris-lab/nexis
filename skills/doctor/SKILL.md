---
description: Scan the .nexis note store for integrity defects and repair them. Runs a deterministic validator (schema, link/graph symmetry, index drift) and, on request, applies safe repairs and reviews supersession-propagation debt where superseding a note left active referrers stale. Invoke to health-check or lint the notes, or after bulk edits.
disable-model-invocation: true
---

You are running **nexis:doctor** — the health check and repair tool for the `.nexis` note store. You orchestrate a deterministic validator script and, when asked, apply repairs. Notes are the source of truth; be conservative with writes.

## Modes

Parse `$ARGUMENTS`:

- **(no flags)** — **report only.** Run the validator dry-run and present findings. Write nothing.
- **`--fix`** — apply **safe Tier-1/2 repairs** (back-link symmetry, status/`superseded_by` consistency, tag normalization, index reconcile) via the script. Tier-3 propagation debt is listed as recommendations only.
- **`--fix-content`** — implies `--fix`; **additionally** perform the Tier-3 supersession-propagation review (Step 4) and revise stale referrer bodies.

If `.nexis/` does not exist, tell the user to run `/nexis:ingest` first and stop.

## Step 0 — Capture current timestamp

Only needed if you may write in this run (`--fix-content`). Run once and reuse for every `updated` field and `*Updated:*` marker:

```bash
node -e "console.log(new Date().toISOString())"
```

Do not derive timestamps from context or training knowledge — always use the shell output.

## Step 1 — Run the validator (always, read-only first)

Run the deterministic validator from the user's project root and read its JSON:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

It emits a JSON report: `counts`, `structural[]`, `graph[]`, `index[]`, `propagation_candidates[]`. Each defect carries a `severity` (`error`/`warn`), a `code`, a `message`, and `fixable: true` when the script can repair it safely. The script never writes in this invocation.

Group and present the findings to the user by area (schema, graph, index, propagation). Distinguish:
- **Auto-fixable** (`fixable: true`) — repaired under `--fix`.
- **Manual** — everything else (dangling links, bad `rel`, `id`/filename mismatch, duplicate ids, supersede cycles, `decided-by`/`motivated-by` target-type errors, bad timestamps, orphan superseded notes). These need human judgment; list them as TODOs with file and message. Never auto-delete links or rename files.

If the mode is report-only, present the report (including the propagation candidates as recommendations) and stop here.

## Step 2 — Apply safe repairs (`--fix` / `--fix-content`)

Re-run the validator with `--fix` so it applies the deterministic Tier-1/2 repairs in place:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --fix
```

Report `fixes_applied` from the JSON. These repairs are non-destructive: they add missing back-links, correct `status`/`superseded_by` inconsistencies, normalize tags, and reconcile the index (existing summaries preserved). No note is deleted and no body is edited.

If the mode is `--fix` (not `--fix-content`), present the applied fixes plus the remaining manual TODOs and the propagation candidates as recommendations, then stop.

## Step 3 — Propagation-debt review (`--fix-content` only)

The validator's `propagation_candidates[]` are active notes whose `updated` predates a newer note that changed their meaning — so they may still assert stale content. Each entry carries a `kind`: `supersession` (the note links to a note that was later superseded) or `extension` (the note was later extended by a newer note that may have changed a surface fact it embeds). This is the retroactive form of ingest's Step 3.5, and it uses the same `nexis:reconcile` sub-agent — so the candidate bodies never enter the doctor context, and the review scales no matter how much debt a legacy store has accumulated. Run this step only after Step 2 has repaired status/back-link defects, so the candidate set is accurate.

1. **Group the candidates.**
   - **Supersession candidates:** group by their `superseded` id. Each group is one overridden note plus the active referrers that still point at it (`superseded_by` gives the superseding note ids).
   - **Extension candidates:** group by their `extending` id(s). Each group is one extending note plus the `target` notes it extends.

2. **Delegate each group to a `nexis:reconcile` agent** (spawn them in parallel — the groups are independent). Each task message contains a `timestamp` (from Step 0) plus, by group kind:
   - Supersession — `mode: supersession`, `superseded`: the group's superseded id, `superseding`: its `superseded_by` ids, `referrers`: the candidate referrer ids.
   - Extension — `mode: extension`, `extending`: the group's extending id, `targets`: the candidate `target` ids.

   Each agent revises only the notes whose content is genuinely inaccurate under the newer note (appending an `*Updated:*` marker, bumping `updated`, annotating the link), leaves accurate ones untouched, and returns a compact manifest of revised vs. clean. Collect all manifests.

3. **Reconcile the index.** After the agents finish, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --fix` once more so any changed summaries and the index are reconciled, and to confirm the store is clean.

## Completion report

Report:
- defect counts by area (schema / graph / index) and severity
- how many safe repairs were auto-applied (if any)
- how many propagation candidates were reviewed, and of those, how many referrers were revised vs. left clean
- the remaining **manual** defects the user must resolve by hand, each with file and message
