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
- `--reorder "<instruction>"` — reposition existing topics/sections (e.g. `--reorder "move Deployment above Authentication"`) without touching note content or page bodies. Requires an existing manifest (nothing to reorder on a first build) and is meaningless together with `--rebuild` (a rebuild re-derives structure from scratch, so `--rebuild` wins and `--reorder` is ignored). See S3.

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

If `--reorder` was given but no manifest exists (and `--rebuild` wasn't also given), stop and tell the user to build the wiki first — there is no existing topic order to rearrange.

Note the **shard threshold** (default `1500` notes; overridable via the manifest's `shard_threshold`). Below it, do taxonomy work by reading `index.md` directly. At or above it, delegate index scanning to `nexis:wiki-scan`.

---

# BUILD PATH

## B1 — Taxonomy derivation

**If the index row count is below the shard threshold:** read all of `index.md` and reason over the rows directly.

**If at or above the threshold:** shard the index rows into slices of ~500 and spawn one `nexis:wiki-scan` agent per slice in **survey** mode (task message: `mode: survey` + the slice). Each returns a tag histogram, tag co-occurrence edges, and local micro-clusters. **Reduce** these into a global tag graph. Never hold the full index in context at once.

Then run the **iterative structuring loop** (index/stats only; peek at a *sample* of full note bodies only to disambiguate):
1. **Hypothesize** candidate topics from tags/titles/summaries/types, each with an assigned set of note IDs and a rough cohesion estimate.
2. **Validate** each candidate:
   - too large or spans multiple distinct sub-themes → peek at a sample and judge on readability and cohesion, then split. ~30 notes is a rough signal that a topic may be crowding a single page, not a hard cutoff — a tightly cohesive topic can run longer, a sprawling one should split sooner.
   - singleton or too thin → merge into its nearest neighbor.
   - a note whose tags straddle two topics → peek at that one body to place it.
3. **Converge** when every topic is cohesive and page-sized. **Freeze the slug for each topic** (kebab-case of the topic name, unique) and a short one-line **theme description** capturing what binds it. Slugs must stay stable across future syncs. The theme description feeds B2 (a semantic anchor for `nexis:wiki-scan` assign-mode workers) and B4 (steer for the page writer).

## B2 — Assignment

Produce the `note_id → slug` map for all active notes.
- Below threshold: assign inline.
- At/above threshold: spawn `nexis:wiki-scan` in **assign** mode (task message: `mode: assign` + the frozen `topic → tags` definitions, each with its one-line **theme description** + the slice). Each returns compact `id,slug` pairs. Collect them.

## B3 — Depth and build plan

All paths below are relative to the **content root** resolved in Step 1.5 (`<root>` = content root, not necessarily `output_root` — see there for `starlight`).

Decide depth by reasoning about **navigability**, not by checking the topic count against a fixed cap. ~12 topics is a rough point past which a flat table of contents typically stops being scannable — but let cohesion and how the topics relate drive the actual call: a well-clustered 16 topics can stay flat, while a sprawling 8 spanning unrelated domains may already want sections.
- **Flat** (the topic set reads as one coherent list): landing at `<root>/index.md`; pages at `<root>/pages/<slug>.md` for `plain`, or directly at `<root>/<slug>.md` for `starlight` (no extra `pages/` segment — the content root is already the dedicated `src/content/docs/` container).
- **Section tier** (a flat list would overwhelm a reader): group topics into sections by reasoning over how they relate (never just alphabetically or by splitting the count in half); pages at `<root>/<section-slug>/<slug>.md`, section landings at `<root>/<section-slug>/index.md` (same shape for both targets).
- A single topic that still exceeds the page budget → the page-writer emits it as a mini-section (`.../<slug>/index.md` + sub-pages).

Pages are always written as `.md` regardless of target — Starlight's asides don't require `.mdx`.

Record a **build plan** — one row per planned page: `topic · slug · page path · assigned note-IDs`. This is the manifest-in-progress.

## B4 — Fan out page writers

For each topic, spawn a `nexis:wiki-page` agent (these run in parallel — spawn them together). Pass in the task message:
- topic name, slug, resolved **absolute page path**
- the topic's one-line **theme description** (from B1) — steer for how to frame and structure the page, not just a note dump
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

## B5.5 — Validate Mermaid diagrams (required)

`astro-mermaid` renders diagrams **client-side**, so `astro build` never fails on a broken diagram — it silently ships an error box in place of the picture. You must run the validator explicitly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mermaid-lint.mjs" --root "<content_root>" --project "<output_root>" --fix --json
```

(`--project` is the Astro project root for `starlight`, so the script can use the *real* `mermaid` parser when `node_modules` is installed; omit or repeat `--root` for `plain`. It auto-falls-back to structural checks when deps aren't installed yet.) The script auto-fixes the safe, mechanical failure classes (unquoted `()` in labels, reserved-word ids like `end`/`loop`, `;` in sequence text) — parser-verified so a fix is only written if it actually parses. For any diagram it reports as still invalid (`remaining > 0`), re-spawn that page's `nexis:wiki-page` agent with the specific parse error so it reworks the diagram. Do not proceed until the validator reports zero remaining.

## B6 — Home reduce + manifest

Write the landing `<root>/index.md` (`<root>` = content root, per Step 1.5) from the returned topic **summaries** + cross-topic links only (no body re-reads). Write it in the same reader-first register the page writer uses (short sentences, plain words, short paragraphs, lead with the point — see `agents/wiki-page.md` Step 3), and never leak note-machinery vocabulary. Keep it a short, orienting entry point — not an exhaustive reference:
- a project overview,
- a small italicized **generated-at line** — **this is required, never omit it** — as its own paragraph, e.g. `*Generated from durable knowledge notes on <human-readable date-time derived from the Step 0 timestamp>.*` so readers can gauge freshness. Refresh it on every sync. (The Quality checklist re-checks this.)
- a brief **how to read this wiki** guide (how topics/sections are organized, where to start),
- **flat depth** — the topic list can live directly on the landing page (by definition it's still short); on top of it, only if the relationship graph would stay legibly small, add a "how the topics relate" Mermaid map. A skipped diagram is not a shortfall — a diagram dense enough to need squinting at is worse than no diagram, so skip rather than force one.
- **section tier** — list sections with a one-line blurb and a link to each section landing. Do **not** inline the full per-topic table here, and do **not** attempt a whole-graph Mermaid diagram at this scale — both stop being readable once there are many topics and add no value. Link instead to the dedicated topic index page below.

**Dedicated topic index page** (write only in section tier — a flat-depth wiki's landing list already covers this, so skip it there): `<root>/all-topics.md`, one comprehensive table of every topic grouped by section (`section | topic | slug | one-line summary`). This is where the exhaustive list lives; the landing page stays short regardless of how many topics exist.

If a section tier exists, also write each `<section-slug>/index.md` (section overview + its topic list).

Write `.nexis/wiki.manifest.md` (see **Manifest format** below).

## B7 — Starlight navigation (`target: starlight` only)

Skip entirely for `plain` — that target has no Astro sidebar. For `starlight`, overwrite `<output_root>/nexis-sidebar.mjs` (project root, sibling to `astro.config.mjs` — **not** under the content root) so the left navigation matches the wiki's own structure instead of Starlight's file-tree autogeneration (which alphabetizes pages and shows raw lower-case folder slugs as group labels — the two problems this file exists to fix).

Emit exactly `export const sidebar = <array>;`. **Enumerate every page explicitly** — one `{ label, slug }` object per page. Each entry's `slug` is the page route: the `page` path from the manifest **minus** the `src/content/docs/` prefix and the `.md` extension (e.g. `src/content/docs/foundation/core.md` → `foundation/core`). Deriving slugs straight from the `page` values you just wrote to the manifest guarantees they resolve to real pages (an unresolvable `slug` fails the build).

**Never use `autogenerate`.** Starlight removed support for a labelled `autogenerate` group (`{ label, autogenerate: { directory } }`) in v0.39+, and it will hard-fail the build with "Support for autogenerated sidebar groups was removed." Autogenerate would also re-alphabetize the pages — reintroducing the exact ordering problem this file exists to fix. Do not emit the `autogenerate` key anywhere in this file under any circumstance; list the pages by hand.

Order and labels are yours to set — do not let Starlight derive them:
- **Ordering** follows the wiki's intended reading order (foundation/overview topics first, then what builds on them — the same order the manifest topic table is in), never alphabetical.
- **Labels** are the human topic/section names (Title Case), never the kebab slug.
- **Flat depth**: a flat array of `{ label, slug }` in reading order, plus a trailing `{ label: 'All Topics', slug: 'all-topics' }` only if that page exists.
- **Section tier**: one `{ label: '<Section Name>', items: [ … ] }` group per section (sections in reading order, topics within each in reading order), each `items` an explicit list of `{ label, slug }` (never `autogenerate`), then a trailing top-level `{ label: 'All Topics', slug: 'all-topics' }`. Starlight group labels are not links, so make each section's landing page (`<section-slug>/index.md`) reachable by leading its `items` with `{ label: 'Overview', slug: '<section-slug>' }` — otherwise sidebar navigation can't reach the section overview.

The landing `index.md` is the splash home reached via the site title/logo; do not add it as a sidebar entry. Example (section tier):

```js
export const sidebar = [
  { label: 'Foundation', items: [
    { label: 'Overview', slug: 'foundation' },
    { label: 'Workspace Overview', slug: 'foundation/workspace-overview' },
    { label: 'Core', slug: 'foundation/core' },
  ] },
  { label: 'All Topics', slug: 'all-topics' },
];
```

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
- **added** → assign by thematic fit against each existing topic's tags and theme description (mark dirty), else drop into an **unhomed pool**. If the added batch exceeds the shard threshold, reuse `nexis:wiki-scan` (assign mode) with the existing topic definitions.

## S3 — Conservative restructure

Preserve existing slugs (human bookmarks + small diffs). Only:
- spawn a **new topic/page** when the unhomed pool coheres into a clear new theme,
- **split** a topic that has grown past the page budget into a mini-section,
- **adjust the section tier** if the topic set has grown enough that a flat list stops reading as scannable (see B3's navigability judgment, not a fixed count).
- if `--reorder "<instruction>"` was given, apply it to the Topics table row order (and section grouping, if sectioned) as a **pure permutation** — never adding, dropping, or renaming a topic in the process. This makes no topic dirty, so it never triggers S4 page regeneration; S6 picks up the new order automatically when it rewrites the landing list, `all-topics.md`, and (for `starlight`) `nexis-sidebar.mjs` from the manifest table. If the instruction names a topic/section that doesn't match anything in the current table, or would leave existing topics unplaced, stop and ask for clarification rather than guessing.

Do **not** silently re-cluster, rename, or move notes between existing topics. When accumulated drift is large, add a **drift hint** to the report suggesting `/nexis:wiki --rebuild`.

## S4 — Regenerate dirty pages only

Re-spawn `nexis:wiki-page` for each dirty topic and each new topic, passing its **current active** note-ID set (same task contract as B4). The writer regenerates the whole page from its note set — no surgical prose-patching. Untouched topics' pages are left byte-for-byte.

## S5 — Reconcile

Same as B5, over the dirty/new pages. Re-spawn any that failed.

## S5.5 — Validate Mermaid diagrams (required)

Same as **B5.5** — run `scripts/mermaid-lint.mjs --root <content_root> --project <output_root> --fix` and don't proceed until it reports zero remaining. (Scanning the whole content root is fine and cheap; untouched pages just re-validate as clean.)

## S6 — Home reduce + manifest

Regenerate `<root>/index.md` (`<root>` = content root, per Step 1.5) — and any section landings, and the dedicated `all-topics.md` if section tier is active — using **fresh summaries** from the writers that just ran + **cached summaries** from the manifest for untouched topics. Same shape as B6: a short orienting landing (diagram only if it would stay legible), the exhaustive table only on `all-topics.md` once in section tier. Refresh the italicized generated-at line to the current sync time. If this sync is what tips the wiki from flat into section tier, create `all-topics.md` now. Update `.nexis/wiki.manifest.md`: `last_synced`, fingerprints, note map, `depth`, and any new/split topics.

For `target: starlight`, also rewrite `<output_root>/nexis-sidebar.mjs` per **B7** to reflect any added / split / removed topics and section-tier changes (preserve slug order for untouched topics).

**Report:** notes added / retired / removed, pages updated, topics created or split, section-tier changes, any reorder applied, and a drift hint if warranted.

---

## Manifest format

`.nexis/wiki.manifest.md`:

```markdown
---
output_root: .nexis/wiki
target: plain
last_synced: <ISO8601>
shard_threshold: 1500
depth: flat
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

`depth` is `flat` or `sectioned`, set whenever B3/S3 decide the tier — it lets sync know without re-deriving whether `all-topics.md` should exist and whether the landing page should carry the full table or a short section list. The cached `summary` column doubles as each topic's theme description once B6 has run once — reuse it (alongside `tags`) for S2/S3 reassignment reasoning and for any `nexis:wiki-scan` assign-mode reuse on sync. No separate field is persisted for it. In `sectioned` depth, the section a topic belongs to is derived from its `page` path prefix (`<section-slug>/...`) rather than a dedicated column.

For a `target: starlight` project, `output_root` names the Astro project root and `page` paths include the fixed content prefix, e.g.:

```markdown
---
output_root: wiki
target: starlight
last_synced: <ISO8601>
shard_threshold: 1500
depth: flat
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
- [ ] The landing page carries the required italicized generated-at line.
- [ ] `mermaid-lint.mjs` ran (B5.5/S5.5) and reported **zero** invalid/remaining diagrams.
- [ ] The landing page stayed short — no exhaustive full-topic table and no dense relationship diagram once in section tier; both live only if warranted (table on `all-topics.md`, diagram only when it stays legible).
- [ ] Pages don't repeat the same three-heading skeleton verbatim across every topic — each page's structure was actually planned from its own notes, and decision/problem reasoning (the *why*) is woven into the narrative, not confined to an optional trailing History section.
- [ ] No orphan "Miscellaneous" page was created; unassigned notes are reported instead.
- [ ] If `--reorder` was given, the resulting Topics table order is a pure permutation (no topic added/dropped/renamed) and no page bodies were regenerated because of it.
- [ ] The manifest note map covers exactly the active notes represented in the wiki.
