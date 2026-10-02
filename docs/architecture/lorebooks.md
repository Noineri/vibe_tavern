# Lorebooks

> **`services/api/src/domain/prompt/lore-activation-engine.ts`** is the pure activation engine.
> **`services/api/src/domain/prompt/prompt-resolver.ts`** supplies the effective turn context and persists live timed state.
> **`packages/prompt-pipeline/src/build-lore-layers.ts`** maps surviving entries into prompt layers.

Lorebooks are Vibe Tavern's SillyTavern-compatible World Info system.
They activate knowledge entries from scan text, apply per-book budgets, and place the surviving content in the assembled prompt.

## Overview

A lorebook is a named collection of entries bound globally, to a character, to a persona, or to a chat.
The resolver loads every enabled binding for the active chat and passes the assembly's post-exclusion branch messages to the activation engine.
Prompt-history limits do not reduce the lore scan input.
The activation turn clock remains the full selected-branch message count.

This surface was audited against SillyTavern 1.18.0 (`8172dcd0e`, 2026-07-07).
Parity-check procedure: see the resweep report step 29.

## Data model

### Lorebook settings

`Lorebook` in `packages/domain/src/entities.ts` owns settings shared by all entries in the book.

| Setting | Behavior |
|---|---|
| `scanDepth` | Scans the most recent messages in the effective branch input, and `0` scans no chat messages. |
| `tokenBudget` / `tokenBudgetPercent` / `tokenBudgetCap` | The book uses a fixed budget when percent is null, otherwise a context-percent budget with an optional absolute cap. |
| `recursiveScanning` / `maxRecursionSteps` | Any enabled book enables recursion for the resolve, and an unlimited book lifts the merged scan-pass cap; `0` means no cap. |
| `minActivations` / `minActivationsDepthMax` | The engine uses the highest active-book values for the resolve to retry normal scanning at increasing depth until enough entries activate; `0` minimum disables retries and `0` depth maximum removes that cap. |
| `includeNames` | Prefixes scanned user and assistant messages with their real speaker names. |
| `caseSensitive` / `matchWholeWords` / `useGroupScoring` | Book defaults inherited by entries whose corresponding tri-state flag is null. |
| `overflowAlert` | Requests a live-generation warning when this book's budget drops entries. |
| `characterStrategy` | Selects the character/global portion of final insertion order: evenly, character first, or global first. |

### Entry matching and placement

`LoreEntry` has primary keys, optional secondary keys with AND/NOT logic, a priority, an ST-compatible position, and a message role.
Plain keys use case sensitivity and the whole-words setting resolved from the entry or its book.
Whole words follow SillyTavern's punctuation-inclusive `(?:^|\W)` dialect, while multi-word plain keys are substring matches.
Regex keys use exactly their authored flags and ignore those two plain-key settings.
Invalid regex keys do not activate an entry.

The **Case forms** chip is an opt-in, per-key Russian adaptation.
It compiles selected plain keys to an authored `iu` regex with Unicode letter boundaries, declension endings, fleeting-vowel handling, and interchangeable `e` and `yo` forms.
The generated regex carries a marker so only that exact generated form is recognized as a chip again on import.

New `matchSources` values default to `chat_messages`; legacy empty values retain the chat fallback as a migration guard.
Its entry-level chips can select chat messages, persona description, character description, personality, depth prompt, scenario, creator notes, Author's Note, and enabled summaries.
The one-shot quiet prompt is always scanned when present.

ST positions `before_char`, `after_char`, `before_examples`, `after_examples`, `top_an`, `bottom_an`, and `at_depth` become ordinary prompt layers.
An `outlet` entry is not a normal layer.
It contributes to a named `{{outlet::name}}` value after activation and budget filtering.
An outlet without a name is dropped.

### Activation gates and timed state

`minChatMessages` is ST's absolute `delay` gate.
While the selected branch has fewer messages than that threshold, the entry is suppressed before decorators, constants, sticky state, cooldown, and key matching.
A threshold of `0` disables the gate, and deleting messages can suppress the entry again.
The former VT-only `delayWindow` mechanic no longer exists.

Sticky and cooldown windows use anchors stored on the selected `chat_branches` row as `loreActivationStateJson`.
The engine removes timed state when the branch has not advanced past its anchor, covering swipes, regenerations, and deletions.
A live sticky window activates before cooldown and is not extended by repeat activation.
When sticky expires, its cooldown handoff starts at that expiry scan.

A dry run evaluates the existing state but does not prune timed state, commit new anchors, or persist state.
Context preview, summaries, and other one-shot callers use this behavior.
Live sends and regenerations persist the returned branch state.

## Activation flow

1. The resolver derives scan messages from the assembly's post-exclusion branch sequence and adds speaker names where known.
2. The engine flattens active books, resolves tri-state settings, and parses leading decorators from entry content.
3. It scans the entry's selected sources, separating each message, source, and recursion unit with a sentinel so regexes cannot cross seams.
4. It runs the normal pass and optionally widens the scan window for `minActivations`.
5. It runs eligible recursion and delay-until-recursion passes.
6. Each pass applies inclusion groups and probability before committing state or adding content to recursion.
7. It applies the per-book token budget and removes outlet entries from the ordinary lore stream.
8. The resolver orders ordinary entries for final insertion, resolves outlets, applies the World Info regex hook, and returns layers plus overflow metadata.

