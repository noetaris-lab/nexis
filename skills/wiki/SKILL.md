---
description: Build or sync a human-readable wiki from .nexis/ notes. Projects the atomic note graph into a structured, top-down onboarding site (overview → topics → detail). Auto-detects first build vs incremental sync. Best run on an Opus session — taxonomy derivation is reasoning-heavy.
disable-model-invocation: true
---

You are running **nexis:wiki**. You are the orchestrator: you derive the wiki's structure and delegate page synthesis to sub-agents. **Never load note bodies in bulk** — reason over the compact `index.md` rows and pull full notes only on demand for disambiguation. All body-level work happens inside the `nexis:wiki-page` sub-agents, each scoped to a single topic.

The wiki is a **machine-owned derived view**: the notes in `.nexis/notes/` are the only source of truth. You may regenerate any page freely. Humans read the wiki; they do not hand-edit it.

## Step 0 — Capture current timestamp

Run once; use the result for every `last_synced` value written this session:

```bash
node -e "console.log(new Date().toISOString())"
```

Do not derive the timestamp from conversation context.

## Step 1 — Parse arguments and resolve configuration

Parse `$ARGUMENTS` for:
- `--out <path>` — explicit wiki content root
- `--target <plain|starlight>` — output flavor
- `--rebuild` — discard existing taxonomy and rebuild from scratch

**Resolve the content root** (highest precedence wins):
1. `--out` flag, if given.
2. A wiki path declared in your loaded project context (e.g. a line in CLAUDE.md / AGENTS.md / copilot-instructions like `nexis wiki: wiki (starlight)`). Use it if present.
3. On **sync**, the `output_root` recorded in the existing manifest (this is where the pages already live).
4. Default: `.nexis/wiki`.

If an inline `--out` on sync differs from the manifest's `output_root`, treat it as a **relocation** → run the Build path at the new root.

**Resolve the target** the same way (inline > context declaration > manifest > default `plain`).

**Machine state always lives at `.nexis/wiki.manifest.md`** regardless of the content root, so it is never rendered by a doc site.

## Step 1.5 — Bootstrap Starlight project (target: starlight only)

Skip this step entirely when target is `plain`.

