---
description: Find notes relevant to a query from .nexis/. Used internally by nexis:ingest and nexis:recall. Can be invoked directly to debug why a note was or was not retrieved.
context: fork
agent: nexis:retrieval
---

Run the retrieval protocol on this input: $ARGUMENTS

**Before starting, parse the input above:**
- Strip `--mode full` or `--mode current` → set mode (default: `current` if not present)
- Strip `--type <concept|entity|decision|problem>` → set type filter (default: `any` if not present)
- Remaining text after stripping all flags → query

If the query is empty after stripping, return:
> "Please provide a query. Example: `/nexis:retrieve auth middleware decision`"

Then execute phases 1–4 of the retrieval protocol with the parsed query, mode, and type filter.
