# Shared Components Guide

> **Reusable UI components in `components/shared/`**. Use these instead of native HTML elements to maintain visual consistency, accessibility, and modal compatibility across the app.
>
> Field shapes come from the **field canon** (`lib/field-tokens.ts` — bases + modifiers, one home for the whole app), enforced by the field primitives below. The decision table for "which primitive do I need" lives in the `vibe-tavern-frontend` skill (`.agents/skills/vibe-tavern-frontend/SKILL.md`); this file is the full per-component reference.
>
> Verified against live code 2026-09-11 (full rewrite; field canon = FIELD_SYSTEM_UNIFICATION_REPORT FS-2..FS-10).

---

## Quick Reference

| Component | Replaces | File | One-line |
|-----------|----------|------|----------|
| `<Toggle>` | `<input type="checkbox">` | `Toggle.tsx` | 36×20px animated switch |
| `<Checkbox>` | `<input type="checkbox">` | `Checkbox.tsx` | Mini pill with checkmark |
| `<ToggleChips>` | Rows of checkboxes | `ToggleChips.tsx` | Multi-select chip group |
| `<SegmentedControl>` | `<select>` for 2-5 items | `SegmentedControl.tsx` | Radio pill bar |
| `<DropdownSelect>` | `<select>` | `DropdownSelect.tsx` | Searchable combobox (cmdk + Radix Popover) |
| `<TextInput>` | raw `<input>` | `text-input.tsx` | Canonical single-line input — bakes in `inputCls`; `mono` / `readOnly` modifiers compose |
| `<AutoTextarea>` | `<textarea>` | `auto-textarea.tsx` | Auto-resizing textarea; canon field base by default, `className` extends (FS-8b), `bare` = composer escape hatch |
| `<SearchInput>` | hand-rolled search shells | `SearchInput.tsx` | Search field: shell owns chrome, borderless input inside, glass icon default, `trailing` slot (clear-✕) |
| `<InlineRenameInput>` | hand-rolled rename inputs | `InlineRenameInput.tsx` | Compact inline-rename field; accent-at-rest border = edit-state marker |
| `<ChipInput>` | Custom tag input | `ChipInput.tsx` | Tag/chip input, chips inside the box; `mode="tokens"` (Shift+Enter commits) / `mode="words"` (Enter commits) |
| `<MaskedConnectionKeyField>` | forked API-key fields | `masked-connection-key-field.tsx` | Masked key input + show/hide toggle + stored-key status (STT/TTS) |
| `<NumberInput>` | `<input type="number">` | `NumberInput.tsx` | Numeric input with +/- stepper controls |
| `<CodeEditor>` | `<textarea>` for code | `CodeEditor.tsx` | CodeMirror 6 wrapper |
| `<CustomTooltip>` | `title="..."` | `Tooltip.tsx` | Dark tooltip with arrow |
| `<OverflowTooltip>` | `title="..."` on names | `OverflowTooltip.tsx` | Truncating text that tooltips only when it overflows |
| `<Modal>` | Custom dialogs | `Modal.tsx` | Radix Dialog, focus trap, scroll lock |
| `<MasterDetailModal>` | Custom two-pane modals | `MasterDetailModal.tsx` | Two-pane on desktop, drill-down stack on mobile |
| `<ConfirmCloseModal>` | Custom confirm | `confirm-close-modal.tsx` | "Discard changes?" dialog |
| `<DestructiveConfirmModal>` | Custom confirm | `destructive-confirm-modal.tsx` | "Are you sure?" for delete actions (+ optional secondary) |
| `<ActionSheet>` | Mobile action menus | `ActionSheet.tsx` | Mobile bottom-sheet action menu (portaled) |
| `<SaveBar>` / `<SaveButton>` | Custom save buttons | `SaveBar.tsx` | Sticky save button with dirty/saved state |
| `<TokenCounter>` | Custom token display | `TokenCounter.tsx` | "123 tokens" badge |
| `<EmptyState>` | Custom empty states | `empty-state.tsx` | Icon + title + CTA placeholder |
| `<LinkBindingPopover>` | Custom binding chips | `LinkBindingPopover.tsx` | Binding pills + add-trigger popover (character/persona/lorebook/script/preset/regex) |
| `<MobileExpandTextarea>` | — | `MobileExpandTextarea.tsx` | Fullscreen editor overlay on mobile |
| `<Icons.* />` / `<Ic.* />` | Emoji / SVG inline | `icons.tsx` | All UI icons as React components |
| `<Logo>` | Inline SVG | `Logo.tsx` | The `vt_sign` open-book logo mark |
| `<AiQuickPill>` | — | `AiQuickPill.tsx` | Compact AI model quick-select pill |
| `<AvatarCropModal>` | — | `AvatarCropModal.tsx` | Circular crop overlay using react-easy-crop |
| `<TextDiffPreview>` | — | `TextDiffPreview.tsx` | Side-by-side or inline text diff view |
| `<AiAssistantModal>` | — | `AiAssistantModal.tsx` | AI Assistant modal (script/lore_entry/md_import generate + AiQuickPill settings editor) |
| `textarea-helpers` | — | `textarea-helpers.ts` | Shared utilities for textarea behavior (not a component) |
| `<DiceFaces>` | per-feature dice markup | `dice-faces.tsx` | Shared 2D SVG dice renderer + pure helpers |

---

## Toggle

**File:** `Toggle.tsx`
**Replaces:** `<input type="checkbox">` for boolean settings