When target is `starlight`, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap-starlight.mjs" --root "<output_root>" --title "<title>" --description "<description>"
```

Derive `--title`/`--description` from the user's project (`package.json`'s `name`/`description` if present, else the `output_root` directory basename / empty string). This is a deterministic, offline scaffold — it never runs `npm install` and never shells out to `npm create astro`.

Branch on the returned `status`:
- `already_bootstrapped` → proceed; a Starlight project already lives at `output_root`.
- `scaffolded` → proceed; a minimal Starlight project was just written. Remember to tell the user in the completion report that `npm install` must be run inside `output_root` before the site is servable.
- `conflict` → **stop the entire run.** Report the returned `reason` (either a non-Starlight `astro.config.*` already there, or a non-empty directory with no `astro.config.*` at all — e.g. leftover `plain`-target output) and ask the user to pick a different `--out` or clear the directory. Do not proceed to Step 2.

Define the **content root** used by every step below:
- `plain` target → content root = `output_root`.
- `starlight` target → content root = `output_root/<content_dir>` (the script returns `content_dir`, currently always `src/content/docs`, since Starlight's file-based routing fixes that path).

## Step 2 — Preconditions and mode detection

Read `.nexis/index.md`. If it does not exist or has no note rows, stop and tell the user there are no notes yet — suggest running `/nexis:ingest` first.

Determine mode:
- `--rebuild` given, **or** no `.nexis/wiki.manifest.md` exists → **Build path**.
- Manifest exists → **Sync path**.

Note the **shard threshold** (default `1500` notes; overridable via the manifest's `shard_threshold`). Below it, do taxonomy work by reading `index.md` directly. At or above it, delegate index scanning to `nexis:wiki-scan`.

---

# BUILD PATH

## B1 — Taxonomy derivation

**If the index row count is below the shard threshold:** read all of `index.md` and reason over the rows directly.

**If at or above the threshold:** shard the index rows into slices of ~500 and spawn one `nexis:wiki-scan` agent per slice in **survey** mode (task message: `mode: survey` + the slice). Each returns a tag histogram, tag co-occurrence edges, and local micro-clusters. **Reduce** these into a global tag graph. Never hold the full index in context at once.

Then run the **iterative structuring loop** (index/stats only; peek at a *sample* of full note bodies only to disambiguate):
1. **Hypothesize** candidate topics from tags/titles/summaries/types, each with an assigned set of note IDs and a rough cohesion estimate.
2. **Validate** each candidate:
   - too large (> ~30 notes / exceeds a readable page) → peek at a sample, then split.
   - singleton or too thin → merge into its nearest neighbor.
   - a note whose tags straddle two topics → peek at that one body to place it.
3. **Converge** when every topic is cohesive and page-sized. **Freeze the slug for each topic** (kebab-case of the topic name, unique). Slugs must stay stable across future syncs.

## B2 — Assignment

Produce the `note_id → slug` map for all active notes.
- Below threshold: assign inline.
- At/above threshold: spawn `nexis:wiki-scan` in **assign** mode (task message: `mode: assign` + the frozen `topic → tags` definitions + the slice). Each returns compact `id,slug` pairs. Collect them.

## B3 — Depth and build plan

All paths below are relative to the **content root** resolved in Step 1.5 (`<root>` = content root, not necessarily `output_root` — see there for `starlight`).

Decide depth (adaptive):
- ≤ ~12 topics → **flat**: landing at `<root>/index.md`; pages at `<root>/pages/<slug>.md` for `plain`, or directly at `<root>/<slug>.md` for `starlight` (no extra `pages/` segment — the content root is already the dedicated `src/content/docs/` container).
- \> ~12 topics → **section tier**: group topics into sections; pages at `<root>/<section-slug>/<slug>.md`, section landings at `<root>/<section-slug>/index.md` (same shape for both targets).
- A single topic that still exceeds the page budget → the page-writer emits it as a mini-section (`.../<slug>/index.md` + sub-pages).

Pages are always written as `.md` regardless of target — Starlight's asides don't require `.mdx`.

Record a **build plan** — one row per planned page: `topic · slug · page path · assigned note-IDs`. This is the manifest-in-progress.

## B4 — Fan out page writers

For each topic, spawn a `nexis:wiki-page` agent (these run in parallel — spawn them together). Pass in the task message:
- topic name, slug, resolved **absolute page path**
- the topic's assigned note IDs
- resolved `target` (`plain` or `starlight`)
- the page budget (split into a mini-section if exceeded)

Each agent loads only its topic's notes, writes the page(s), self-checks against the notes, and returns a **result manifest**: status, page path(s) written, note IDs cited, omitted IDs + reason, cross-topic link targets, self-check counts, and a 2–3 line topic summary.

## B5 — Reconcile

For each planned page verify, using the returned result manifests (do **not** bulk re-read pages):
- the page file exists and is non-empty,
- the returned cited-IDs cover the assigned set (or every omission is explained),
- cross-topic link targets resolve to a real slug.

Any missing or failed page → re-spawn just that one `nexis:wiki-page` agent (isolated, idempotent). Do not proceed until reconcile passes.

## B6 — Home reduce + manifest

Write the landing `<root>/index.md` (`<root>` = content root, per Step 1.5) from the returned topic **summaries** + cross-topic links only (no body re-reads): a project overview, a table of contents (sections → topics), and a "how the topics relate" map (a Mermaid graph is encouraged). If a section tier exists, also write each `<section-slug>/index.md`.

Write `.nexis/wiki.manifest.md` (see **Manifest format** below).

**Report:** topics + sections created, pages written, notes covered, and any notes left unassigned (report-and-omit — never create a junk-drawer page).

---

# SYNC PATH

## S1 — Delta detection

Read `.nexis/index.md` and `.nexis/wiki.manifest.md` only. For every active note in the index, compute its fingerprint = short hash of `status|title|tags|summary` (use `node -e` if convenient). Diff against the manifest's note map:
- **added** — active row with no manifest entry.
- **changed** — fingerprint differs (covers `active → superseded` retirement and title/tag/summary edits).
- **removed** — manifest entry whose row is gone from the index.

If all three sets are empty → report "wiki is up to date," bump `last_synced`, and stop.

## S2 — Route the delta to topics

- **retired / removed** → its topic (from the map); mark that page **dirty**.
- **changed (edited)** → mark its current page dirty; if its tags moved it out of that topic, treat as a reassignment.
- **added** → assign by tag overlap to an existing topic (mark dirty), else drop into an **unhomed pool**. If the added batch exceeds the shard threshold, reuse `nexis:wiki-scan` (assign mode) with the existing topic definitions.

## S3 — Conservative restructure

Preserve existing slugs (human bookmarks + small diffs). Only:
- spawn a **new topic/page** when the unhomed pool coheres into a clear new theme,
- **split** a topic that has grown past the page budget into a mini-section,
- **adjust the section tier** if the topic count crosses ~12.

Do **not** silently re-cluster, rename, or move notes between existing topics. When accumulated drift is large, add a **drift hint** to the report suggesting `/nexis:wiki --rebuild`.

## S4 — Regenerate dirty pages only

Re-spawn `nexis:wiki-page` for each dirty topic and each new topic, passing its **current active** note-ID set (same task contract as B4). The writer regenerates the whole page from its note set — no surgical prose-patching. Untouched topics' pages are left byte-for-byte.

## S5 — Reconcile

Same as B5, over the dirty/new pages. Re-spawn any that failed.

## S6 — Home reduce + manifest

Regenerate `<root>/index.md` (`<root>` = content root, per Step 1.5) (and any section landings) using **fresh summaries** from the writers that just ran + **cached summaries** from the manifest for untouched topics. Update `.nexis/wiki.manifest.md`: `last_synced`, fingerprints, note map, and any new/split topics.

**Report:** notes added / retired / removed, pages updated, topics created or split, section-tier changes, and a drift hint if warranted.

---

## Manifest format

`.nexis/wiki.manifest.md`:

```markdown
---
output_root: .nexis/wiki
target: plain
last_synced: <ISO8601>
shard_threshold: 1500
---

