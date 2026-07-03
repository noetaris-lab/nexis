# nexis

A Claude Code plugin for capturing and retrieving project knowledge using the ZettelKasten method.

Run a brainstorming or design session with Claude, then `/nexis:ingest` to distill it into atomic, linked notes. Later, `/nexis:recall` surfaces relevant notes as context before you start new work, `/nexis:wiki` projects the same notes into a human-readable onboarding wiki, and `/nexis:doctor` health-checks and repairs the note store.

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
/nexis:wiki --out wiki/src --target starlight
/nexis:wiki --rebuild
```

Flags:
- `--out <path>` — content root for the generated pages (default: `.nexis/wiki/`)
- `--target <plain|starlight>` — output flavor; `starlight` emits Astro Starlight syntax
- `--rebuild` — discard the existing taxonomy and rebuild from scratch

You can also declare the wiki path/target in your project context (e.g. a line in `CLAUDE.md`) instead of passing flags each time; inline flags take precedence.

### `/nexis:doctor`

Health-checks the note store and repairs it. A deterministic validator scans every note and the index, so it stays fast and free regardless of how many notes you have. Safe by default — it never deletes notes or edits bodies unless you ask, and destructive or judgment-based fixes are reported for you to resolve by hand.

```
/nexis:doctor                 # report only — scan and list defects, write nothing
/nexis:doctor --fix           # also apply safe repairs
/nexis:doctor --fix-content   # also revise notes left stale by a supersession
```

What it checks:

- **Schema** — required fields, valid `type`/`status`, tag count/format, ISO8601 timestamps, `id` matches filename, no duplicate ids
- **Graph** — valid `rel` types, no dangling or self links, correct `decided-by`/`motivated-by` targets, supersede back-link symmetry, `status`/`superseded_by` consistency, no supersede cycles
- **Index** — every note has a row and vice versa, and rows match note frontmatter
- **Propagation debt** — active notes still asserting content derived from a note that was later superseded but never revised

What `--fix` repairs automatically (all non-destructive): missing back-links, `status`/`superseded_by` mismatches, tag normalization, and index reconciliation (existing summaries preserved). Everything else — dangling links, cycles, `id`/filename mismatches — is reported as a manual TODO.

`--fix-content` additionally reviews each propagation-debt candidate and, only where the content is genuinely outdated, revises the note, appends an `*Updated: <timestamp>*` marker (preserving history), and records that the referenced note was superseded. This is the same reconciliation ingest performs going forward, applied retroactively to your existing notes.

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
    └── wiki.manifest.md      # machine state for wiki sync (never rendered)
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