```tsx
<Toggle checked={enabled} onChange={setEnabled} />
```

| Prop | Type | Description |
|------|------|-------------|
| `checked` | `boolean` | Current state |
| `onChange` | `(checked: boolean) => void` | State change callback |
| `disabled` | `boolean?` | Disables interaction |
| `id` | `string?` | For `<label htmlFor>` |
| `className` | `string?` | Additional classes on wrapper |
| `aria-label` | `string?` | Accessible name when the visible label is a sibling node |

Built on Radix Switch: `role="switch"`, `aria-checked`, focus-visible ring, Space/Enter activation. Visual: 36×20px track, thumb slides 16px, `s3` → `accent`.

**When to use:** Settings, feature toggles, any on/off option. NOT for per-row selection in lists (use circle toggles or `Checkbox`).

---

## Checkbox

**File:** `Checkbox.tsx`
**Replaces:** `<input type="checkbox">` for inline/labelled checkboxes

```tsx
<Checkbox checked={active} onChange={setActive} label="Enable feature" />
```

| Prop | Type | Description |
|------|------|-------------|
| `checked` | `boolean` | Current state |
| `onChange` | `(checked: boolean) => void` | State change callback |
| `label` | `ReactNode?` | Label text (string or JSX) — makes the whole row clickable |
| `disabled` | `boolean?` | Disables interaction |
| `id` | `string?` | For form association |
| `className` | `string?` | Additional classes |

Mini-chip checkbox: tiny rounded pill indicator consistent with ToggleChips. Unchecked: subtle `s3` pill. Checked: accent border + bg with SVG checkmark.

**When to use:** Inline checkboxes with labels, form fields, option toggles. Use `ToggleChips` for multi-select lists of options.

---

## ToggleChips

**File:** `ToggleChips.tsx`
**Replaces:** Rows of checkboxes for multi-select option lists

```tsx
<ToggleChips
  selected={activeTriggers}
  options={[
    { value: "on_message", label: "On Message" },
    { value: "on_activate", label: "On Activate" },
    { value: "on_character_change", label: "On Char Change" },
  ]}
  onChange={setActiveTriggers}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `selected` | `string[]` | Currently selected values |
| `options` | `{ value: string, label: string }[]` | Available options |
| `onChange` | `(selected: string[]) => void` | Updated selection |
| `disabled` | `boolean?` | Disables all chips |
| `className` | `string?` | Additional classes on wrapper |

Built on `@radix-ui/react-toggle-group` (`type="multiple"`): `aria-pressed` per chip, one Tab stop for the whole group, arrow-key navigation. Pills `px-3 py-1 text-[12px]`; selected = accent border + bg + text.

**When to use:** Trigger/source lists, filter toggles, tag selection. NOT for single-select (use `SegmentedControl` or `DropdownSelect`).

---

## SegmentedControl

**File:** `SegmentedControl.tsx`
**Replaces:** `<select>` for small option sets (2–5 items)

```tsx
<SegmentedControl
  value={logic}
  options={[
    { value: "AND_ALL", label: "AND ALL" },
    { value: "AND_ANY", label: "AND ANY" },
    { value: "NOT_ALL", label: "NOT ALL" },
  ]}
  onChange={setLogic}
/>
```

Generic over `T extends string` — values keep their literal union type through the callback.

| Prop | Type | Description |
|------|------|-------------|
| `value` | `T` | Selected value |
| `options` | `{ value: T, label: string }[]` | Available options |
| `onChange` | `(value: T) => void` | Selection change |
| `disabled` | `boolean?` | Disables interaction |
| `compact` | `boolean?` | Smaller size for tight spaces (11px text, less padding) |
| `dense` | `boolean?` | Even shorter on mobile than `compact` (28px vs 36px touch height), identical desktop sizing — narrowly scoped for in-card controls like the canvas role selector |
| `className` | `string?` | Additional classes |

All options visible at once — one click to select; `role="radiogroup"` + `aria-checked`. Active segment: `bg-s2` + accent text + shadow on `bg-s3` track.

**When to use:** 2–5 mutually exclusive options. For 6+ options, use `DropdownSelect`. For multi-select, use `ToggleChips`.

---

## DropdownSelect

**File:** `DropdownSelect.tsx`
**Replaces:** `<select>` for large option lists

```tsx
<DropdownSelect
  value={modelId}
  options={models.map(m => ({ id: m.id, label: m.name }))}
  placeholder="Select model..."
  searchPlaceholder="Search models..."
  defaultOption=""
  onChange={setModelId}