## Topics
| topic | slug | page | tags | summary |
|-------|------|------|------|---------|
| Authentication | auth | pages/auth.md | auth,jwt,cors | JWT/session model and the CORS-before-auth ordering rule |

## Note map
| note_id | slug | fingerprint |
|---------|------|-------------|
| 7f3a1c | auth | a1b2c3d4 |
```

For a `target: starlight` project, `output_root` names the Astro project root and `page` paths include the fixed content prefix, e.g.:

```markdown
---
output_root: wiki
target: starlight
last_synced: <ISO8601>
shard_threshold: 1500
---

## Topics
| topic | slug | page | tags | summary |
|-------|------|------|------|---------|
| Authentication | auth | src/content/docs/auth.md | auth,jwt,cors | JWT/session model and the CORS-before-auth ordering rule |
```

The `page` path is always relative to `output_root` (for `starlight`, that means it includes the `src/content/docs/` prefix). The note map is the sole record of note→page provenance (pages carry no visible citations).

## Quality checklist

Before the completion report, verify:
- [ ] Content root and target were resolved by precedence and recorded in the manifest.
- [ ] Machine state is at `.nexis/wiki.manifest.md`, not under a rendered content root.
- [ ] For `target: starlight`, the bootstrap step ran and every page landed under `output_root/src/content/docs/`, never directly under `output_root`.
- [ ] A bootstrap `conflict` halted the run rather than overwriting existing non-Starlight content.
- [ ] Every slug is stable (unchanged for topics that already existed).
- [ ] Every planned/dirty page passed reconcile (exists, covers its notes, links resolve).
- [ ] The landing page and every section landing exist.
- [ ] No orphan "Miscellaneous" page was created; unassigned notes are reported instead.
- [ ] The manifest note map covers exactly the active notes represented in the wiki.
