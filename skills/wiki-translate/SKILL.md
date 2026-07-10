---
description: Translate the built Starlight wiki into another language as a native bilingual writer would — not literal machine translation. Invoke with `/nexis:wiki-translate --lang <code>` (e.g. `--lang es`). The first run for a new locale asks how to handle terminology and diagrams, then remembers the choice for future syncs. Re-run after `/nexis:wiki` sync to translate only pages that changed. Best run on a Sonnet/Opus session — translation fidelity is reasoning-heavy.
disable-model-invocation: true
---

You are running **nexis:wiki-translate**. You are the orchestrator: you resolve per-locale policy, detect which pages actually changed since the last translation, and delegate the writing itself to `nexis:wiki-translate-page` sub-agents. You never load or write translated page bodies yourself.

The wiki is already a **machine-owned derived view** of the notes (built by `/nexis:wiki`). A translation is a further derived view of that view — the wiki's pages are the source of truth for this skill, not the notes. You own **`.nexis/wiki-translate.manifest.md`** exclusively; you only ever *read* `.nexis/wiki.manifest.md`, never write it.

## Step 0 — Capture current timestamp

Run once; reuse the result for every `last_synced`/`translated_at` value written this session:

```bash
node -e "console.log(new Date().toISOString())"
```

Do not derive the timestamp from conversation context.

## Step 1 — Parse arguments and check preconditions

Parse `$ARGUMENTS` for:
- `--lang <code>` — **required.** Target locale code (e.g. `es`, `fr`, `ja`).
- `--label "<Native name>"` — optional. If omitted, derive the native-language name of the locale yourself (e.g. `es` → `Español`); ask the user to confirm if you're not confident about the code.
- `--terms <translate|gloss|keep>` — optional inline override for the terminology policy (see Step 2).
- `--diagrams <translate|keep>` — optional inline override for the diagram policy (see Step 2).
- `--rebuild-locale` — force a full retranslation of this locale, ignoring change detection.

