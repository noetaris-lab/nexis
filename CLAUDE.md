## What this plugin is

`nexis` is a Claude Code plugin (package scope `@noetaris`) inspired by the ZettelKasten method. Users run brainstorming or design sessions with Claude, then invoke `/nexis:ingest` to distill the conversation into atomic, linked, tagged notes stored in the project. On a brownfield codebase, `/nexis:survey` bootstraps the same store directly from the code (code as source of truth, docs as hints). Later, `/nexis:recall` performs agentic RAG over those notes to inject relevant context back into new conversations. `/nexis:wiki` projects the same notes into a human-readable onboarding wiki (overview → topics → detail) and keeps it in sync as notes evolve.

## Plugin structure

This is a Claude Code plugin — **not** an npm package. The entry point is `.claude-plugin/plugin.json`.

```
nexis/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest — name "nexis" sets the /nexis: namespace
├── agents/
│   ├── retrieval.md             # Haiku sub-agent (nexis:retrieval): index scan + graph traversal
│   ├── reconcile.md             # Sonnet sub-agent (nexis:reconcile): content-propagation review (supersession + extension + archival), shared by ingest + doctor + survey
│   ├── wiki-scan.md             # Haiku sub-agent (nexis:wiki-scan): index-shard survey/assign for large stores
│   ├── wiki-page.md             # Sonnet sub-agent (nexis:wiki-page): per-topic page writer + fidelity self-check
│   ├── wiki-translate-page.md   # Sonnet sub-agent (nexis:wiki-translate-page): per-page bilingual translator + fidelity self-check
│   ├── survey-analyst.md        # Sonnet sub-agent (nexis:survey-analyst): per-unit codebase deep-dive → notes; may supersede its own unit's prior notes on a re-survey refresh
│   ├── history-triage.md        # Haiku sub-agent (nexis:history-triage): picks the decision-bearing commits out of the scanner's candidate list; sees metadata only, never a diff
│   └── history-analyst.md       # Sonnet sub-agent (nexis:history-analyst): distils bounded commit evidence packs → decision/problem notes; reports anchor links it may not write itself
├── scripts/
│   ├── doctor.mjs               # Deterministic validator + safe repairer used by /nexis:doctor
│   ├── survey-topology.mjs      # Deterministic git introspection used by /nexis:survey (repo detection, branch/commit lock, drift diffing)
│   ├── history-mine.mjs         # Deterministic git archaeology for /nexis:survey --history — the sole source of git-history truth: `scan` applies structural rules to produce ranked candidates (metadata only), `pack` builds size-capped evidence packs. No model ever runs a git history command or sees an untruncated diff, which is what makes --history's token cost computable in advance.
│   ├── bootstrap-starlight.mjs  # Deterministic Astro Starlight project scaffold used by /nexis:wiki --target starlight; also registers additional locales for /nexis:wiki-translate (--add-locale)
│   ├── mermaid-lint.mjs         # Mermaid diagram validator/auto-fixer (real mermaid parser when node_modules present, else structural) — the /nexis:wiki QA gate, since astro-mermaid renders client-side and astro build never catches a broken diagram
│   └── link-lint.mjs            # Internal link validator + locale-prefix auto-fixer — the /nexis:wiki-translate QA gate, since translated pages inherit the source page's untouched link targets and need the /<lang>/ prefix rewritten in; also flags broken/cross-locale links it can't safely guess a fix for
├── templates/
│   └── starlight/               # Bundled minimal Starlight project template (incl. astro-mermaid so wiki-page.md's Mermaid diagrams render; a `nexis-sidebar.mjs` the orchestrator rewrites for reading-order/Title-Case nav; a `nexis-locales.mjs` i18n locale registry rewritten wholesale by /nexis:wiki-translate; `src/styles/nexis-wiki.css` widening the layout on big screens; `public/nexis-mermaid-zoom.js` for click-to-zoom/pan diagrams; and a `src/components/Pagination.astro` override that captions each Prev/Next link with its section so same-titled pages — every "Overview" — are distinguishable), copied + placeholder-patched by bootstrap-starlight.mjs
├── skills/
│   ├── ingest/
│   │   └── SKILL.md             # /nexis:ingest — distill conversation → atomic notes
│   ├── survey/
│   │   └── SKILL.md             # /nexis:survey — bootstrap notes from a brownfield codebase
│   ├── retrieve/
│   │   └── SKILL.md             # /nexis:retrieve — spawns retrieval agent; usable directly for debugging
│   ├── recall/
│   │   └── SKILL.md             # /nexis:recall — retrieve + synthesize → inject context
│   ├── wiki/
│   │   └── SKILL.md             # /nexis:wiki — build/sync a human-readable wiki from notes
│   ├── wiki-translate/
│   │   └── SKILL.md             # /nexis:wiki-translate — translate the built Starlight wiki into another language
│   └── doctor/
│       └── SKILL.md             # /nexis:doctor — health-check + repair the note store
└── CLAUDE.md
```