/>
```

Built on **cmdk (Command) + Radix Popover** — a real searchable combobox. cmdk keeps the search input focused while arrow keys move the active item (roving via `aria-activedescendant`), so typing ↔ arrow ↔ typing just works. (The previous Radix Select implementation could not do this — its focus-roving keyboard model conflicted with the search input; the cmdk rebuild fixed it.)

| Prop | Type | Description |
|------|------|-------------|
| `value` | `string` | Selected value (empty string = default option) |
| `options` | `{ id: string, label: ReactNode, detail?: string, trailing?: ReactNode }[]` | Available options |
| `groups` | `{ id: string, label?: string, options: DropdownOption[] }[]?` | Grouped rendering (e.g. "Favorites" above "All models"); search filters within every group |
| `placeholder` | `string?` | Trigger text when nothing selected |
| `searchPlaceholder` | `string?` | Search input placeholder |
| `defaultOption` | `string?` | Value for the "empty/default" choice |
| `onChange` | `(value: string) => void` | Selection change |
| `searchable` | `boolean?` | Search input in the popup (default: `true`) |
| `disabled` | `boolean?` | Disables interaction |
| `className` | `string?` | Additional classes on trigger |

**Key details:**
- **Modal-aware** — portals into `#modal-portal` (via `getModalPortal()`) when inside a Dialog, so the popup renders within the focus trap.
- **Empty-value sentinel** — cmdk cannot represent `""` as a selectable item; an internal sentinel stands in and maps back to `""` on select.
- **ReactNode labels** — labels may carry icons; they simply never match a search query (they stay visible instead of silently disappearing).
- **Trailing actions** — optional per-option trailing node (e.g. rename/delete icons); pointer events are stopped so tapping the action does not also select the option.
- Trigger defaults to `w-full` (form shape); inline/footer slots need `w-auto max-w-…`.

**When to use:** 6+ mutually exclusive options, model/provider selection, any dropdown that needs search.

---

## TextInput

**File:** `text-input.tsx`
**Replaces:** raw `<input>` + hand-rolled classes — the canonical single-line field

```tsx
// Bare = the canon by definition (inputCls from lib/field-tokens.ts):
<TextInput value={name} onChange={e => setName(e.target.value)} placeholder="Name..." />

// Mono variant for keys/IDs/patterns (monoMod composes; mono never carries a size):
<TextInput mono value={apiKey} onChange={e => setApiKey(e.target.value)} />

// react-hook-form uncontrolled:
<TextInput register={register("title")} placeholder={t("lore_entry_title")} />

// Extension composes AFTER the base (never replaces — FS-8b contract):
<TextInput className="w-[180px]" ... />
```

`TextInputProps` = all native input props minus `className`, plus:

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string?` | Extension appended AFTER the canon base (`cn(inputCls, …, className)`); extend with non-conflicting classes or `!`-overrides |
| `mono` | `boolean?` | Composes `monoMod` (font + tracking, no size) for opaque technical content |
| `register` | `UseFormRegisterReturn?` | react-hook-form register — spread after passthrough so RHF handlers win when both are present |

Read-only styling is automatic: the standard HTML `readOnly` attribute appends `readonlyMod` (cursor + dimming). `type` defaults to `"text"`.

**Why a primitive:** the app previously had ~45 raw `<input className={inputCls}>` sites, each a typo away from a style fork. The canon lives in the primitive; callers compose.

---

## MaskedConnectionKeyField

**File:** `masked-connection-key-field.tsx`
**Replaces:** the mechanically identical STT/TTS API-key field forks (P11)

Masked write-only key input + show/hide eye toggle + "empty keeps stored key" status line. Built on `TextInput` mono with `!pr-10` reserving the eye-toggle gutter. The LLM header keeps its plain password field (it has neither the toggle nor the stored-status line — unifying it would change its markup, not share it).

| Prop | Type | Description |
|------|------|-------------|
| `value` / `onChange` | `string` / `(value: string) => void` | Current key input |
| `placeholder` | `string?` | Write-mode placeholder |
| `stored` | `boolean?` | A key is stored server-side (drives the status line) |
| `fieldTestId` / `toggleTestId` / `statusTestId` | `string` | Caller-owned test ids — rendered ids stay byte-identical |
| `storedPlaceholder` / `storedStatus` / `showLabel` / `hideLabel` | `string` | Caller-resolved i18n strings — no new copy is introduced here |

---

## AutoTextarea

**File:** `auto-textarea.tsx`
**Replaces:** `<textarea>` that needs auto-resize

```tsx
// Controlled — canon base composes by default, className EXTENDS it:
<AutoTextarea
  className="leading-relaxed"   // extension only — the base is baked in
  value={text}
  onChange={e => setText(e.target.value)}
  minRows={3}
  maxRows={10}
/>

// Uncontrolled (react-hook-form):
<AutoTextarea register={register("description")} minRows={5} />

// Mono variant (monoMod composes; the mono never carries a size):
<AutoTextarea mono value={pattern} onChange={e => setPattern(e.target.value)} />

// Composer family — bare opts out of the field base entirely:
<AutoTextarea
  bare
  className={cn(composerCls, "w-full !px-4")}
  minRows={1}
  maxRows={6}
/>
```

Size control is **row-based** (`minRows` / `maxRows`), never pixel heights — the app drives font-size through user-adjustable CSS variables, so rows scale with the font while a pixel cap would fight the user. The lib throws at runtime on `style.minHeight` / `style.maxHeight`.

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string?` | Extension appended AFTER the base (base always composes — the FS-8b flip killed the silent-replace window) |
| `bare` | `boolean?` | Explicit no-base mode — the composer-family escape hatch; the caller's className carries everything |
| `mono` | `boolean?` | Composes `monoMod` onto the base |
| `value` / `onChange` | `string?` / `(e) => void?` | Controlled mode |
| `register` | `UseFormRegisterReturn?` | react-hook-form register — uncontrolled mode |
| `minRows` / `maxRows` | `number?` | Row-based size bounds; past `maxRows` the box scrolls internally (`overflow-y-auto` is part of the contract) |
| `disabled` | `boolean?` | Disables editing |
| `placeholder` | `string?` | Placeholder text |
| `style` | `CSSProperties?` | Inline styles — height keys are the caller's responsibility to keep out (the lib's runtime guard makes a mistake loud) |
| `macroAutocomplete` | `boolean?` | `{{`-trigger macro picker (default: on) |

