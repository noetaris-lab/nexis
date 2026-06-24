---
description: Search .nexis/ notes and inject relevant context into the current conversation. Run before starting work on a topic to surface prior decisions, tradeoffs, and insights.
---

You are running **nexis:recall**.

## Step 1 — Parse arguments

Parse `$ARGUMENTS` for:
- `--mode full` or `--mode current` — explicit retrieval mode override
- remaining text after stripping flags → query string

If the query string is empty, derive it from the most recent user message: extract key nouns, concepts, and domain terms (3–8 words; drop filler words like "the", "a", "how", "what").

## Step 2 — Determine retrieval mode

If `--mode` was given explicitly, use that value.

Otherwise auto-detect from the query: if it contains phrases suggesting historical inquiry — "history", "past", "why did we", "decision", "previously", "used to", "changed from", "what was", "original" — use `full` to include superseded notes and recover the full decision timeline. Otherwise use `current` (active notes only).

## Step 3 — Retrieve relevant notes

Invoke `/nexis:retrieve` with the query and the mode determined above.

If `.nexis/index.md` does not exist or is empty, stop here and tell the user there are no notes yet — suggest running `/nexis:ingest` after a session to start capturing context.

## Step 4 — Synthesize context

Synthesize a concise context block from the returned notes. Apply these rules:

**Ordering by type** — lead with the note types most relevant to the query's intent:
- "what did we decide / why did we choose" → lead with `decision` notes
- "what is / how does" → lead with `concept` and `entity` notes
- "what are the risks / constraints / problems" → lead with `problem` notes
- Mixed queries → decisions first, then concepts/entities, then problems

**Inline citations** — after each claim, cite the source note as `[title](id)`. Do not wait until the end to identify sources.

**Contradictions** — surface `contradicts` pairs explicitly; present both sides so the user sees the tension rather than picking one.

**Superseded notes** (mode=full only) — label them clearly as historical context, state what superseded them, and narrate the decision evolution along the `supersedes` chain.

Stay focused on what is useful for the query — do not dump all notes if only a subset is directly relevant.

## Step 5 — Identify gaps

After synthesizing, note what the query implies that the retrieved notes do not cover. A gap is a sub-question or constraint the user probably cares about that no loaded note addresses. If the notes fully cover the query, write "None identified."

## Step 6 — Present to the user

Structure the output as:

---

**Relevant context from project notes:**

<synthesized content with inline citations>

**Gaps:** <one sentence per gap, or "None identified.">

**Sources:** <note IDs and titles used>

---

If no relevant notes were found after retrieval, say so plainly and suggest running `/nexis:ingest` after the next session.