Skills live in `skills/<name>/SKILL.md`. Agents live in `agents/<name>.md`. The `name` field in `plugin.json` is the skill namespace prefix, so all skills are invoked as `/nexis:<skill-name>` and agents are addressed as `nexis:<agent-name>`.

## Development workflow

### Test the plugin locally

```bash
claude --plugin-dir ./nexis
```

After making changes to a skill or agent file, reload without restarting:

```
/reload-plugins
```

### Validate before distributing

```bash
claude plugin validate
```

## Note storage

Notes are written to `.nexis/` at the root of the **user's project** (not inside this plugin directory). This keeps notes co-located with the codebase so teams can commit and share them via git. Users can `.gitignore` the directory for personal notes or commit it to make notes a team asset.

```
<user-project>/
└── .nexis/
    ├── index.md            # Compact manifest — one row per note; loaded first on recall
    ├── notes/
    │   └── <id>.md         # One file per atomic note
    ├── wiki.manifest.md    # Machine state for wiki sync
    └── survey.manifest.md  # Machine state for codebase survey (unit plan + resume checkpoint)
```

A central aggregation layer (graph DB across multiple projects) is planned for a future version. The per-project format is designed to feed into it without changes.

## Note format

Each note is a Markdown file with YAML frontmatter. Notes are human-readable, git-diffable, and parseable by the retrieval agent without a separate parsing step.

```markdown
---
id: 7f3a1c
title: "CORS middleware must run before auth to handle preflight requests"
type: decision
tags: [auth, middleware, cors, security]
status: active
links:
  - id: a1b2c3
    rel: supersedes
  - id: 9d8e7f
    rel: relates_to
    note: "both deal with request pipeline ordering"
created: 2026-06-24T10:32:00Z
updated: 2026-06-24T10:32:00Z
---

The verifyJWT middleware was originally placed before the CORS handler, causing
unauthenticated preflight (OPTIONS) requests to be rejected before CORS headers
were set. Browsers require a 200 response with CORS headers on preflight — the
fix is to register the CORS middleware first in the chain.
```

**`type` values:** `concept` | `entity` | `decision` | `problem`

**`status` values:** `active` | `superseded` | `archived`

**`rel` (link relationship) types:**

| rel | meaning |
|---|---|
| `supersedes` | this note replaces the linked note (linked note gets a `superseded_by` back-link) |
| `superseded_by` | back-link written automatically on the older note |
| `extends` | adds detail to the linked note without replacing it (linked note gets an `extended_by` back-link) |
| `extended_by` | back-link written automatically on the extended note; carries a `note` recording what the extending note added/changed |
| `relates_to` | semantic neighbor — related but distinct concept |
| `contradicts` | records a disagreement or alternative decision |
| `depends-on` | this concept requires the target to function correctly |
| `implements` | this is the concrete realization of the target abstraction |
| `motivated-by` | this exists because of the target (decision or problem drove this note) |
| `decided-by` | this concept was settled by the target decision note |
| `part-of` | this note is a component or sub-concern of the target |

Add a `note` field to any link whose purpose would not be obvious from the `rel` type and the two note titles alone.

Back-links are written explicitly on both notes at ingest time so traversal is bidirectional without a full scan (`supersedes`↔`superseded_by`, `extends`↔`extended_by`).

**Content propagation:** a new note can leave other *active* notes asserting claims its content invalidated, in two ways. **Supersession:** superseding a note can leave referrers asserting claims derived from the overridden note. **Extension:** a note that `extends` another (leaving it `active`) may still change a surface fact the extended note embeds — a rename, a corrected value, a narrowed scope — so the extended note's body silently goes stale. In both cases ingest hands the affected notes to the `nexis:reconcile` sub-agent, which reviews each active note against the newer one and — only for those whose content is now inaccurate — revises the body (and title if needed), appends an in-body `*Updated: <ISO8601> — <reason>*` marker (stacked markers preserve history), bumps `updated`, and annotates the link with a `note` (for extensions, recording that the correction is applied inline so retrieval can skip the extending note). Purely-additive extensions and still-accurate referrers are left untouched. `status` never changes; links are not repointed. The same agent performs the retroactive review under `/nexis:doctor --fix-content`. See ingest Step 3.5 and `agents/reconcile.md`.

## Index format

`.nexis/index.md` is a compact manifest loaded first by the retrieval agent. It contains a `last_ingested` timestamp (used by ingest to scope the conversation) and one row per note.

```markdown
---
last_ingested: 2026-06-24T10:32:00Z
---

| id | title | type | tags | status | summary |
|----|-------|------|------|--------|---------|
| 7f3a1c | CORS middleware must run before auth | decision | auth,middleware,cors | active | verifyJWT before CORS breaks preflight; fix by reordering middleware |
```

## Retrieval architecture

Retrieval is split across two layers:

