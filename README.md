# nexis

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Claude Code plugin for capturing and retrieving project knowledge using the ZettelKasten method.

Work with Claude, then `/nexis:ingest` to distill the conversation into atomic, linked notes stored in your project. On an existing codebase, `/nexis:survey` bootstraps the same notes directly from the code. Later, `/nexis:recall` pulls the relevant ones back into a new conversation, `/nexis:wiki` turns them into a human-readable onboarding site (`/nexis:wiki-translate` localizes it), and `/nexis:doctor` keeps the store healthy.

Everything is plain Markdown in `.nexis/`. Commit it and the knowledge belongs to the team, not to one person's chat history.

## Installation

```bash
claude --plugin-dir ./nexis
```

Or install from the marketplace once published.

## Requirements

- **Node.js** — all skills shell out to it (for timestamps, ids, and the deterministic scripts behind survey, wiki, and doctor).
- **git** — required by `/nexis:survey` only. Every other skill works in a plain folder.

## Where to start

Pick the entry point that matches your project. After that, all projects converge on the same loop: **recall before you work, ingest after you decide.**

| Your project | Start with | Then |
|---|---|---|
| **Greenfield** — little or no code yet | `/nexis:ingest` after each design session | `/nexis:recall` before the next one |
| **Brownfield** — an existing codebase | `/nexis:survey` (add `--history` to mine the git log) | `/nexis:doctor`, then `/nexis:wiki` |
| **Non-software** — research, strategy, writing | `/nexis:ingest` | same loop; skip `survey` |

### Greenfield

There is no code to survey, so the knowledge only exists in your conversations — which is exactly what evaporates when the session ends. Run `/nexis:ingest` at the end of any session where something got decided. Once you have a handful of notes, open new sessions with `/nexis:recall <topic>` so Claude starts with the decisions you already made instead of re-litigating them. Run `/nexis:wiki` when someone else needs to get up to speed.

### Brownfield

Start with `/nexis:survey`. It reads the codebase and writes the notes a newcomer would need — architecture, module boundaries, invariants, risks — treating the code as truth and the docs as unverified hints. Add `--history` to also mine the git log for the decisions the current code can no longer show you: what was tried, reverted, and abandoned.

Then run `/nexis:doctor` to confirm the store is sound, and `/nexis:wiki` to publish it. From that point on it's the greenfield loop: `ingest` captures new decisions as you make them, and a later `/nexis:survey` re-reads only what changed in the code.

### Is nexis only for software?

Mostly, but not entirely — and the line is sharp. **`/nexis:survey` is the only skill that touches code or git.** Everything else operates on the note store alone: `ingest` reads a conversation, `recall` and `retrieve` search notes, `wiki` renders them, `doctor` validates them. None of them know or care whether your folder contains source code.

So yes — `/nexis:ingest` works for a research plan, a product strategy, or a legal analysis. The note types carry over cleanly (a `decision` is a decision; an `entity` can be a person, a vendor, or a market segment). Two honest caveats. The distillation bar is tuned for design work: it keeps settled decisions, rejected alternatives, and constraints, and discards open exploration — so a conversation that never concluded anything produces no notes, by design. And the built-in examples lean software-flavored, so on a very different domain you may want to nudge Claude on what counts as durable in your field.

---

## Skills

### `/nexis:ingest`

Distills the current conversation into atomic notes in `.nexis/`.

```
/nexis:ingest
```

Run it after any session where decisions, tradeoffs, or insights were settled. It extracts one point per note, reconciles each against what you already have (duplicate, extension, or supersession), writes the files, and updates the index. It never asks for confirmation — the completion report tells you what was created, superseded, and skipped, and why.

**Requires:** nothing but a conversation worth keeping. No git, no code.

### `/nexis:survey`

Bootstraps notes from an **existing codebase** — the brownfield counterpart to ingest. Where ingest distills conversations, survey distills the code: architecture, module boundaries, invariants, evidenced decisions, risks. **Code is the source of truth** — docs and READMEs are hints, verified against the implementation; where they disagree the code wins and the contradiction becomes a `problem` note.

It scales to large repos by never holding the codebase in one context. A deterministic inventory (file tree, package manifests, git churn) partitions the project into units; parallel sub-agents deep-dive each one under a file budget and write notes directly. Foundation units go first, so later agents link to shared concepts instead of duplicating them. Progress is checkpointed, so an interrupted survey resumes where it stopped.

On a later run it **re-surveys incrementally**: it diffs the current git state against the commit last surveyed and re-analyzes only what changed. A fresh build only *adds* notes — a code contradiction is recorded as a `contradicts` note, never an edit. On a re-survey an analyst may additionally supersede its *own* unit's stale notes (never another unit's, never ingest's) and archive units whose code is gone.

```
/nexis:survey                          # build (or resume — auto-detected)
/nexis:survey --plan                   # print the unit plan and cost estimate, write nothing
/nexis:survey --paths services/auth    # trial run scoped to a subtree
/nexis:survey --effort quick           # cheaper first pass
/nexis:survey --history                # also mine the git log for decisions
/nexis:survey --history v2.0.0         # ...bounded to a tag, SHA, or "18 months ago"
/nexis:survey --rebuild                # discard the checkpoint, start over
```

