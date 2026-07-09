# nexis

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Claude Code plugin for capturing and retrieving project knowledge using the ZettelKasten method.

Run a brainstorming or design session with Claude, then `/nexis:ingest` to distill it into atomic, linked notes. On an existing codebase, `/nexis:survey` bootstraps the note store directly from the code. Later, `/nexis:recall` surfaces relevant notes as context before you start new work, `/nexis:wiki` projects the same notes into a human-readable onboarding wiki (with `/nexis:wiki-translate` to localize it into other languages), and `/nexis:doctor` health-checks and repairs the note store.

## Installation

```bash
claude --plugin-dir ./nexis
```

Or install from the marketplace once published.

## Skills

### `/nexis:ingest`

Distills the current conversation into atomic notes stored in `.nexis/` at your project root.

Run this after any session where decisions, tradeoffs, or insights were discussed. It:

- Extracts atomic, standalone notes (one concept per note)
- Reconciles against existing notes — detecting duplicates, extensions, and supersessions
- Writes note files to `.nexis/notes/` and updates the index

```
/nexis:ingest
```

### `/nexis:survey`

Bootstraps atomic notes from an **existing codebase** — the brownfield counterpart to ingest. Where ingest distills conversations, survey distills the code itself: architecture, module boundaries, invariants, evidenced decisions, and risks. **Code is the source of truth** — docs and READMEs are treated as hints and verified against the implementation; where they disagree, the code wins and the contradiction is captured as a `problem` note.

It scales to large repos by never reading the codebase in one context: a deterministic shell inventory (file tree, package manifests, git churn) partitions the project into analysis units, and parallel sub-agents deep-dive each unit selectively under a file budget, writing notes directly. Foundation units (shared/core code) are surveyed first so later agents link to shared concepts instead of duplicating them. Progress is checkpointed to `.nexis/survey.manifest.md`, so an interrupted survey resumes where it stopped.

Survey checkpoints a fresh build, and on a later invocation **incrementally re-surveys**: it diffs the current git state against the commit last surveyed and re-analyzes only what changed. On a fresh build it only *adds* notes — a code contradiction with a prior note is recorded as a `contradicts` note, never edited or superseded. On a re-survey, an analyst may additionally supersede its *own* unit's stale prior notes (never another unit's or ingest's) and archive units whose code has disappeared, propagating both to referrers. Because drift detection is git-based, survey locks each repo to a branch at first survey and refuses rather than guesses on anything that would make that lineage untrustworthy — git missing, no repo found, a branch switch, rewritten history, or a dirty working tree.

```
/nexis:survey                          # build (or resume, auto-detected)
/nexis:survey --plan                   # print the unit plan and cost estimate, write nothing
/nexis:survey --paths services/auth    # trial run scoped to a subtree
/nexis:survey --depth quick            # cheaper first pass
/nexis:survey --rebuild                # discard any prior checkpoint, start over
```

Flags:
- `--plan` — partition only; show units and estimated agent count, then stop
- `--paths <dir>` — restrict the survey to a subtree
- `--depth <quick|standard|deep>` — per-unit reading/note budget (default `standard`)
- `--rebuild` — discard any prior survey checkpoint and start fresh

Notes produced are schema-identical to ingest's, so `recall`, `wiki`, and `doctor` work on them unchanged. Best run on an **Opus** session — partitioning and cross-unit weave are the judgment-heavy steps.

### `/nexis:recall <query>`

Searches your notes and injects relevant context into the conversation. Output includes a synthesized context block with inline citations and a **Gaps** section that flags what the query implies but the notes don't yet cover.

```
/nexis:recall auth middleware decision
/nexis:recall why did we choose postgres
/nexis:recall --mode full session token storage
```

Run `/nexis:recall` with no arguments to derive the query from the most recent message in the conversation.

For historical queries ("why did we", "what changed", "previously"), recall automatically uses `--mode full` to include superseded notes and show the full decision timeline. Override explicitly with `--mode current` or `--mode full`.

### `/nexis:retrieve <query>`

Low-level retrieval used internally by ingest and recall. Invoke directly to debug why a note was or wasn't found.

```
/nexis:retrieve CORS middleware
/nexis:retrieve JWT expiry --mode full
/nexis:retrieve session handling --type decision
```

Flags:
- `--mode full` — include superseded notes (default: active only)
- `--type <concept|entity|decision|problem>` — restrict results to one note type

### `/nexis:wiki`

Projects your notes into a human-readable onboarding wiki (overview → topics → detail). The wiki is a **machine-owned derived view** — notes stay the single source of truth, and pages are regenerated rather than hand-edited.

The skill auto-detects whether to **build** (no wiki yet) or **sync** (incremental update from note changes). Because it derives the topic taxonomy, it is best run on an **Opus** session.

```
/nexis:wiki
/nexis:wiki --out wiki --target starlight
/nexis:wiki --rebuild
/nexis:wiki --reorder "move Deployment above Authentication"
```

Flags:
- `--out <path>` — content root for the generated pages (default: `.nexis/wiki/`); for `--target starlight` this is the Astro project root
- `--target <plain|starlight>` — output flavor; `starlight` emits Astro Starlight syntax and, if `--out` isn't already a Starlight project, deterministically bootstraps a minimal one there first (offline, no `npm create astro`, no auto `npm install` — run that yourself once it's scaffolded)
- `--rebuild` — discard the existing taxonomy and rebuild from scratch
- `--reorder "<instruction>"` — reposition existing topics/sections on a sync without touching note content, page bodies, or slugs (a pure permutation); requires an existing wiki and is ignored if combined with `--rebuild`