**`/nexis:retrieve` (skill with `context: fork`)** — runs the retrieval task in the `nexis:retrieval` Haiku sub-agent. The skill body is the task; the agent file body is the system prompt. Can be invoked directly by users for debugging.

**`retrieval.agent.md` (Haiku agent)** — does the actual work in four phases:

1. **Index scan** — reads `index.md`, applies status filter (`mode: current` drops superseded rows), applies optional type filter, selects up to 10 candidate IDs by semantic relevance
2. **Load candidates** — reads the full `.nexis/notes/<id>.md` for each candidate
3. **Graph traversal** — follows typed edges with a budget of 10 additional notes:
   - `extends`, `contradicts`, `motivated-by`, `decided-by` — always follow, budget-exempt
   - `supersedes` chains — follow only in `mode: full`
   - `extended_by` — budget-gated; its `note` may say the extending note's change is already reflected inline, in which case it is skipped outside `mode: full`
   - `relates_to`, `depends-on`, `implements`, `part-of` — budget-gated; relevance-assessed before loading
4. **Return** — structured list of notes (with `type` in headers) + relevance reasoning

**Model allocation:**

| component | model | reason |
|---|---|---|
| `/nexis:ingest` | Sonnet | judgment-heavy: atomicity, supersedes-vs-extends decisions, tag selection |
| `/nexis:recall` | Sonnet | synthesis and context injection require nuanced reasoning |
| `/nexis:retrieve` | Sonnet (shell only) | just reads a file and spawns the agent |
| `retrieval.agent.md` | Haiku | mechanical: index scan, structured graph traversal, well-defined output |
| `/nexis:wiki` | Session model — prefer **Opus** | orchestrator: taxonomy derivation is the most reasoning-heavy step (skills inherit the session model, so this is a recommendation, not a hard-coded field) |
| `wiki-scan.md` | Haiku | mechanical: index-shard tag stats and note→topic labeling |
| `wiki-page.md` | Inherits the session/orchestrator model (no pinned `model:`) | human-facing narrative synthesis + Mermaid + fidelity self-check — a Sonnet session keeps it cheap, an Opus session lifts page/diagram quality; the user picks quality-vs-budget once at the session level |
| `/nexis:wiki-translate` | Session model — prefer **Sonnet/Opus** | orchestrator: per-locale policy resolution, hash-based delta detection, delegation |
| `wiki-translate-page.md` | Sonnet (Opus for highest-quality docs) | native-quality bilingual rewriting + Mermaid identifier-preservation self-check — judgment-heavy, not mechanical |
| `scripts/bootstrap-starlight.mjs` | None (deterministic Node) | copies + placeholder-patches a bundled minimal Starlight scaffold; offline, no `npm create astro`, no `npm install`; also registers additional i18n locales (`--add-locale`) on an existing project |
| `scripts/mermaid-lint.mjs` | None (deterministic Node; loads the real `mermaid` parser when installed) | diagram validation is exact via the actual parser and free; no model should eyeball Mermaid syntax |
| `scripts/link-lint.mjs` | None (deterministic Node) | locale-prefix rewriting and route-existence checks are exact string/set operations; no model should hand-fix link paths |
| `/nexis:doctor` | Session model — prefer **Sonnet/Opus** | orchestrator: runs the validator, then delegates Tier-3 propagation judgment |
| `scripts/doctor.mjs` | None (deterministic Node) | Tier-1/2 detection + safe repair; free and exact, scales to any note count |
| `reconcile.md` | Sonnet | judgment: is a note stale under a newer superseding/extending note, or under an archival? revise + stamp; shared by ingest + doctor + survey |
| `/nexis:survey` | Session model — prefer **Opus** | orchestrator: unit partitioning and cross-unit weave are the judgment-heavy steps; drift detection itself is deterministic (see `scripts/survey-topology.mjs` below) |
| `survey-analyst.md` | Sonnet | judgment: separating durable knowledge from code trivia; on a re-survey refresh, also judges whether its own unit's prior notes are stale enough to supersede; Haiku would flood the store |
| `scripts/survey-topology.mjs` | None (deterministic Node) | repo detection, branch/commit lock, and drift diffing are exact and free — no model ever constructs a git command for survey |
| `scripts/history-mine.mjs` | None (deterministic Node) | commit-signal rules, window resolution, and diff truncation are exact string/graph operations. This is also the token ceiling for `--history`: models only ever see what this emits |
| `history-triage.md` | Haiku | cheap, high-volume judgment: scanning hundreds of one-line candidates for the ones worth a deep read. It sees no diffs, so a small model suffices — and this is the layer that keeps the expensive one small |
| `history-analyst.md` | Sonnet | judgment-heavy: reconstructing *why* from a commit message and a capped diff, deciding when the rationale is genuinely unrecoverable (and skipping rather than inventing one), and verifying the decision still holds at HEAD |

## Wiki architecture