**Macro autocomplete:** typing `{{` opens a floating picker of pipeline macros (last-used-first). The textarea keeps DOM focus; arrows/Enter/Escape drive the popup; select replaces the typed `{{query` at the caret via the native-value-setter + `input` dispatch, so both RHF and controlled handlers see it. Surfaces where `{{` is literal can pass `macroAutocomplete={false}`.

---

## SearchInput

**File:** `SearchInput.tsx`
**Replaces:** hand-rolled search shells (bordered box + glass icon + borderless input) and bare compact search inputs

```tsx
<SearchInput
  value={query}
  onChange={e => setQuery(e.target.value)}
  placeholder={t("search_placeholder")}
  data-testid="preset-search"
/>

// With the clear-✕ INSIDE the shell (its home — never a floating sibling):
<SearchInput
  value={query}
  onChange={e => setQuery(e.target.value)}
  trailing={query ? (
    <button type="button" aria-label={t("clear")} onClick={() => setQuery("")}>
      <Icons.Close className="h-3 w-3" />
    </button>
  ) : undefined}
/>
```

Composer philosophy: **the shell carries the chrome** — the container owns border/background/focus (`focus-within` → accent), the input inside is borderless. This is a designed compact family (dense toolbar/list headers where the standard 38–44px field height would balloon the layout), not the full-height field canon.

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string?` | Extension appended AFTER the container canon |
| `icon` | `ReactNode \| null?` | Leading icon — defaults to the search glass; pass `null` explicitly for an iconless shell |
| `trailing` | `ReactNode?` | Trailing slot INSIDE the shell (clear-✕ buttons, inline badges), after the input |

All other props (value/onChange/ref/testids/…) forward to the inner single-line `type="text"` input as-is.

---

## InlineRenameInput

**File:** `InlineRenameInput.tsx`
**Replaces:** the ~17 hand-rolled "click a name in a list row → compact input appears" shapes

```tsx
<InlineRenameInput
  autoFocus
  value={draft}
  onChange={e => setDraft(e.target.value)}
  onKeyDown={handleKey}   // Enter/Escape machine stays with the caller
  onBlur={commit}
/>
```

The canon single-line field **minus the height**, with the **accent border as the edit-state marker** — you are always inside "rename mode" while this input is visible, so the accent border is a mode signal, not a focus state.

This component owns ONLY the chrome. The commit/abort state machine stays with the caller (see `SidebarChatRename` / `SidebarBranchRename`): seeding the draft, Enter/blur commit, Escape cancel, `stopPropagation` on row clicks.

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string?` | Extension appended AFTER the canon base (e.g. `flex-1 min-w-0` inside a row) |

All native input props forward as-is (`ComponentProps<"input">`).

---

## ChipInput

**File:** `ChipInput.tsx`
**Replaces:** ad-hoc comma-separated tag fields — the ONE chip primitive

Chips live INSIDE the box (single visual field). Two modes:

- `mode="tokens"` (default) — stop-sequence semantics: Shift+Enter commits the draft, plain Enter adds a separator (tokens can contain spaces);
- `mode="words"` — tag/lore-key semantics: plain Enter commits, values are trimmed single-line words, UI font ladder.

JSON-array paste inserts every element at once in both modes.

```tsx
<ChipInput mode="words" values={keys} onChange={setKeys} placeholder={t("lore_entry_keys_placeholder")} />
```

| Prop | Type | Description |
|------|------|-------------|
| `values` | `string[]` | Current chips |
| `onChange` | `(values: string[]) => void` | Updated chips |
| `mode` | `"tokens" \| "words"?` | Chip semantics (default: `tokens`) |
| `placeholder` | `string?` | Draft-input placeholder |
| `disabled` | `boolean?` | Disables editing |
| `showPresets` | `boolean?` | Show the special-character shortcut buttons |
| `tooltip` | `string?` | Info-icon tooltip content |
| `presetsLabel` | `string?` | Label for the presets tooltip trigger (default: `"?"`) |
| `className` | `string?` | Extension appended AFTER the canon base |

---

## NumberInput

**File:** `NumberInput.tsx`
**Replaces:** `<input type="number">` for numeric settings

```tsx
<NumberInput value={priority} onChange={setPriority} min={0} max={100} step={1} />
```

| Prop | Type | Description |
|------|------|-------------|
| `value` / `onChange` | `number` / `(val: number) => void` | Controlled value |
| `min` / `max` / `step` | `number?` | Bounds and increment |
| `hideControls` | `boolean?` | Hide the +/- stepper buttons (plain input) |
| `onBlur` | `() => void?` | Blur handler |
| `disabled` | `boolean?` | Disables editing |
| `className` / `inputClassName` | `string?` | Classes on wrapper / input |

Clamps to `[min, max]` and steps by `step`. Steppers disable at the bounds.

---

## CodeEditor

**File:** `CodeEditor.tsx`
**Replaces:** `<textarea>` for JavaScript/TypeScript code

```tsx
<CodeEditor value={code} onChange={setCode} />
```