Flags:
- `--plan` — partition only; show units, agent count, and (with `--history`) what mining would cost, then stop
- `--paths <dir>` — restrict the survey to a subtree
- `--effort <quick|standard|deep>` — the single cost dial: how much each analyst reads, and how many commits history mining distills (default `standard`)
- `--history [<since>]` — also mine the git log. The bound is a git ref (`v2.0.0`, a SHA) or a git date expression (`"18 months ago"`); bare means the whole history. Across a multi-repo workspace, **a date is the form that generalizes** — a tag is meaningless in a sibling repo that never carried it, and survey refuses rather than guessing.
- `--no-history` — skip mining this run. Mining is *sticky*: once a store has been mined, later re-surveys keep it current on their own, so this is the opt-out.
- `--rebuild` — discard any checkpoint and start fresh

**Requires:**
- **git, and a git repository.** Drift detection is git-based, so survey locks each repo to a branch on first run and **refuses rather than guesses** whenever that lineage can't be trusted: no git, no repo, a branch switch, rewritten history, or a dirty working tree. Commit or stash before you run it.
- **A software project.** It reads source code; there is no non-code equivalent.
- Best on an **Opus** session — partitioning and the cross-unit weave are the judgment-heavy steps.

#### Mining the history: `--history`

Reading code tells you what a system *is*. It cannot tell you what was **tried and abandoned** — the library adopted then ripped out, the approach reverted, the subsystem deleted. That knowledge lives only in the git log, and it decays as the people who remember it leave.

`--history` recovers it through a funnel. A deterministic scanner walks the log and keeps only commits that structurally look like decisions: reverts, dependency additions and removals, subsystem deletions, breaking changes, and commit messages whose author wrote unusually much *for this project*. Measured across axios, express, and redis, that keeps **3–6% of commits**. A cheap model triages those down to a few dozen; a reasoning model reads only those, from size-capped evidence packs, and writes the notes.

Two rules keep it honest. It **never fabricates a rationale** — if neither the message nor the change makes the reason recoverable, the commit is skipped and the skip is reported, because an invented motive is indistinguishable from fact to every future reader. And it writes **one note per decision, asserting the present**, with the abandoned alternative narrated in the body and cited by SHA — no synthetic chain of historical notes for states nobody ever recorded. Reverts are the exception: a failed approach earns its own `problem` note, since its whole value is stopping the next person from re-attempting it.

The cost amortizes — the manifest records how far each repo has been mined, so the expensive archaeology is paid once and later runs mine only what's new. Mining a 13k-commit repo end to end measured well under 100k tokens.

Even without `--history` the scan still runs (it costs no model tokens) and the report tells you the yield you left on the table — *"312 high-signal commits detected, 18 of them reverts"* — so you can see what you'd get before paying for it.

### `/nexis:recall <query>`

Searches your notes and injects the relevant ones into the conversation as context. The output is a synthesized block with inline citations, plus a **Gaps** section naming what the query implies but the notes don't cover.

```
/nexis:recall auth middleware decision
/nexis:recall why did we choose postgres
/nexis:recall --mode full session token storage
```

With no arguments it derives the query from your last message. For historical questions ("why did we", "what changed", "previously") it automatically switches to `--mode full` to include superseded notes and show the whole timeline; override with `--mode current` or `--mode full`.

**Requires:** notes in `.nexis/` — so run `ingest` or `survey` at least once first.

### `/nexis:retrieve <query>`

The low-level retrieval that ingest and recall use internally. Invoke it directly to debug why a note was or wasn't found.

```
/nexis:retrieve CORS middleware
/nexis:retrieve JWT expiry --mode full
/nexis:retrieve session handling --type decision
```

Flags:
- `--mode full` — include superseded notes (default: active only)
- `--type <concept|entity|decision|problem>` — restrict to one note type

**Requires:** notes in `.nexis/`.

### `/nexis:wiki`

Projects your notes into a human-readable onboarding wiki (overview → topics → detail). The wiki is a **machine-owned derived view** — the notes stay the single source of truth, and pages are regenerated rather than hand-edited.

It auto-detects whether to **build** (no wiki yet) or **sync** (pick up note changes since last time).

```
/nexis:wiki
/nexis:wiki --out wiki --target starlight
/nexis:wiki --rebuild
/nexis:wiki --reorder "move Deployment above Authentication"
```

Flags:
- `--out <path>` — content root for the pages (default `.nexis/wiki/`); for `--target starlight` this is the Astro project root
- `--target <plain|starlight>` — output flavor. `starlight` emits Astro Starlight syntax and, if `--out` isn't already a Starlight project, scaffolds a minimal one there first — offline, no `npm create astro`, and no automatic `npm install` (run that yourself once it's scaffolded)
- `--rebuild` — discard the taxonomy and rebuild from scratch
- `--reorder "<instruction>"` — reposition existing topics or sections without touching note content, page bodies, or slugs. Needs an existing wiki; ignored alongside `--rebuild`