`/nexis:wiki` projects the atomic note **graph** into a human-readable **hierarchy** (overview → topics → detail). The wiki is a **machine-owned derived view** — notes stay the sole source of truth; pages are regenerated freely and never hand-edited. One skill auto-detects **Build** (no manifest) vs **Sync** (manifest exists); `--rebuild` forces a full rebuild.

**Orchestrator (`/nexis:wiki`, Sonnet/Opus)** — never loads note bodies in bulk. Before taxonomy work, for `target: starlight` it runs `scripts/bootstrap-starlight.mjs` to ensure the output root is a valid Starlight project — scaffolding one from a bundled template on first use, or refusing the whole run if the root is a conflicting non-Starlight directory. It then reasons over `index.md` rows, derives the topic taxonomy (iterative hypothesize → split/merge → freeze slugs), plans pages, delegates, reconciles, writes the landing page (with an italicized generated-at line) + manifest. For `target: starlight` it also rewrites `nexis-sidebar.mjs` (Step B7/S6) so the left nav uses the wiki's own reading order and Title-Case section labels rather than Starlight's alphabetized, lower-case-slug file-tree autogeneration.

**`wiki-scan.md` (Haiku)** — index-shard worker, active only above the shard threshold (default 1500 notes). `survey` mode returns tag stats/co-occurrence for taxonomy; `assign` mode labels notes given frozen topic definitions (tags plus a one-line theme description each), falling back to title/summary thematic fit when tag overlap is weak or tied. Keeps the full index out of the orchestrator's context at scale.

**`wiki-page.md` (inherits the session model)** — one per topic, spawned in parallel. Loads only its topic's notes, plans that topic's own narrative shape rather than filling in a fixed heading template, weaves decision/problem *reasoning* and lineage (`supersedes`/`motivated-by`/`contradicts`/`decided-by`) into the main prose so the page explains not just what and how but *why*, writes it up (Mermaid diagrams — following the agent's Mermaid-must-parse authoring rules — fenced code, no visible citations, portable Markdown by default / Starlight syntax when `target: starlight`), **self-checks every claim against the notes**, and returns a compact result manifest (never the page text). Oversized topics become mini-sections.

**Mermaid QA gate (`scripts/mermaid-lint.mjs`)** — because `astro-mermaid` renders diagrams client-side, `astro build` never fails on a malformed diagram; it just ships an error box. So after page generation the orchestrator runs this validator (Step B5.5/S5.5). It uses the **real `mermaid` parser** when `mermaid`+`jsdom` resolve from the target project's `node_modules` (authoritative), falling back to narrow, parser-verified **structural checks** before `npm install`. `--fix` auto-corrects the safe, empirically-confirmed failure classes (unquoted `()` in labels, reserved-word ids like `end`/`loop`, `;` in sequence text) — each fix must actually parse before it is written. Anything left invalid bounces that page back to a re-spawned `wiki-page` agent. The template ships `jsdom` as a devDependency so the authoritative path is available after install.

Adaptive depth: the orchestrator reasons about navigability rather than checking topic count against a fixed cap — flat (home + topic pages) while the topic set still reads as one scannable list, ~12 topics being a rough (not hard) point where that stops holding; past it, a section tier (home → section → topic) grouped by how topics relate. The landing page always stays a short, orienting entry point — the exhaustive per-topic table and any relationship diagram are included there only in flat depth where they stay small; once sectioned, the landing page carries just a section list and the full table moves to a dedicated `all-topics.md`, and no whole-graph diagram is attempted (it stops being legible at that scale). Sync is conservative — it appends new topics / splits oversized ones / adjusts the section tier and preserves existing slugs, emitting a drift hint to run `--rebuild` rather than silently re-clustering.

## Wiki storage

Human content is written to a **configurable content root** (precedence: inline `--out` > a path declared in the loaded project context, e.g. CLAUDE.md / AGENTS.md > the manifest's recorded root on sync > default `.nexis/wiki/`). For `target: starlight`, `output_root` names the bootstrapped Astro project root, but pages actually land under `output_root/src/content/docs/` (Starlight's fixed file-based-routing path) — the manifest's `page` values include that prefix. Machine state lives at `.nexis/wiki.manifest.md` regardless, so a doc site (e.g. Starlight) never renders it. The manifest records `output_root`, `target`, `last_synced`, `shard_threshold`, `depth` (`flat`/`sectioned`), the topic table (with cached summaries, which double as each topic's theme description for reuse in sync-time assignment), and the note→page map with per-row fingerprints. Fingerprints (`status|title|tags|summary` hash) drive cheap index-vs-manifest delta detection on sync — added / changed / removed — without reading any note bodies. Provenance lives only in the manifest note map; pages carry no visible note references.

