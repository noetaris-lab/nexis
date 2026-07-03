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

The validator's `propagation_candidates[]` are active notes that link to a note which was later superseded and whose `updated` predates that supersession — i.e. they may still assert content derived from the overridden note. This is the retroactive form of ingest's Step 3.5. Run this step only after Step 2 has repaired status/back-link defects, so the candidate set is accurate. Reuse that procedure:

For each candidate `{ referrer, rel, superseded, superseded_by }`:

1. Read the referrer note and each superseding note in `superseded_by`.
2. **Judge staleness.** The referrer needs revision *only if* its body embeds a claim, assumption, or detail that the superseding note changes or invalidates. If it is still accurate, **leave it unchanged and do not stamp it** — report it as reviewed-clean.
3. **If it is now inaccurate:**
   - Revise the body text so its claims are correct under the superseding note.
   - Append an update marker to the **end of the body** (stacked markers preserve history — never remove earlier ones):

     ```

     ---
     *Updated: <ISO8601 from Step 0> — <one-line reason, referencing the superseding note id>*
     ```

   - Set the frontmatter `updated` to the Step 0 timestamp.
   - On the referrer's link to the superseded note, add or update its `note` field, e.g. `note: "target superseded by <superseding-id>"`.
   - Do **not** change the referrer's `status`; do **not** repoint its link.

After revising referrers, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --fix` once more so any changed summaries and the index are reconciled, and to confirm the store is clean.

## Completion report

Report:
- defect counts by area (schema / graph / index) and severity
- how many safe repairs were auto-applied (if any)
- how many propagation candidates were reviewed, and of those, how many referrers were revised vs. left clean
- the remaining **manual** defects the user must resolve by hand, each with file and message