You can declare the path and target in your project context (a line in `CLAUDE.md`, say) instead of passing flags every time; inline flags win.

**Requires:** notes in `.nexis/`. Deriving the topic taxonomy is the reasoning-heavy step, so it's best on an **Opus** session. For `--target starlight`, a conflicting non-Starlight directory at `--out` halts the run rather than being overwritten.

### `/nexis:wiki-translate --lang <code>`

Translates a built Starlight wiki into another language — a native bilingual rewrite, not a literal machine translation. One locale per invocation.

The first time you translate into a locale it asks, once, how to handle **terminology** (translate / keep with a gloss / keep original) and **diagrams** (translate the Mermaid labels / leave them). The answer is remembered and reused on every later sync. Re-running after a `/nexis:wiki` sync retranslates only the pages that actually changed.

```
/nexis:wiki-translate --lang es
/nexis:wiki-translate --lang ja --label "日本語" --terms gloss --diagrams keep
/nexis:wiki-translate --lang es --rebuild-locale
```

Flags:
- `--lang <code>` — required; target locale (e.g. `es`, `fr`, `ja`)
- `--label "<Native name>"` — native display name; inferred from the code if omitted
- `--terms <translate|gloss|keep>` — terminology policy override
- `--diagrams <translate|keep>` — diagram-label policy override
- `--rebuild-locale` — retranslate the whole locale, ignoring change detection

**Requires:** a wiki already built with `/nexis:wiki --target starlight`. The `plain` target has no i18n mechanism to hook into, so it isn't supported.

Navigation chrome (sidebar labels, prev/next captions) stays in the default language for now — Starlight's i18n fallback renders it automatically, so the site works, it just isn't fully localized.

### `/nexis:doctor`

Health-checks the note store and repairs it. A deterministic validator scans every note and the index, so it stays fast and free no matter how many notes you have. Safe by default: it never deletes notes or edits bodies unless you ask, and anything destructive or judgment-based is reported for you to resolve.

```
/nexis:doctor                 # report only — scan and list defects, write nothing
/nexis:doctor --fix           # also apply safe repairs
/nexis:doctor --fix-content   # also revise notes left stale by a supersession or extension
```

What it checks:

- **Schema** — required fields, valid `type`/`status`, tag count and format, ISO8601 timestamps, `id` matches filename, no duplicate ids
- **Graph** — valid `rel` types, no dangling or self links, correct `decided-by`/`motivated-by` targets, back-link symmetry, `status`/`superseded_by` consistency, no supersede cycles
- **Index** — every note has a row and every row a note, and the rows match the frontmatter
- **Propagation debt** — active notes still asserting content that a newer note has since invalidated

`--fix` repairs only what is non-destructive: missing back-links, `status`/`superseded_by` mismatches, tag normalization, index reconciliation (your summaries are preserved). Everything else — dangling links, cycles, `id`/filename mismatches — is reported as a manual TODO.

`--fix-content` goes one step further and reviews each propagation-debt candidate, revising only the notes whose content is genuinely outdated, appending an `*Updated: <timestamp>*` marker so the history survives. This is the same reconciliation ingest performs going forward, applied retroactively.

**Requires:** notes in `.nexis/`. Worth running right after a first `survey`, and any time you hand-edit notes.

---

## Note format

Notes are Markdown files with YAML frontmatter in `.nexis/notes/<id>.md` — human-readable, git-diffable, and editable by hand.

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
| `entity` | A concrete thing — a module, service, component, or system |
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
| `contradicts` | records a disagreement or an alternative decision |
| `depends-on` | this concept requires the target to function correctly |
| `implements` | this is the concrete realization of the target abstraction |
| `motivated-by` | this exists because of the target (a decision or problem drove it) |
| `decided-by` | this concept was settled by the target decision note |
| `part-of` | this note is a component or sub-concern of the target |

Add a `note` field to a link whenever the reason wouldn't be obvious from the `rel` type and the two titles alone.

### Note status

| `status` | meaning |
|---|---|
| `active` | current and valid |
| `superseded` | replaced by a newer note |
| `archived` | no longer relevant, but preserved |

## Storage

Notes live in `.nexis/` at the root of your project — not inside the plugin directory — so they travel with the work.

```
<your-project>/
└── .nexis/
    ├── index.md              # compact manifest — one row per note
    ├── notes/
    │   └── <id>.md           # one file per atomic note
    ├── wiki/                 # generated wiki pages (configurable via --out)
    │   └── ...
    ├── wiki.manifest.md      # machine state for wiki sync (never rendered)
    ├── wiki-translate.manifest.md  # per-locale translation policy + sync state
    └── survey.manifest.md    # unit plan, resume checkpoint, per-repo commit
                              #   and mined-history window
```

Commit `.nexis/` to make the notes a team asset, or `.gitignore` it to keep them personal.

## Development

After editing a skill or agent file:

```
/reload-plugins
```

To validate the plugin structure:

```bash
claude plugin validate
```