You can also declare the wiki path/target in your project context (e.g. a line in `CLAUDE.md`) instead of passing flags each time; inline flags take precedence.

### `/nexis:wiki-translate --lang <code>`

Translates a built Starlight wiki into another language — a native bilingual rewrite, not a literal machine translation. It's a further derived view of the wiki (which is itself derived from the notes), so it only works with `/nexis:wiki --target starlight`; the `plain` target has no i18n mechanism to hook into. One locale per invocation.

The first time you translate into a given locale, it asks (once) how to handle **terminology** (translate / keep-with-gloss / keep-original) and **diagrams** (translate Mermaid labels / keep original); the answer is remembered and reused on every later sync. Re-running after a `/nexis:wiki` sync retranslates only the pages that actually changed.

```
/nexis:wiki-translate --lang es
/nexis:wiki-translate --lang ja --label "日本語" --terms gloss --diagrams keep
/nexis:wiki-translate --lang es --rebuild-locale
```

Flags:
- `--lang <code>` — required; target locale code (e.g. `es`, `fr`, `ja`)
- `--label "<Native name>"` — native-language display name; inferred from the code if omitted
- `--terms <translate|gloss|keep>` — terminology policy override
- `--diagrams <translate|keep>` — diagram-label policy override
- `--rebuild-locale` — force a full retranslation of this locale, ignoring change detection

Navigation chrome (sidebar labels, prev/next captions) stays in the default language in v1 — Starlight's i18n fallback renders it automatically, so the site still works, it just isn't fully localized.

### `/nexis:doctor`

Health-checks the note store and repairs it. A deterministic validator scans every note and the index, so it stays fast and free regardless of how many notes you have. Safe by default — it never deletes notes or edits bodies unless you ask, and destructive or judgment-based fixes are reported for you to resolve by hand.

```
/nexis:doctor                 # report only — scan and list defects, write nothing
/nexis:doctor --fix           # also apply safe repairs
/nexis:doctor --fix-content   # also revise notes left stale by a supersession or extension
```

What it checks:

- **Schema** — required fields, valid `type`/`status`, tag count/format, ISO8601 timestamps, `id` matches filename, no duplicate ids
- **Graph** — valid `rel` types, no dangling or self links, correct `decided-by`/`motivated-by` targets, supersede back-link symmetry, `status`/`superseded_by` consistency, no supersede cycles
- **Index** — every note has a row and vice versa, and rows match note frontmatter
- **Propagation debt** — active notes still asserting content derived from a note that was later superseded, or that extended one of them and may have changed a fact it embeds

What `--fix` repairs automatically (all non-destructive): missing back-links, `status`/`superseded_by` mismatches, tag normalization, and index reconciliation (existing summaries preserved). Everything else — dangling links, cycles, `id`/filename mismatches — is reported as a manual TODO.

`--fix-content` additionally reviews each propagation-debt candidate — both notes still referring to a now-superseded note and notes extended by a newer one — and, only where the content is genuinely outdated, revises the note, appends an `*Updated: <timestamp>*` marker (preserving history), and annotates the link. This is the same reconciliation ingest performs going forward, applied retroactively to your existing notes.

Notes are the single source of truth; the doctor treats them as such and prefers reporting over silent change.

## Note format

Notes are Markdown files with YAML frontmatter, stored in `.nexis/notes/<id>.md`. They are human-readable, git-diffable, and editable directly.

```markdown
---
id: 7f3a1c
title: "CORS middleware must run before auth to handle preflight requests"
type: decision
tags: [auth, middleware, cors]
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

### Note types

| `type` | use for |
|---|---|
| `concept` | An abstract idea, principle, constraint, or invariant |
| `entity` | A concrete thing — module, service, component, system |
| `decision` | A choice made and why; includes what was rejected |
| `problem` | A known risk, bug root cause, or constraint shaping a design |

### Link relationship types

| `rel` | meaning |
|---|---|
| `supersedes` | this note replaces the linked note |
| `superseded_by` | back-link on the older note (written automatically) |
| `extends` | adds detail without replacing |
| `extended_by` | back-link on the extended note (written automatically) |
| `relates_to` | semantic neighbor — related but distinct |
| `contradicts` | records a disagreement or alternative decision |
| `depends-on` | this concept requires the target to function correctly |
| `implements` | this is the concrete realization of the target abstraction |
| `motivated-by` | this exists because of the target (a decision or problem drove this note) |
| `decided-by` | this concept was settled by the target decision note |
| `part-of` | this note is a component or sub-concern of the target |

Add a `note` field to a link when the reason would not be obvious from the `rel` type and the two note titles alone.

### Note status

| `status` | meaning |
|---|---|
| `active` | current and valid |
| `superseded` | replaced by a newer note |
| `archived` | no longer relevant but preserved |

## Storage

Notes live in `.nexis/` at the root of your project — not inside the plugin directory. This keeps notes with the codebase so teams can share them via git.

```
<your-project>/
└── .nexis/
    ├── index.md              # compact manifest — one row per note
    ├── notes/
    │   └── <id>.md           # one file per atomic note
    ├── wiki/                 # generated wiki pages (configurable via --out)
    │   └── ...
    ├── wiki.manifest.md      # machine state for wiki sync (never rendered)
    ├── wiki-translate.manifest.md  # machine state for wiki-translate (per-locale policy + sync)
    └── survey.manifest.md    # machine state for codebase survey (unit plan + resume checkpoint)
```

Commit `.nexis/` to share notes with your team, or add it to `.gitignore` to keep notes personal.

## Development

After editing a skill or agent file:

```
/reload-plugins
```

To validate the plugin structure:

```bash
claude plugin validate
```