For `target: starlight`, every bootstrapped project is **i18n-ready from scaffold time** via a machine-owned `nexis-locales.mjs` (sibling to `astro.config.mjs`, in the same never-hand-edit spirit as `nexis-sidebar.mjs`), wired into `starlight({...})` as `defaultLocale`/`locales`. The default locale is registered under Starlight's reserved `root` key, so its pages keep their existing unprefixed paths forever — adding a language later (via `/nexis:wiki-translate`) never requires moving or restructuring any existing content.

## Translation architecture

`/nexis:wiki-translate --lang <code>` projects the built Starlight wiki into another language — a further derived view of the wiki's own derived view, not of the notes. It targets `target: starlight` only (the `plain` target has no i18n mechanism to hook into) and translates one locale per invocation.

**Locale registration (`scripts/bootstrap-starlight.mjs --add-locale`)** — the same deterministic, offline script used for the initial Starlight scaffold also owns registering additional locales on an already-bootstrapped project. It rewrites `nexis-locales.mjs` wholesale (idempotent — adding an already-registered locale is a no-op) and, exactly once per project, retrofits `defaultLocale`/`locales` wiring into an `astro.config.mjs` that predates this feature. It never repeatedly edits `astro.config.mjs` on every call — only the machine-owned locale-registry file, once the initial wiring exists.

**State (`.nexis/wiki-translate.manifest.md`)** — a sibling to `.nexis/wiki.manifest.md` and `.nexis/survey.manifest.md`, exclusively owned by this skill (the base `/nexis:wiki` never reads or writes it). A `## Locales` table records each translated locale's resolved terminology/diagram policy and `last_synced`; a `## Translations` table records, per `slug` × `locale`, the translated file's path, a content hash of the *source* page it was translated from, and `translated_at`. Delta detection on sync hashes the current source pages (enumerated from `.nexis/wiki.manifest.md`'s Topics table plus synthetic landing/section entries, never a raw directory walk — the content root also holds other locales once i18n is live) and diffs by `slug`, so only pages that actually changed are retranslated; a page whose section moved (slug stable, path changed) is treated as delete-then-retranslate, not silently orphaned.

**Policy prompting** — the first time a locale is translated, the skill asks (once, in the conversation, independently for each dimension unless overridden by `--terms`/`--diagrams`) how to handle **terminology** (translate / keep-with-gloss / keep-original) and **diagrams** (translate Mermaid labels / keep original). The answer is persisted per locale and reused on every later sync without re-prompting; changing it later forces a full retranslation of that locale for consistency.

**`wiki-translate-page.md` (Sonnet)** — one per changed page, spawned in parallel, mirroring `wiki-page.md`'s load → write → self-check → compact-manifest shape. Framed explicitly as a bilingual technical writer producing a natural, native-register translation rather than a literal rendering. Applies the locale's terminology/diagram policy, translates frontmatter `title`/`description` alongside the body, and — for diagrams under `translate` policy — translates only label/message text, never node/participant/subgraph ids, with a self-check that identifier sets are unchanged (the shared Mermaid QA gate, `scripts/mermaid-lint.mjs`, only verifies *parse* validity, not this semantic-preservation rule, so it's the sub-agent's own responsibility). It deliberately leaves internal link *targets* untouched (only link text is a translation concern) — the resulting default-locale-pointing links are a mechanical problem, not a judgment one, so a script fixes them afterward rather than asking the sub-agent to reason about wiki routing.

**Link QA gate (`scripts/link-lint.mjs`)** — run after the Mermaid gate (Step 6.5), same spirit: a translated page copied from its source still has root-relative links like `/foundation/core` pointing at the default locale, since Starlight doesn't rewrite arbitrary Markdown link hrefs to match the current locale. The script walks only the just-translated `<lang>/` subtree, and for each internal (root-relative, non-asset) link checks it against the known base-locale routes (derived by walking the content root while excluding every registered locale subtree, read from `nexis-locales.mjs`). With `--fix` it rewrites the one always-safe case — a link missing this locale's prefix — by inserting `/<lang>` after the leading slash; external URLs, anchors, relative links (self-adjusting since the whole subtree shifted uniformly under `/<lang>/`), and static-asset links are left alone. A link already prefixed but pointing nowhere, or into a different locale, is reported rather than guessed at; a link broken even unprefixed is almost always a **pre-existing base-wiki defect** the translator faithfully copied, not something re-spawning a translator agent can fix, so it's surfaced in the completion report instead of looped on.

**Scope cut (v1)**: `nexis-sidebar.mjs` nav labels and `Pagination.astro` section captions stay in the default language — Starlight's built-in i18n fallback already renders default-locale chrome automatically when no per-locale `translations` are configured, so the site works, it just isn't fully localized navigation.

## Survey architecture

`/nexis:survey` bootstraps the note store from a **brownfield codebase** — the code-sourced counterpart to conversation ingest — and, on a later invocation, **incrementally re-surveys** it by diffing against the commit last surveyed. It is checkpointed (resumable if interrupted) on first run, and drift-scoped (re-analyzes only what changed) on later runs; `--rebuild` always starts fresh. Two governing principles: **code is the source of truth** (docs/READMEs are hints, verified against code; doc-vs-code contradictions become `problem` notes), and **selectivity over coverage** (durable knowledge — architecture, invariants, evidenced decisions, risks — not per-file documentation).

Because drift detection is git-based, the skill locks each repo to a branch at first survey and **refuses rather than guesses** whenever that lineage can't be trusted: git not installed, no repo found anywhere in the workspace, a legacy pre-re-survey manifest, a branch switch, rewritten history, or a dirty working tree. In a multi-repo workspace (an umbrella folder containing several independently-versioned sibling repos, each a unit's `repo_path`), any single repo failing a gate refuses the whole run.