| Prop | Type | Description |
|------|------|-------------|
| `value` | `string` | Code content |
| `onChange` | `(value: string) => void` | Content change |
| `placeholder` | `string?` | Placeholder content |
| `minHeight` | `string?` | Minimum editor height (CSS length) |
| `className` | `string?` | Additional classes |
| `readOnly` | `boolean?` | Read-only mode (rebuilds the extension set) |
| `scrollMode` | `"inner" \| "page"?` | Inner scroll vs page-level scrolling |
| `extensions` | `Extension[]?` | Extra CM6 extensions, applied AFTER the built-ins; changing the array RECONFIGURES in place via a Compartment (view never remounts — scroll/cursor survive). Memoize the array. |

CodeMirror 6 with JS syntax highlighting, custom dark theme using CSS vars + oklch colors, line numbers, bracket matching. ~200KB vs Monaco's ~4MB.

---

## CustomTooltip

**File:** `Tooltip.tsx`
**Replaces:** `title="..."` attribute

```tsx
<CustomTooltip content={t("hint_text")} side="top">
  <button>...</button>
</CustomTooltip>
```

| Prop | Type | Description |
|------|------|-------------|
| `content` | `ReactNode` | Tooltip text. If falsy, renders children only (no wrapper). |
| `side` | `"top" \| "right" \| "bottom" \| "left"?` | Position (default: `"top"`) |
| `align` | `"start" \| "center" \| "end"?` | Alignment (default: `"center"`) |
| `children` | `ReactNode` | Trigger element (must accept ref) |

Dark tooltip (`bg-t1` text on `text-bg`) with arrow, 150ms fade-in, `z-[9999]`. Native titles are invisible on touch, unstyleable, and delayed — this one is instant and consistent.

**Note:** wrap the app in `<TooltipProvider>` (exported from the same file).

---

## OverflowTooltip

**File:** `OverflowTooltip.tsx`

Renders `text` in a single-line truncating div and shows a hover tooltip with the full text **only when the text actually overflows** its container — non-truncated text never gets a redundant popover.

```tsx
<OverflowTooltip text={chat.title} className="text-t1" />
```

| Prop | Type | Description |
|------|------|-------------|
| `text` | `string` | The text to display |
| `className` | `string?` | Classes on the text element (color, size); `truncate` is added automatically |
| `side` | `"top" \| "right" \| ...?` | Tooltip side; defaults to `right` (sidebar-friendly) |

Use for entity names/labels in sidebars and lists where truncation is expected but the full value should stay reachable.

---

## Modal

**File:** `Modal.tsx`
**Base:** Radix UI Dialog

```tsx
<Modal open={showSettings} onClose={() => setShowSettings(false)}>
  <div className="w-[500px] rounded-xl border border-border2 bg-surface p-6 shadow-[0_24px_60px_rgba(0,0,0,.5)]">
    {/* Your modal content — the panel chrome is the canon panel shape */}
  </div>
</Modal>
```

