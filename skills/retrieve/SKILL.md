---
description: Find notes relevant to a query from .nexis/. Used internally by nexis:ingest and nexis:recall. Can be invoked directly to debug why a note was or was not retrieved.
context: fork
agent: nexis:retrieval
---

Parse `$ARGUMENTS` for the following flags, then execute the retrieval protocol. Strip all matched flags from the query text before passing it to the agent.

**Supported flags:**
- `--mode full` — include superseded notes (default: `current`)
- `--type <concept|entity|decision|problem>` — restrict results to this note type only

If the query is empty after stripping flags, return:
> "Please provide a query. Example: `/nexis:retrieve auth middleware decision`"

Execute the retrieval protocol with:

```
query: <query text after stripping flags>
mode: <full|current>
type: <type filter, or "any" if --type was not specified>
```

Return all retrieved notes in the standard retrieval format.