**Orchestrator (`/nexis:survey`, prefer Opus)** — never reads source bodies. Runs a deterministic shell **inventory** (git ls-files, package manifests, churn hotspots), **partitions** the repo into analysis units (≤ ~60 files, foundation vs leaf), writes one inventory-grounded system entity note, fans out analysts, then **weaves**: resolves cross-unit `depends-on` links (analysts report deps by unit *slug*; orchestrator maps slug→entity-id via the manifest), dedups from manifests, and is the **single writer of `index.md`**. Ends with a `doctor.mjs` QA gate. It never writes `last_ingested` (that field scopes conversation ingest; clobbering it would make the next `/nexis:ingest` skip history).

**`survey-analyst.md` (Sonnet)** — one per unit, wave-ordered (≤5 concurrent): **foundation units first**, later waves briefed with the accumulated note manifest (one line per note) so shared concepts are linked, not duplicated — this is how the mental model builds incrementally without any context holding the whole project. Each analyst recons its unit's structure, reads selectively under an effort budget (`quick` ≤8 files / `standard` ≤20 / `deep` ≤40), verifies doc claims in code, applies the ingest atomicity bar plus a per-unit note cap (trivia guard), writes notes directly, and returns a compact manifest. It normally only *adds* notes — never supersedes or edits another unit's or ingest's; code that contradicts a prior note not its own yields a `contradicts` note (typed `problem` when the code appears to *violate* a decision/invariant, else a plain code-reality note), because reading code can't tell a stale note from buggy code and must not adjudicate. The one exception: on a **re-survey refresh** of a unit it already analyzed, it may supersede its *own* prior descriptive (`concept`/`entity`) notes outright, and its own prior `decision`/`problem` notes only with git-log evidence of an explicit reversal — same non-adjudication logic, narrowed to what it can safely judge about its own earlier output. Decision notes never fabricate rationale — git log evidence or an explicit "rationale not recorded". Evidence is cited as file paths, never line numbers.

**`scripts/survey-topology.mjs` (deterministic Node, no model)** — the sole source of git truth for survey. Detects repos (workspace root + depth-1 children, both plain-repo and submodule/gitlink forms), reports each one's branch/commit/dirty state, and — given the manifest's Repos table — classifies each as `unchanged | changed | new | removed | branch_mismatch | dirty | history_rewritten`, plus the changed-file list for `changed` repos. The orchestrator only ever reads this JSON; it never constructs a git command itself.

### History mining (`--history`)

Code analysis recovers what the system **is**. It structurally cannot recover what was **tried and abandoned** — the reverted approach, the ripped-out library, the deleted subsystem — because none of it is in the current tree. That knowledge lives only in the git log, and `--history` (Step 6.5, after the analyst waves, so decisions can anchor to the code notes) is how it is rescued. `--history` and `--effort` are **independent axes**: how far back the history is mined, versus how deeply each unit's code is read.

A three-layer funnel keeps it affordable, because the expensive layer must only ever see a few dozen commits:

1. **Rules (free, deterministic — `history-mine.mjs scan`).** Structural signals: reverts; a dependency *name* added or dropped (never a version bump — that distinction alone cut express's candidates from 1146 to 110); subsystem deletions; breaking-change markers; mass renames; and a commit body that is unusually long **for this repo** (an absolute bar cannot work — a multi-line body is exceptional in express at 2% of commits but routine in redis at 27%, so the threshold is the p90 of that repo's own non-empty bodies). Measured yield: **3.6–6.2%** of commits across axios / express / redis.
2. **Triage (Haiku — `history-triage`).** Reads candidate metadata only, never diffs. Picks the commits worth a deep read, capped by `--effort` (12 / 30 / 60).
3. **Distillation (Sonnet — `history-analyst`).** Reads size-capped evidence packs (~2.4k tokens each; message + stat + truncated diff, lockfiles and vendored trees excluded) and writes the notes.

Both bulk artifacts move by **file** (`scan --out`, `pack --out`), never through the orchestrator's context — the same context-starvation discipline the rest of survey follows.

