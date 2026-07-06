---
description: Distill the current conversation into atomic ZettelKasten notes stored in .nexis/. Invoke after a brainstorming or design session to capture decisions, tradeoffs, and insights as permanent notes.
disable-model-invocation: true
---

You are running **nexis:ingest**. Distill the current conversation into atomic notes stored in `.nexis/`.

## Step 0 — Capture current timestamp

Run this command once and use the result for every `created`, `updated`, and `last_ingested` field written in this session:

```bash
node -e "console.log(new Date().toISOString())"
```

Do not derive the timestamp from conversation context or training knowledge — always use the shell output.

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
| `extends` | adds detail to the linked note without replacing it (linked note gets an `extended_by` back-link) |
| `extended_by` | back-link written automatically on the extended note; carries a `note` recording what the extending note adds or changed |
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

For each existing note being **extended** by a new note (a `rel: extends` link on the new note pointing at the existing note), patch the extended note's `.nexis/notes/<id>.md` frontmatter in-place so the graph is bidirectional:
- Append `- id: <new-id>\n    rel: extended_by` to its `links` array, with a `note` field that summarizes what the new note adds or changes (e.g. `note: "renames the two agents to Guide/Analyst"`). Retrieval uses this `note` to decide whether loading the extending note is necessary, so make it specific.
- Set `updated` to the current timestamp

Leave the extended note's `status` as `active` and do not edit its body here — Step 3.5 handles any body correction.

## Step 3.5 — Propagate changes to affected notes

A new note can leave **existing active notes** asserting claims its content has invalidated. Step 3 patches only the directly-linked note's frontmatter — it never touches note *bodies* — so affected notes silently go stale. Two situations create this debt, and both are reconciled by delegating to the `nexis:reconcile` sub-agent (this keeps the affected bodies out of the ingest context and shares one review procedure with `/nexis:doctor`):

**(a) Supersession referrers.** When new note **A** supersedes note **B**, *other* active notes that link to B may still assert claims derived from B's overridden content.

For each superseded note **B**:

1. **Find referrers.** Grep `.nexis/notes/` for B's id and take the note ids from the results, excluding B itself and the superseding note A:

   ```bash
   grep -rl "<B-id>" .nexis/notes/
   ```

   If no other note references B, skip B — there is nothing to reconcile.

2. **Delegate the review.** Spawn a `nexis:reconcile` agent with a task message containing:
   - `mode`: `supersession`
   - `superseded`: B's id
   - `superseding`: A's id (or the list, if B was replaced by more than one)
   - `referrers`: the ids from step 1
   - `timestamp`: the timestamp captured in Step 0

**(b) Extended targets.** When a new note **N** `extends` an existing note **T**, N may change a surface fact that T embeds (a rename, a corrected value, a narrowed scope). Because `extends` deliberately leaves T `active` — its core point still stands — a stale surface fact in T's body would otherwise go uncorrected and surface on recall.

For each note **T** that a new note **N** extends:

1. **Delegate the review.** Spawn a `nexis:reconcile` agent with a task message containing:
   - `mode`: `extension`
   - `extending`: N's id
   - `targets`: T's id (batch multiple targets of the same N into one task)
   - `timestamp`: the timestamp captured in Step 0

In both cases the agent revises only the notes whose content is genuinely inaccurate under the newer note (appending an `*Updated:*` marker, bumping `updated`, annotating the link), leaves purely-additive or still-accurate notes untouched, and returns a compact manifest of revised vs. clean. Record each result for the completion report and the index update. Batch independent reconcile tasks in parallel.

## Step 4 — Update index

Ensure `.nexis/` and `.nexis/notes/` directories exist. Update `.nexis/index.md`:
- Set `last_ingested` in frontmatter to the current timestamp
- Append one row per new note
- Update the `type` and `status` columns for any patched notes
- Update the `title`/`summary` columns for any note whose body was revised in Step 3.5 (only if they changed)

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
- [ ] Every note extended this session carries an `extended_by` back-link to the extending note, with a specific `note` field, and its `updated` was bumped (Step 3)
- [ ] Every note superseded this session had its referrers grepped and handed to a `nexis:reconcile` agent, and every note extended this session was handed to a `nexis:reconcile` agent in `extension` mode (Step 3.5); each agent's result manifest was collected
- [ ] Any note the agent revised is reflected in the index summary update (Step 4) if its summary changed

## Completion report

When done, report: how many notes were created, how many existing notes were superseded, how many existing notes were extended, how many notes were revised by reconcile to propagate a change (supersession or extension), and how many candidates were skipped as duplicates.