`Modal` is the overlay/centering wrapper — the CALLER renders the styled panel. Canon panel chrome: `rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]` (`border-border` + no shadow is the classic novelty bug — see the skill's chrome tables).

| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Controls visibility |
| `onClose` | `() => void` | Called on Escape, overlay click |
| `children` | `ReactNode` | Modal content (styled panel) |
| `overlayClassName` | `string?` | Extra classes on overlay (use `"z-[700]"` for nested modals) |
| `compact` | `boolean?` | Force centered on mobile (small confirm dialogs); default: fullscreen on mobile |
| `hideOverlay` | `boolean?` | Skip overlay rendering (nested modals sharing the parent overlay) |
| `title` | `string?` | Accessible title for Radix Dialog (visually hidden) |

**Key behaviors:** focus trap (Tab cycles within), scroll lock, Escape to close, overlay click prevented. Mobile: fullscreen edge-to-edge by default.

**Portal anchor:** renders `<div id="modal-portal">` inside Dialog.Content; `DropdownSelect` portals its popup inside the focus trap via `getModalPortal()`.

**Nested modals:** `overlayClassName="z-[700]"` + `hideOverlay` on the inner modal.

---

## MasterDetailModal

**File:** `MasterDetailModal.tsx` — a responsive master/detail layout inside a `Modal`, used by the larger editor surfaces.

- **Desktop:** two-pane — master list on the left, detail panel on the right.
- **Mobile:** a single stack with drill-down navigation; `MasterDetailMobileDrillDown` is the chevron button that triggers `openDetail()`.

State is shared via context: `useMasterDetail()` returns `{ isMobile, isDetailOpen, openDetail, closeDetail }`. Call it inside a `MasterDetailModal` to drive the mobile transition (e.g. showing a back button when `isDetailOpen`).

Consumers: `ProviderModal` (provider profiles), `PromptManagerModal` (prompt presets), `PersonaModal` (personas), `ContextMemoryModal`, coauthor module/skill modals. Canonical structure: header/title/subtitle/dirty-dot/headerActions + master list (scrollable rows with `border-l-2` + active dot, dashed "+ New" docked at the list bottom — never in headerActions) + stable footer with `border-t`.

---

## ConfirmCloseModal

**File:** `confirm-close-modal.tsx`

```tsx
<ConfirmCloseModal onConfirm={handleDiscard} onCancel={handleKeepEditing} />
```

"Discard changes?" dialog. "Keep editing" is the primary (accent) button; "Close without saving" is the destructive outline button. Uses `<Modal>` with `z-[700]`.

---

## DestructiveConfirmModal

**File:** `destructive-confirm-modal.tsx`

```tsx
<DestructiveConfirmModal
  title="Delete lorebook?"
  body="This will permanently remove all entries."
  confirmLabel="Delete"
  onConfirm={handleDelete}
  onCancel={handleCancel}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `title` | `string` | Dialog title |
| `body` | `ReactNode` | Description text |
| `confirmLabel` | `string?` | Custom confirm button text |
| `onConfirm` | `() => void` | Destructive action |
| `onCancel` | `() => void` | Cancel/close |
| `secondaryLabel` + `onSecondary` | `string?` + `(() => void)?` | Optional secondary destructive action (lesser scope), rendered as outline-danger between Cancel and confirm. Both must be provided together. |

**Always use before delete/discard operations.** Cancel is the primary button; confirm is the destructive button with danger hover.

---

## ActionSheet

**File:** `ActionSheet.tsx` — a mobile bottom-sheet action menu, portaled to `document.body`. The mobile equivalent of a desktop dropdown/hover action bar (message actions, list item menus).

```tsx
<ActionSheet open={open} title="Message" items={items} onClose={close} />
```

| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Visibility |
| `title` | `string` | Sheet header |
| `items` | `ActionSheetItem[]` | Actions |
| `onClose` | `() => void` | Close handler |

Each `ActionSheetItem`: `{ icon, label, danger?, action, disabled?, trailing? }`.

- `danger` styles the row red (delete/destroy);
- `disabled` dims the row, removes it from the tab order (native `disabled` button);
- `trailing` = always-visible icon buttons at the row's right edge (mobile has no hover — e.g. per-version rename/delete); tapping one fires its own action instead of the row's; both close the sheet first so any modal they open isn't stacked.

Backdrop scrim + slide-up animation; selecting an item runs its `action` and closes.

---

## SaveBar

**File:** `SaveBar.tsx`

The public export is **`<SaveButton>`** — a save button with dirty/saved feedback states. `SaveBar` is the internal layout component (not exported). Also exports the `SaveState` type (`"idle" | "saving" | "saved" | "error"`) and the `useSaveFeedback(saving, dirty, resetKey?)` hook.

```tsx
import { SaveButton } from "../shared/SaveBar.js";

<SaveButton dirty={isDirty} saveState={saveState} onClick={handleSave} />
```

| Prop | Type | Description |
|------|------|-------------|
| `dirty` | `boolean` | Whether there are unsaved changes (button disabled when clean) |
| `saveState` | `SaveState` | Current save status |
| `onClick` | `() => void` | Save callback |
| `label` | `string?` | Custom idle label (default: i18n "Save") |
| `disabled` | `boolean?` | Hard disable |
| `className` / `style` | `string?` / `CSSProperties?` | Placement overrides |
| `size` | `"compact" \| "default" \| "touch"?` | Sizing variant |
| `resetKey` | `string \| number \| null?` | Identity for the feedback timers (switching entity/chapter resets the "Saved" flash) |
| `icon` | `ReactNode?` | Icon-only mode (mobile toolbars): renders the glyph in a 36px touch square, exposes the live state text via `aria-label`; desktop keeps the full label |

Label transitions idle → "Saving…" (disabled) → "Saved"; `useSaveFeedback` enforces minimum display times so fast saves don't flicker.

---

## TokenCounter

**File:** `TokenCounter.tsx`

```tsx
<TokenCounter text={content} />
```

| Prop | Type | Description |
|------|------|-------------|
| `text` | `string` | Text to count tokens for |
| `count` | `number \| null?` | Precomputed override — skips the hook when provided |
| `label` | `string?` | Custom label (default: i18n "tokens") |
| `className` | `string?` | Override default styling |

Uses the `useTokenCount(text)` hook which selects the appropriate tokenizer (tiktoken, web-tokenizers, or byte fallback) based on the active model.

---

## EmptyState

**File:** `empty-state.tsx`

```tsx
<EmptyState
  icon={<Icons.Inbox />}
  title="No lorebooks yet"
  sub="Create one to add world-building entries"
  cta={<button onClick={handleCreate}>Create Lorebook</button>}
  secondaryCta={<button onClick={handleImport}>Import</button>}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `icon` | `ReactNode` | Large icon |
| `title` | `string` | Primary text |
| `sub` | `string?` | Secondary description |
| `cta` | `ReactNode?` | Primary call-to-action element |
| `onCta` | `() => void?` | CTA click callback |
| `secondaryCta` | `ReactNode?` | Secondary CTA element |
| `onSecondaryCta` | `() => void?` | Secondary CTA click callback |

---

## Icons

**File:** `icons.tsx`

All UI icons are React components. Import `Ic` (the concrete map) or `Icons` (a Proxy over `Ic` that resolves PascalCase access to the kebab/lowercase keys with a fallback) — no emojis, consistent stroke width, sizing via CSS.

```tsx
import { Icons } from "./shared/icons.js";

<Icons.Copy />
<Icons.Trash />
<Icons.Branch />
<Icons.Refresh />
```

**Why not emojis:** they render differently across platforms, can't be recolored with CSS, and don't support dark mode. SVG icons are consistent, themeable, and crisp at any size.

---

## Logo

**File:** `Logo.tsx` — the `vt_sign` open-book-with-three-stars logo mark. Static by default for sidebar/branding placements. Exposes an animated variant (the loading placeholder uses it for the startup splash). Prefer importing `<Logo>` over inlining the SVG so the mark stays consistent and the animation lives in one place.

---

## MobileExpandTextarea

**File:** `MobileExpandTextarea.tsx`

```tsx
<MobileExpandTextarea value={text} onChange={setText} label="Description">
  <AutoTextarea value={text} onChange={e => setText(e.target.value)} minRows={3} />
</MobileExpandTextarea>
```

Wraps the inline field (typically `AutoTextarea`). On mobile, shows an expand button (↗) in the top-right corner; tapping opens a fullscreen editor overlay with header + "Done" button. Desktop: renders children unchanged.

| Prop | Type | Description |
|------|------|-------------|
| `value` | `string` | Current value (drives the fullscreen editor) |
| `onChange` | `(value: string) => void` | Fullscreen editor change |
| `label` | `string?` | Label in the fullscreen header |
| `children` | `ReactNode` | The inline textarea element to wrap |

**When to use:** any textarea that may need more editing space on mobile (character descriptions, lorebook entries, etc.).

---

## LinkBindingPopover

**File:** `LinkBindingPopover.tsx`
**Replaces:** ad-hoc binding chips

```tsx
<LinkBindingPopover
  links={links}
  characters={characters}
  personas={personas}
  lorebooks={lorebooks}
  onSetLinks={setLinks}
  t={t}
  isMobile={isMobile}
/>
```

Active bindings render as compact avatar pills (`h-[22px]`, `bg-s2`, `border-border`, `hover:border-danger`); the dashed trigger opens a popover with selectable avatar chips, one section per target type.

| Prop | Type | Description |
|------|------|-------------|
| `links` | `LinkBindingRecord[]` | Active bindings |
| `characters` / `personas` | `LinkTarget[]` | Available targets |
| `lorebooks` / `scripts` / `presets` / `regexes` | `LinkTarget[]?` | Optional target types (sections render only for provided arrays) |
| `onSetLinks` | `(links: LinkBindingRecord[]) => void` | Called when a pill/chip toggles |
| `t` | `(key: string) => string` | i18n resolver |
| `isMobile` | `boolean` | Larger touch targets on mobile |
| `tooltipLabel` / `emptyLabel` | `string?` | Trigger tooltip / empty-state text |
| `*SectionLabel` | `string?` | Per-type section labels (character/persona/lorebook/script/preset/regex) |
| `disabled` | `boolean?` | Disable the trigger (e.g. while a generation is in flight) |
| `showPills` | `boolean?` | Render the bound pills inline (default `true`); `false` when the caller renders the list itself and only needs the add trigger |
| `triggerLabel` | `string?` | Text label on the add trigger (labeled dashed button instead of the bare "+" circle) |

**When to use:** any UI that binds content to characters/personas/lorebooks/scripts/presets/regexes. Do not recreate these chips manually.

---

## Modal Helpers

**File:** `modal-helpers.ts`

```ts
getModalPortal(): HTMLElement | null
```

Returns the `#modal-portal` element inside the active Modal's Dialog.Content. Used by `DropdownSelect` (and any Radix-portal component that must work inside modals) so its popup renders inside the Dialog's focus trap.

**When to call:** only needed by components that use Radix Portal and need to work inside modals. If building a new Radix-based dropdown/popover for modal use, call `getModalPortal()` as the portal container.

---

## Selection Circle Pattern

For row-based selection lists (preset import, injection table), use the circle toggle pattern instead of native checkboxes:

```tsx
<button
  className={cn(
    "flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded text-[14px] transition-colors",
    enabled ? "text-accent hover:bg-accent/10" : "text-t4 hover:text-t2"
  )}
  onClick={() => toggle(index)}
  type="button"
>
  {enabled ? "●" : "○"}
</button>
```

Native checkboxes are only acceptable for functional filter toggles (e.g., "Show only selected"), not for per-row selection.

---

## textarea-helpers

**File:** `textarea-helpers.ts`
**Purpose:** shared textarea behavior utilities.

Not a React component. Keep textarea sizing/selection helper logic here instead of duplicating it across editors.

---

## AiQuickPill

**File:** `AiQuickPill.tsx`
**Purpose:** compact AI/model quick-action pill.

Use for small inline AI actions where a full button would be visually too heavy. Its settings editor is `AiAssistantModal` in `mode="quickpill"`.

---

## AvatarCropModal

**File:** `AvatarCropModal.tsx`
**Purpose:** avatar crop dialog backed by `react-easy-crop`.

Circular crop overlay with zoom/pan controls; exports a normalized square image suitable for character/persona avatars.

---

## TextDiffPreview

**File:** `TextDiffPreview.tsx`
**Purpose:** preview text changes before applying them.

Use when AI-assisted edits or bulk transformations need a visible before/after review step.

---

## AiAssistantModal

**File:** `AiAssistantModal.tsx` — the frontend of the [AI Assistant backend subsystem](./backend.md#ai-assistant). One modal with two shapes:

- **Full mode** (`mode="full"`) — the lightbulb "assist" generator. `apiMode` selects what to generate: `"script"`, `"lore_entry"`, or `"md_import"` (the markdown-card importer). Lets the user pick a provider/model, feeds the relevant context (character/persona via `scopeContext`), and returns the result via `onInsert` / `onReplace` (text modes) or `onMdImportApply` (the structured `md_import` fields). Maps to the backend modes in `MODE_CONFIGS`.
- **QuickPill mode** (`mode="quickpill"`) — the settings editor behind `<AiQuickPill>`: pick the quick-action model and toggle which options it shows (append toggle, key target, message count).

The modal persists the last-used model per mode in `localStorage` so the lightbulb actions remember their model across sessions.

---

## DiceFaces

**File:** `dice-faces.tsx` — the shared 2D SVG dice renderer for the Dice System. Consumed by `DiceTray`, `DicePanel`, and the `message-meta/dice-rolls.tsx` badge. Exports `DiceFace` (single die), `DiceFaces` (row), and the pure helpers `glyphFor(faceShape)` + `extremityTone(face, sides)`.

```tsx
<DiceFaces
  faceShape="d20"
  attempts={roll.attempts}
  notation={roll.notation}
  size="md"
  maxVisible={4}
  rollKey={String(roll.rollId)}
  excluded={!roll.included}
  onOverflowClick={() => openDetail()}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `faceShape` | `DiceFaceShape` | `d4`/`d6`/`d8`/`d10`/`d12`/`d20`/`d%` — selects the glyph silhouette (sides derived from this, never parsed from notation) |
| `faces` | `number[]?` | Flat per-die values. Mutually exclusive with `attempts`; if neither is set, renders nothing |
| `attempts` | `DiceAttempt[]?` | Flattens every attempt's `faces` into one row; use this in the tray/badge |
| `notation` | `string` | The bounded notation (e.g. `3d6+2`); used for the `aria-label` enumeration |
| `size` | `"xs" \| "sm" \| "md"` | 16 / 20 / 28px |
| `maxVisible` | `number` | Caps rendered dice; the rest collapse into a `+N more` chip |
| `rollKey` | `string` | Identity for the once-only settle gate (see below); reuse across re-renders of the SAME roll so the animation never replays |
| `excluded` | `boolean?` | Dims the whole row (`opacity-40`) — for excluded/unbound rolls |
| `onOverflowClick` | `() => void?` | When set, the `+N more` chip renders as a `<button>`; otherwise a non-interactive `<span>` |
| `loading` | `{ count: number }?` | Renders `count` skeleton glyph outlines (pulsing `--t3`) instead of values |

**Color semantics are deterministic from data only:** default `--t2`/`--t1`, the max face (`face === sides`) tints `--success-text` over `--success-dim`, the 1-face tints `--danger-text`/`--danger-dim`. The aggregate outcome is never recolored from `final.outcome`.

**Settle animation is once-per-roll:** a `useRef<Set>` of seen `rollKey`s gates the `dice-settle` class (per-die stagger via `animationDelay`). Re-rendering an existing rollKey drops the class; a fresh rollKey re-animates. Both a CSS `@media (prefers-reduced-motion: reduce)` block and a JS `window.matchMedia` guard snap to the final state under reduced motion with the `aria-live` announcement intact. `DiceFace` exposes a lower-level `tone` (`"default" | "max" | "min"`) if you need to override the auto-derived tint.

**Accessibility:** `role="list"`/`role="listitem"`, an `aria-label` enumerating every face (`dice_faces_enumeration`), and a visually-hidden full enumeration so the `+N more` overflow never hides results from screen readers. The d% glyph additionally renders a mono `%` badge.

---

## CopilotTodoPanel

**File:** `build/editors/copilot/CopilotTodoPanel.tsx` — the Experience Copilot's step-plan panel, part of the [copilot subsystem](./experience-copilot.md). Mounted in the shell's chat tab as the context meter's immediate next sibling (pinned stack: header → meter → panel → scrolling feed — it does not scroll with the feed).

- **Read-only by contract** — the plan is model-owned; the expanded tree contains exactly one button (the collapse chevron). No user editing controls exist.
- **Hidden until the first `todo` call ever happens** on the thread (`items.length === 0` → `null`).
- **Collapsed:** `[status glyph] current-title · N` + chevron; the whole row is the expand button. Current = first `active` item, falling back to first `pending` (mirrors the objective tracker's `pickActiveTask`); a fully-resolved plan shows the done label. N = remaining = `pending + active` (abandoned goals are given up, not remaining). The active glyph's dot pulses — the "live" indicator.
- **Expanded:** `Ic.target` header + i18n title + remaining count, then the full ordered list with per-status glyphs (status classes/NodeGlyph styling borrowed verbatim from `chat/message-slots/objective-zone.tsx`).
- Collapse/expand is per-mount local state (a UI toggle, deliberately NOT persisted to the store).
- Data: the shell subscribes to the turn store's `todoByThread[threadId]`; the controller seeds it from the thread wire (`todo`) on mount/switch/refetch, and live `todo` tool calls rewrite it optimistically (full-list semantics).

---

## CopilotAskCard

**File:** `build/editors/copilot/CopilotAskCard.tsx` — renders an `ask_user` activity from the [copilot](./experience-copilot.md) turn store, wherever it sits in the message feed (history anchor or live trailing turn).

- **Interactive (trailing awaiting ask):** the question, option chips (click = answer), the single `recommended` chip accent-highlighted with a star marker (defensively only when it is actually one of `options`), a free-text `AutoTextarea` with Enter-submit, and a skip button. Submitting goes through the controller's `handleAnswer` → the stream endpoint in answer mode — the answer resumes the same logical turn (no user row is ever appended).
- **Read-only states:** answered (shows the answer text), skipped (muted skip label), expired/unanswered (a later activity superseded this ask — rendered muted, non-interactive).
- State comes from the activity's `ask` payload (`{ question, options?, recommended?, status, answer? }`), produced identically by live SSE ingestion and persisted hydration (the parity parsers in the turn store are the guarantee).