**Note shape.** One note per decision, asserting the **present** state, with the abandoned alternative narrated in the body and cited by short SHA. No synthetic supersession chain is reconstructed for states that never had notes — that is archaeology theater, asserting a tidy past with a confidence nobody earned. The one exception: a **revert gets its own `problem` note**, because a failed approach is durable knowledge whose whole value is stopping the next person from re-attempting it. The hard rule is **never fabricate a rationale** — if neither the message nor the change makes the reason recoverable, the commit is skipped and the skip is reported (a plausible invented motive is indistinguishable from fact to every future reader). The analyst also verifies against HEAD that a decision still stands before asserting it, and — since it may not edit notes it does not own — *reports* the anchors it wants (`decided-by` / `motivated-by` / `relates_to`), which the orchestrator patches onto the code notes in the weave. `relates_to` is in that set deliberately: the causal rels assert the code note exists *because of* the history note, which is backwards whenever the history note post-dates what it illuminates (a revert commenting on a decision it came after), so the agent is told to pick the honest rel over the strong one.

**Amortization.** The Repos table records `history_from` / `last_mined_commit`, so the expensive full archaeology is paid once: a re-survey mines only `last_mined_commit..HEAD`, and widening a window mines only the span below `history_from`. `history_from` is the window's **start bound** (ref, date, or `root`) and never the oldest commit walked — git history is a DAG, so "ancestors of the oldest commit reached" is *not* the complement of a range (measured: 262 of axios's 2131 commits silently lost to that mistake).

**Sticky, never self-starting.** Mining never begins on its own; once a store has been mined it stays current automatically on later re-surveys (`--no-history` opts out, `--rebuild` clears the window). Even when mining is off, the free rules pass still runs so the completion report can state the yield left on the table.

**Git traps the script exists to absorb** (both verified empirically, both silent failures): `git log --since=<unparseable>` resolves the date to *now* and returns **zero** commits rather than erroring — so a typo'd window would record itself as covered while mining nothing, hence the refuse-on-unresolvable gate. And rename detection makes git read blobs, which on a **partial clone** means one network round-trip per historical blob (16.6s vs 0.029s for 2000 commits) — hence `--no-renames` everywhere, plus clone-shape detection that budgets the one content-reading pass and degrades to a subject heuristic (`dep_precision: heuristic`, reported) rather than hanging.

