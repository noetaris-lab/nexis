## What this plugin is

`nexis` is a Claude Code plugin (package scope `@noetaris`) inspired by the ZettelKasten method. Users run brainstorming or design sessions with Claude, then invoke `/nexis:ingest` to distill the conversation into atomic, linked, tagged notes stored in the project. Later, `/nexis:recall` performs agentic RAG over those notes to inject relevant context back into new conversations.

## Plugin structure

This is a Claude Code plugin — **not** an npm package. The entry point is `.claude-plugin/plugin.json`.

```
nexis/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest — name "nexis" sets the /nexis: namespace
├── agents/
│   └── retrieval.md             # Haiku sub-agent (nexis:retrieval): index scan + graph traversal
├── skills/
│   ├── ingest/
│   │   └── SKILL.md             # /nexis:ingest — distill conversation → atomic notes
│   ├── retrieve/
│   │   └── SKILL.md             # /nexis:retrieve — spawns retrieval agent; usable directly for debugging
│   └── recall/
│       └── SKILL.md             # /nexis:recall — retrieve + synthesize → inject context
└── CLAUDE.md
```

Skills live in `skills/<name>/SKILL.md`. Agents live in `agents/<name>/`. The `name` field in `plugin.json` is the skill namespace prefix, so all skills are invoked as `/nexis:<skill-name>`.

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
    ├── index.md          # Compact manifest — one row per note; loaded first on recall
    └── notes/
        └── <id>.md       # One file per atomic note
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
| `extends` | adds detail to the linked note without replacing it |
| `relates_to` | semantic neighbor — related but distinct concept |
| `contradicts` | records a disagreement or alternative decision |
| `depends-on` | this concept requires the target to function correctly |
| `implements` | this is the concrete realization of the target abstraction |
| `motivated-by` | this exists because of the target (decision or problem drove this note) |
| `decided-by` | this concept was settled by the target decision note |
| `part-of` | this note is a component or sub-concern of the target |

Add a `note` field to any link whose purpose would not be obvious from the `rel` type and the two note titles alone.

Back-links are written explicitly on both notes at ingest time so traversal is bidirectional without a full scan.

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
   - `relates_to`, `depends-on`, `implements`, `part-of` — budget-gated; relevance-assessed before loading
4. **Return** — structured list of notes (with `type` in headers) + relevance reasoning

**Model allocation:**

| component | model | reason |
|---|---|---|
| `/nexis:ingest` | Sonnet | judgment-heavy: atomicity, supersedes-vs-extends decisions, tag selection |
| `/nexis:recall` | Sonnet | synthesis and context injection require nuanced reasoning |
| `/nexis:retrieve` | Sonnet (shell only) | just reads a file and spawns the agent |
| `retrieval.agent.md` | Haiku | mechanical: index scan, structured graph traversal, well-defined output |

## Key conventions

- **Skill frontmatter**: every `SKILL.md` must have a `description:` field so Claude knows when to invoke the skill automatically.
- **`$ARGUMENTS`**: use this placeholder in `SKILL.md` to capture text the user passes after the skill name (e.g. `/nexis:recall auth middleware decision`).
- **Retrieval modes**: `current` (default — active notes only) and `full` (includes superseded notes for historical queries). Recall auto-detects historical queries from keyword patterns but accepts an explicit `--mode` override; ingest always uses `full` during reconciliation.
- **Type filter**: `/nexis:retrieve` accepts `--type <concept|entity|decision|problem>` to restrict results. The retrieval agent applies the type filter in Phase 1 before relevance matching.
- **Recall query derivation**: if `/nexis:recall` is invoked with no arguments, it derives the query from the most recent user message in the conversation.
- **Ingest is autonomous**: ingest writes notes without prompting for user confirmation. The completion report tells the user what was created, superseded, or skipped.