Leading `@@activate` and `@@dont_activate` decorators are parsed with ST-style escaping and are stripped before prompt injection and recursion.
Macros in keys use the full prompt macro engine at match time.
Activated content is macro-expanded only after it survives probability and is then used both for the prompt and recursion buffer.
The World Info regex hook therefore receives macro-expanded lore content.

### Recursion, groups, probability, and budget

`delayUntilRecursion` blocks the normal pass except for a live sticky entry.
Distinct recursion levels can still advance through otherwise empty passes, so delayed entries do not require a non-empty recursion buffer at every level.
The recursion-step limit counts the initial normal scan.

Group scoring removes lower-scoring eligible members before group override or weighted selection.
`useGroupScoring: null` inherits the book setting, and explicitly unflagged members remain outside that scoring removal.
Groups are resolved per pass, and a winner locks its group against later recursion candidates.

Probability runs after group resolution.
It applies to constants too, except that a previously live sticky entry automatically passes.
A failed probability roll is not retried during the same resolve.

Budgeting is per book.
Percent mode rounds the context percentage and then applies `tokenBudgetCap` only as a downward cap.
At the first non-ignored overflow, later non-ignored entries from that same book are dropped instead of using leftover space.
`ignoreBudget` entries remain eligible after that latch.

### Insertion order and outlets

Final insertion is independent of the sticky-first budget queue.
Chat-bound books lead, persona-bound books follow, and character/global books then follow the effective `characterStrategy`.
Within each block, higher priority leads, with deterministic local tie-breakers.
For mixed book sources, the strategy is taken from the most specific available binding: chat, persona, character, then global.

Activated outlet entries follow that same final ordering within each outlet name and are newline-joined.
`{{outlet::name}}` resolves to that joined text in lore and other prompt content.
A missing outlet resolves to an empty string.

## Import, export, and directory import

`packages/import-export/src/lorebooks/st-lorebook.ts` is the shared SillyTavern importer/exporter.
It maps numeric roles, ST positions, delay, recursion delay levels, group override and weight, probability switch, ignore-budget, match-source flags, tri-state matching flags, character filters, outlet names, and ST metadata.
The exporter writes the reciprocal native ST shape, including numeric roles, `characterFilter`, match flags, `groupOverride`, and `useProbability`.
Imported character-filter tags are retained for export but are not active VT filters.
A native VT character filter without preserved ST avatar metadata exports its display names.

Standalone ST world files do not contain ST global World Info settings.
Their import uses the ST global defaults declared in `st-lorebook.ts`.
Directory import reads the World Info globals from `settings.json` and applies them to every imported book.
That includes scan depth, budget settings, recursion settings, speaker names, matching defaults, group scoring, minimum activations, overflow alert, and character strategy.

Directory import binds `persona_description_lorebook` to its persona and `charLore[].extraBooks` to their characters.
It retains additional owners as lorebook links.
An explicitly selected global book stays global and enabled.
A book with no usable owner is imported as disabled global, with a diagnostic when its character owner was skipped.

Embedded Character Card V3 books are converted through the same field mapper.
A single-card import offers an embedded-book choice.
Bulk and ST-directory imports convert embedded books automatically and bind them to the imported character.

## AI key generator

`services/api/assets/lore-keys-ai-prompt.md` instructs the generator to derive keys from entry content and existing keys, never from chat or UI language.
ASCII short-key suggestions may use `\b` boundaries.
Keys containing non-ASCII letters instead use Unicode letter boundaries with `iu` flags and never use `\b`.
The generator may suggest the Case forms chip but returns only key arrays and never enables the chip itself.

## SillyTavern parity

The implementation preserves ST-compatible activation, field mapping, timing, source selection, insertion, outlets, and import/export behavior described above.
The remaining audited divergence is min-activations and recursion interleaving: VT completes its widening retries before its recursion phase, whereas ST interleaves those scan states.

## UI and persistence

`LorebookAccordion` edits book settings, including its advanced recursion, minimum-activation, and overflow controls.
`LoreEntryEditor` edits entry fields, match-source chips, and the Case forms chip.
`LorebookImportModal` handles standalone imports and the embedded-card choice.

The database keeps lorebook containers in `lorebooks`, entries in `lore_entries`, and additional character/persona bindings in `lorebook_links`.
Timed activation state belongs to `chat_branches.lore_activation_state_json`.
Prompt traces retain activated lore details and per-book overflow data for the completed turn.

## References

- `services/api/src/domain/prompt/lore-activation-engine.ts` — activation, scan construction, timing, groups, probability, budget, and outlets.
- `services/api/src/domain/prompt/prompt-resolver.ts` — effective scan input, branch-state persistence, insertion ordering, outlet resolution, and dry runs.
- `packages/prompt-pipeline/src/build-lore-layers.ts` — ordinary lore-layer position mapping.
- `packages/import-export/src/lorebooks/st-lorebook.ts` — ST and card-book conversion, import, and export.
- `services/api/src/shared/st-directory-scanner.ts` — settings globals and directory bindings.
- `packages/domain/src/russian-case-forms.ts` — Case forms compiler and round-trip marker.
- `services/api/assets/lore-keys-ai-prompt.md` — AI key-generator policy.
- `packages/domain/src/entities.ts` and `packages/db/src/db-schema.ts` — domain and storage shapes.