Read `.nexis/wiki.manifest.md`. If it does not exist, stop and tell the user to run `/nexis:wiki --target starlight` first. If it exists but its `target` is not `starlight`, stop and explain: translation is only supported for `--target starlight` — rebuild the wiki with that target to use `/nexis:wiki-translate`. (Starlight's built-in i18n routing is what this skill relies on; the `plain` target has nothing to hook into.)

If `--lang` was not given, stop and ask which locale code to translate into.

## Step 2 — Resolve the locale and its policy

Read (or create, if this is the first-ever translation) **`.nexis/wiki-translate.manifest.md`**. Look up `--lang`'s code in its `## Locales` table.

**New locale (no row yet):**
1. Register it with the base project:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap-starlight.mjs" --root "<output_root>" --add-locale "<code>" --add-locale-label "<label>"
   ```
   `<output_root>` comes from `.nexis/wiki.manifest.md`. This is idempotent and safe to re-run; it registers the locale in the project's i18n config (retrofitting older projects the first time this is ever called against them) without touching any content.
2. Resolve **terms policy** (`translate` / `gloss` / `keep`) and **diagrams policy** (`translate` / `keep`) **independently**: use `--terms`/`--diagrams` if given; for whichever dimension has no flag, ask the user directly, in plain text, right now — briefly explain the options (e.g. "translate domain terms too, keep them in the original language with a short gloss on first use, or leave them untranslated entirely?"). If you cannot get an answer (no interactive reply available), stop and name the missing flag rather than guessing a default.
3. Hold the resolved policy **in memory only** — do not write it to the manifest yet (see Step 7).

**Existing locale (row already present):**
- Reuse its stored `terms`/`diagrams` policy unless `--terms`/`--diagrams` explicitly overrides it.
- If an override differs from the stored value, hold the new policy in memory and set `force_full = true` for this run — mixed-policy pages would read incoherently, so a policy change forces every page in this locale to be retranslated. Do not overwrite the stored policy until Step 7 succeeds.

## Step 3 — Delta detection

All paths below are relative to `output_root` (from `.nexis/wiki.manifest.md`), matching that manifest's own `page` column convention. The fixed content directory is `src/content/docs`.

**Enumerate current source pages** from `.nexis/wiki.manifest.md`'s `## Topics` table plus synthetic landing/section entries:
- one entry per Topics row: `slug` = the table's `slug`, `source_page` = the table's `page`.
- `_home` → `source_page = src/content/docs/index.md` (always).
- `_all-topics` → `source_page = src/content/docs/all-topics.md` (only if the manifest's `depth` is `sectioned`).
- `_section:<section-slug>` → `source_page = src/content/docs/<section-slug>/index.md`, one per distinct section slug (only if `depth` is `sectioned`; a section slug is the first path segment of a Topics row's `page` value after stripping the `src/content/docs/` prefix — the same derivation `/nexis:wiki`'s B7 sidebar step already uses).

For each enumerated entry, derive `target_page = source_page` with `src/content/docs/` replaced by `src/content/docs/<lang>/`.

**Hash the current source files** in one inline script call over the explicit enumerated list (never a raw directory walk — once a locale exists, the content root also holds its already-translated subfolder, and walking would try to "translate" a translation):

```bash
node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const root = process.argv[1];
const entries = JSON.parse(process.argv[2]); // { slug: source_page, ... }
const out = {};
for (const [slug, rel] of Object.entries(entries)) {
  const p = path.join(root, rel);
  out[slug] = fs.existsSync(p) ? crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex").slice(0, 8) : null;
}
console.log(JSON.stringify(out));
' "<output_root>" '<json of {slug: source_page}>'
```

**Diff by `slug`** against this locale's stored `## Translations` rows:
- **added** — enumerated slug has no stored row.
- **changed** — stored row exists, `target_page` matches the stored `page`, but the hash differs from `source_hash`.
- **moved** — stored row exists but its `page` differs from the freshly-derived `target_page` (the topic's page path shifted, e.g. a section reorganization) — treat as delete-then-translate.
- **removed** — a stored row's `slug` is no longer in the current enumeration.
- **unchanged** — everything matches; skip.

Under `--rebuild-locale` or `force_full` (Step 2), treat every enumerated slug as changed regardless of hash; `removed` is still computed normally.

If added/changed/moved/removed are all empty, report "`<lang>` translation is up to date" and stop (still bump `last_synced` on the locale row).

## Step 4 — Fan out translators

For each `added`/`changed`/`moved` slug, spawn a `nexis:wiki-translate-page` agent (spawn them together, in parallel). Pass in the task message:
- absolute source page path (`output_root/source_page`)
- absolute target page path (`output_root/target_page`)
- locale code and native label
- `terms_policy`, `diagrams_policy` (resolved in Step 2)

For each `removed` or `moved` slug, delete the stale file at its previously-recorded `page` path (relative to `output_root`) — the `moved` case gets a fresh file written at its new `target_page` by the spawn above.

Each agent translates that one page and returns a compact result manifest (see `agents/wiki-translate-page.md`) — never the translated text.

## Step 5 — Reconcile

For each planned target page, verify from the returned result manifests (do **not** bulk re-read pages) that the file exists and is non-empty. Re-spawn any failed page once, isolated. Do not proceed until reconcile passes.

## Step 6 — Validate Mermaid diagrams (required)

Same gate `/nexis:wiki` itself runs, reused unmodified — it walks the whole content root recursively regardless of locale subdirectory depth, so untouched pages and other locales just re-validate as clean:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mermaid-lint.mjs" --root "<content_root>" --project "<output_root>" --fix --json
```

(`content_root` = `output_root/src/content/docs`.) For any diagram still reported invalid, re-spawn that page's `nexis:wiki-translate-page` agent with the specific parse error. Do not proceed until the validator reports zero remaining.

## Step 6.5 — Validate internal links (required)

Root-relative internal links (e.g. `/foundation/core`) written by `wiki-page.md`/`wiki-translate-page.md` are deliberately left untouched by the translator — link *targets* are not a translation concern (see that agent's Step 3/5) — so a link copied verbatim from the source page still points at the default locale's route unless something rewrites it. This step is that rewrite, plus a general broken-link check, run once after all of this sync's pages (and any re-spawns from Step 6) are in place:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/link-lint.mjs" --content-root "<content_root>" --locales-file "<output_root>/nexis-locales.mjs" --lang "<code>" --fix --json
```

This only ever rewrites the one **mechanical, always-safe** case — an internal link missing this locale's prefix — by inserting `/<code>` after the leading slash. Everything else it finds is reported, not guessed at, since a script can't know the intended correct target:
- a link already prefixed with `/<code>/` but pointing at a route that doesn't exist,
- a link into a *different* locale's subtree,
- a link that doesn't resolve to any known page even unprefixed — almost always a **pre-existing defect in the base wiki itself** (the translator left the target untouched, so if it's broken here it was already broken in the source page). Don't re-spawn a translator over this; a re-spawn can't fix a source-page defect. Carry it into the completion report instead, so the user can address it via `/nexis:wiki` on the base wiki.

External URLs, same-page anchors, relative links, and static-asset links (images, scripts, styles) are left alone — relative links between mirrored pages stay correct on their own since the whole subtree shifted uniformly under `/<code>/`.

## Step 7 — Commit manifest state

Now that translation succeeded, write `.nexis/wiki-translate.manifest.md`:
- Upsert this locale's `## Locales` row: `code`, `label`, the resolved `terms`/`diagrams` policy, `last_synced` (Step 0 timestamp).
- For every `added`/`changed`/`moved` slug: upsert its `## Translations` row with the fresh `source_hash` (re-hash after translation if `--rebuild-locale`/`force_full` skipped the Step 3 hash comparison, so the *next* normal sync doesn't immediately re-treat everything as changed) and `translated_at`.
- For every `removed`/`moved`-away slug: drop its old `## Translations` row.

## Manifest format

`.nexis/wiki-translate.manifest.md`:

```markdown
## Locales
| code | label | terms | diagrams | last_synced |
|------|-------|-------|----------|-------------|
| es | Español | gloss | keep | 2026-07-09T12:00:00Z |

## Translations
| slug | locale | page | source_hash | translated_at |
|------|--------|------|-------------|---------------|
| auth | es | src/content/docs/es/auth.md | 9f8e7d6c | 2026-07-09T12:00:00Z |
| _home | es | src/content/docs/es/index.md | 1a2b3c4d | 2026-07-09T12:00:00Z |
```

`page` is the **translated** file's path, relative to `output_root`. If a later `/nexis:wiki --rebuild` invalidates the base wiki's slugs entirely, every stored row here will fail to match anything on the next `wiki-translate` run (→ all `removed`) while every current page looks new (→ all `added`) — this self-heals into a full retranslation with stale files cleaned up automatically; no special-case handling is needed for it.

## Scope (v1)

- **Starlight only.** The `plain` target has no i18n mechanism to hook into.
- **One language per invocation.** Run `/nexis:wiki-translate --lang <code>` once per locale you want.
- **Navigation stays in the default language.** `nexis-sidebar.mjs`'s labels and `Pagination.astro`'s section captions are not translated — Starlight's built-in i18n fallback already renders the default-locale nav automatically when no per-locale `translations` are configured, so the site still works, it just isn't fully localized chrome. This is an explicit scope cut, not an oversight.
- No `--remove-locale` flag yet.

## Completion report

Report: locale (code + label), the resolved terms/diagrams policy (and whether it changed from a prior run), pages created / updated / removed, confirmation that the Mermaid gate passed with zero remaining, and the link-lint outcome — how many locale-prefix links were auto-fixed, plus any flagged broken/cross-locale links (called out as likely pre-existing base-wiki defects, not something this run caused).