**State (`.nexis/survey.manifest.md`)** — a **Repos** table (`repo_path | branch | last_surveyed_commit | history_from | last_mined_commit`, one row per detected repo — a single-repo project is just this table's one-row case) plus the **Units** table (`slug | paths | kind | status | entity_id | role | repo_path | note_ids`) with per-unit `status` (`pending | done | archived`) checkpointed each wave, so an interrupted survey resumes from pending units; `entity_id` lets the weave resolve cross-unit deps on resume without re-reading notes, and `note_ids` lets a re-survey brief an analyst with its own prior output and drives the archival sweep when a unit's code disappears. The two history columns bound the span already distilled per repo (empty until first mined); frontmatter additionally carries `history_window` (the window *requested*, recorded before fan-out so a Resume honors it without the user re-passing the flag) and `effort`. Re-survey diffs the current git state against the Repos table (via `survey-topology.mjs`) to scope re-analysis to what changed, and refuses outright — rather than guessing — on any unsafe git state. Scan/pack scratch lives in `.nexis/.cache/` and is deleted at the end of the run.

## Doctor architecture

`/nexis:doctor` is the health check / linter / `fsck` for the note store. It splits work into a deterministic layer and a judgment layer so it stays cheap at any scale — the cheap pass filters, so the model only ever sees flagged candidates, never the whole store.

**`scripts/doctor.mjs` (deterministic Node, no model)** — reads every note's frontmatter + `index.md` and emits a JSON report. Detects and (with `--fix`) safely repairs:
- **Tier 1 — schema**: missing required fields, `type`/`status` vocab, tag count/format, ISO8601 timestamps, `updated >= created`, `id`↔filename, duplicate ids.
- **Tier 2 — graph/index**: `rel` vocab, dangling/self links, `decided-by`→`decision` and `motivated-by`→`decision|problem` target types, supersede back-link symmetry, `status`/`superseded_by` consistency, supersede cycles, and index↔notes drift.
- **Tier 3 — pre-filter only**: `propagation_candidates[]` — active notes whose `updated` predates a newer note that changed their meaning, each tagged with a `kind`: `supersession` (active referrers of a superseded note) or `extension` (a note later extended by a newer note that may have changed a surface fact it embeds). Keyed off the link graph, not the possibly-wrong `status` field. The script never edits these.

Safe `--fix` repairs are non-destructive: add missing back-links, correct `status`/`superseded_by`, normalize tags, reconcile the index (existing summaries preserved). It never deletes notes, edits bodies, removes links, or renames files — those are reported as **manual** TODOs.

**`/nexis:doctor` (orchestrator, Sonnet/Opus)** — runs the validator, presents grouped findings, applies safe repairs under `--fix`, and under `--fix-content` performs the Tier-3 propagation review by grouping `propagation_candidates[]` (supersession groups per superseded note, extension groups per extending note) and delegating each group to a `nexis:reconcile` agent (spawned in parallel). Report-only by default. Delegation keeps candidate bodies out of the doctor context, so the retroactive backfill scales regardless of how much debt a legacy store holds; the same agent backs ingest's Step 3.5.

## Key conventions

- **Skill frontmatter**: every `SKILL.md` must have a `description:` field so Claude knows when to invoke the skill automatically.
- **`$ARGUMENTS`**: use this placeholder in `SKILL.md` to capture text the user passes after the skill name (e.g. `/nexis:recall auth middleware decision`).
- **Retrieval modes**: `current` (default — active notes only) and `full` (includes superseded notes for historical queries). Recall auto-detects historical queries from keyword patterns but accepts an explicit `--mode` override; ingest always uses `full` during reconciliation.
- **Type filter**: `/nexis:retrieve` accepts `--type <concept|entity|decision|problem>` to restrict results. The retrieval agent applies the type filter in Phase 1 before relevance matching.
- **Recall query derivation**: if `/nexis:recall` is invoked with no arguments, it derives the query from the most recent user message in the conversation.
- **Ingest is autonomous**: ingest writes notes without prompting for user confirmation. The completion report tells the user what was created, superseded, or skipped.
- **Wiki is autonomous**: `/nexis:wiki` builds or syncs without prompting; the completion report states what was created, updated, or reported as unassigned. It is `disable-model-invocation: true` (deliberate write op, like ingest).
- **Survey is autonomous, checkpointed, and now incrementally re-surveyable**: `/nexis:survey` runs without prompting (`disable-model-invocation: true`); `--plan` previews the plan without writing, `--paths` scopes a trial run, `--effort quick|standard|deep` bounds cost (per-unit reading *and* how many commits history mining distils — one dial), `--history [<since>]` additionally mines the git log for decisions (`--no-history` opts out of the sticky behavior), `--rebuild` discards any prior checkpoint and starts fresh on the current git state. Auto-detects **Build** (no manifest) / **Resume** (units still `pending`) / **Re-survey** (all `done`, git state has drifted since `last_surveyed_commit`) from `survey.manifest.md` plus a `survey-topology.mjs` scan. It **refuses** rather than guesses on: git not installed, no repo found, a legacy pre-re-survey manifest, a branch switch, rewritten history, or a dirty tree (any one repo failing a gate refuses the whole run in a multi-repo workspace). Survey only adds notes on a fresh Build; on re-survey an analyst may additionally supersede its *own* unit's stale prior notes (never another unit's or ingest's) and archive units whose code is gone, propagating both via `nexis:reconcile`. Analysts never write `index.md`; the orchestrator is the single index writer and never touches `last_ingested`.
- **History mining is opt-in, sticky, and refuses rather than guesses**: `--history` mines the git log for decisions the code cannot show (Step 6.5). The `<since>` bound is a git ref or a git *date expression* — in a multi-repo workspace only a date generalizes, since a tag is meaningless in a sibling repo that never carried it, and survey refuses rather than falling back. It never self-starts, and never silently stops once started. It **never fabricates a rationale** — an unrecoverable "why" means the commit is skipped and the skip is reported. The rules pass is free, so even a plain `/nexis:survey` reports the yield it could have mined.
- **Wiki path/target override**: `/nexis:wiki` accepts `--out <path>`, `--target <plain|starlight>`, and `--rebuild`. Inline flags override any path/target declared in the loaded project context. For `--target starlight`, the skill first runs `scripts/bootstrap-starlight.mjs` (deterministic, offline, no `npm create astro`/`npm install`) to scaffold a minimal Starlight project at `--out` if one isn't already there; a conflicting non-Starlight directory at `--out` halts the whole run rather than being overwritten.
- **Wiki translation**: `/nexis:wiki-translate --lang <code> [--label "<Native name>"] [--terms translate|gloss|keep] [--diagrams translate|keep] [--rebuild-locale]` translates the built wiki into another language; `target: starlight` only, one locale per invocation. The terminology/diagram policy is asked once per new locale (independently per dimension, unless the flags are given) and persisted in `.nexis/wiki-translate.manifest.md`, its own manifest file that `/nexis:wiki` never touches.
- **Immutability assumption**: wiki sync detects deltas from `index.md` because notes change only via new superseding notes + status patches, never in-place body edits. In-place body edits are out of scope; `--rebuild` covers them.
- **Doctor is graduated and safe-by-default**: `/nexis:doctor` is report-only with no flags; `--fix` applies only safe deterministic Tier-1/2 repairs; `--fix-content` additionally revises stale referrers (Tier-3). It never deletes notes or history — destructive/judgment fixes are reported, not applied. It is `disable-model-invocation: true`. The deterministic layer is a shipped script (`scripts/doctor.mjs`) run via `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"`, not per-note model work, so it scales to any store size.
