---
description: Distill the current conversation into atomic ZettelKasten notes stored in .nexis/. Invoke after a brainstorming or design session to capture decisions, tradeoffs, and insights as permanent notes.
disable-model-invocation: true
---

You are running **nexis:ingest**. Distill the current conversation into atomic notes stored in `.nexis/`.

## Scope

Check `.nexis/index.md` for a `last_ingested` timestamp in its frontmatter. Process only conversation content after that timestamp. If the file or timestamp does not exist, process the entire conversation.

## Step 1 — Distill atomic candidates

Extract candidate notes from the scoped conversation. Each note must satisfy all of these rules:

**Atomic**: one concept, one point. If a note needs "and" to describe what it covers, split it.

**Standalone**: a reader with no access to this conversation can understand the note entirely from its body alone.

**Durable**: still meaningful weeks or months from now. Avoid capturing temporary states, in-progress thoughts, or decisions not yet settled.

**Good candidates:**
- Architectural decisions and the reasoning that led to them
- Tradeoffs chosen and alternatives explicitly rejected ("why not X")
- Constraints or requirements that shaped a design
- Bug root causes and their resolution approach
- Non-obvious system behaviors or invariants

**Not worth capturing:**
- Vague observations without a concrete conclusion
- Implementation details that belong in code comments
- Exploratory tangents that did not land on a decision
- Restatements of well-known or obvious facts

For each candidate, draft:
- `title`: a declarative sentence stating the point (e.g. "CORS middleware must run before auth to handle preflight requests")
- `type`: one of `concept | entity | decision | problem` (see Note Types below)
- `tags`: 2–5 lowercase keywords
- `body`: 2–5 sentences covering the point, its context, and the reasoning behind it
- `summary`: 1 sentence for the index

### Note Types

| type | use for |
|---|---|
| `concept` | An abstract idea, principle, constraint, or invariant |
| `entity` | A concrete thing — module, service, component, system |
| `decision` | A choice made and why; include what was rejected and the reasoning |
| `problem` | A known risk, bug root cause, or constraint shaping a design |

## Step 2 — Reconcile against existing notes

For each candidate note, invoke `/nexis:retrieve` passing the candidate's title and body as the query, with `--mode full` (superseded notes must be included to avoid re-creating a concept that was already captured and overridden).

Use the returned notes to determine the relationship:

| situation | action |
|---|---|
| No relevant overlap | Create as a new note |
| Existing note covers the same concept, same stance | Skip — already captured. If the candidate adds meaningful detail, create it with `rel: extends` |
| Existing note covers the same concept but candidate overrides or updates it | Create new note with `rel: supersedes`; patch old note: `status: superseded` + add `rel: superseded_by` back-link |
| Related but a distinct concept | Create with `rel: relates_to` |
| Directly contradicts an existing note | Create with `rel: contradicts` |

A note may carry multiple links of different types.

### Link Types

| rel | meaning |
|---|---|
| `supersedes` | this note replaces the linked note (linked note gets a `superseded_by` back-link) |
| `superseded_by` | back-link written automatically on the older note |
| `extends` | adds detail to the linked note without replacing it |
| `relates_to` | semantic neighbor — related but distinct concept |
| `contradicts` | records a disagreement or alternative decision |
| `depends-on` | this concept requires the target to function correctly |
| `implements` | this is the concrete realization of the target abstraction |
| `motivated-by` | this exists because of the target; use when a decision or problem drove this note |
| `decided-by` | this concept was settled by a decision note; target must have `type: decision` |
| `part-of` | this note is a component or sub-concern of the target |

Add a `note` field to any link whose purpose would not be obvious to a future reader from the `rel` type and the two note titles alone.

## Step 3 — Write note files

For each note to create, generate a collision-free ID:

```bash
node -e "console.log(require('crypto').randomBytes(3).toString('hex'))"
```

Verify `.nexis/notes/<id>.md` does not already exist before using the ID. If the file exists, run the command again until you get a unique value.

Write to `.nexis/notes/<id>.md`:

```markdown
---
id: <hex>
title: "<title>"
type: <type>
tags: [tag1, tag2]
status: active
links:
  - id: <linked-id>
    rel: <rel>
    note: "<optional: one sentence explaining why this link exists>"
created: <ISO8601 timestamp>
updated: <ISO8601 timestamp>
---

<body>
```

Omit the `note` field on a link when the reason is self-evident.

For each note being superseded, patch its `.nexis/notes/<id>.md` frontmatter in-place:
- Change `status` to `superseded`
- Append `- id: <new-id>\n    rel: superseded_by` to its `links` array
- Set `updated` to the current timestamp

## Step 4 — Update index

Ensure `.nexis/` and `.nexis/notes/` directories exist. Update `.nexis/index.md`:
- Set `last_ingested` in frontmatter to the current timestamp
- Append one row per new note
- Update the `type` and `status` columns for any patched notes

Index format:

```markdown
---
last_ingested: <ISO8601>
---

| id | title | type | tags | status | summary |
|----|-------|------|------|--------|---------|
| <id> | <title> | <type> | tag1,tag2 | active | <1-sentence summary> |
```

## Quality Checklist

Before writing the completion report, verify each note created or patched in this session:

- [ ] `id` is a 6-character lowercase hex generated via Node.js `crypto.randomBytes`, confirmed unique (no existing `.nexis/notes/<id>.md`)
- [ ] `title` is a declarative sentence — no trailing "and/or" implying multiple points
- [ ] `type` is one of `concept`, `entity`, `decision`, `problem`
- [ ] `tags` has 2–5 entries, all lowercase, no `#` prefix
- [ ] `status` is set; `created` and `updated` are both set to ISO8601 timestamps
- [ ] Body is self-contained — no "as discussed" references or pronouns without antecedents
- [ ] Every `links[].id` resolves to an existing note in `.nexis/notes/`
- [ ] Every `links[].rel` is from the Link Types vocabulary above
- [ ] `decided-by` links target a note with `type: decision`
- [ ] `motivated-by` links target a note with `type: problem` or `type: decision`
- [ ] This note appears in `index.md` with the correct `type` and `status`
- [ ] Duplicate check: no near-identical note already exists (should have been caught in Step 2, but verify)

## Completion report

When done, report: how many notes were created, how many existing notes were superseded, and how many candidates were skipped as duplicates.
