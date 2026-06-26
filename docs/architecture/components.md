# Shared Components Guide

> **Reusable UI components in `components/shared/`**. Use these instead of native HTML elements to maintain visual consistency, accessibility, and modal compatibility across the app.

---

## Quick Reference

| Component | Replaces | File | One-line |
|-----------|----------|------|----------|
| `<Toggle>` | `<input type="checkbox">` | `Toggle.tsx` | 36×20px animated switch |
| `<Checkbox>` | `<input type="checkbox">` | `Checkbox.tsx` | Mini pill with checkmark |
| `<ToggleChips>` | Rows of checkboxes | `ToggleChips.tsx` | Multi-select chip group |
| `<SegmentedControl>` | `<select>` for 2-5 items | `SegmentedControl.tsx` | Radio pill bar |
| `<DropdownSelect>` | `<select>` | `DropdownSelect.tsx` | Searchable dropdown with Radix |
| `<CustomTooltip>` | `title="..."` | `Tooltip.tsx` | Dark tooltip with arrow |
| `<Modal>` | Custom dialogs | `Modal.tsx` | Radix Dialog, focus trap, scroll lock |
| `<AutoTextarea>` | `<textarea>` | `auto-textarea.tsx` | Auto-resizing textarea |
| `<CodeEditor>` | `<textarea>` for code | `CodeEditor.tsx` | CodeMirror 6 wrapper |
| `<SaveBar>` / `<SaveButton>` | Custom save buttons | `SaveBar.tsx` | Sticky save bar with dirty/saved state. Public export is `<SaveButton>`; `SaveBar` is the internal layout component |
| `<TokenCounter>` | Custom token display | `TokenCounter.tsx` | "123 tokens" badge |
| `<LinkBindingPopover>` | Custom avatar binding chips | `LinkBindingPopover.tsx` | Compact character/persona/lorebook binding pills + popover |
| `<MobileExpandTextarea>` | — | `MobileExpandTextarea.tsx` | Fullscreen editor overlay on mobile |
| `<ConfirmCloseModal>` | Custom confirm | `confirm-close-modal.tsx` | "Discard changes?" dialog |
| `<DestructiveConfirmModal>` | Custom confirm | `destructive-confirm-modal.tsx` | "Are you sure?" for delete actions |
| `<EmptyState>` | Custom empty states | `empty-state.tsx` | Icon + title + CTA placeholder |
| `<Icons.* />` | Emoji / SVG inline | `icons.tsx` | All UI icons as React components |
| `<ChipInput>` | Custom tag input | `ChipInput.tsx` | Tag/chip input with add/remove |
| `<AiQuickPill>` | — | `AiQuickPill.tsx` | Compact AI model quick-select pill |
| `<AvatarCropModal>` | — | `AvatarCropModal.tsx` | Circular crop overlay using react-easy-crop |
| `<TextDiffPreview>` | — | `TextDiffPreview.tsx` | Side-by-side or inline text diff view |
| `<AiAssistantModal>` | — | `AiAssistantModal.tsx` | AI Assistant modal (script/lore_entry/md_import generate, plus the AiQuickPill settings editor) |
| `<MasterDetailModal>` | Custom two-pane modals | `MasterDetailModal.tsx` | Responsive master-detail modal: two-pane on desktop, drill-down stack on mobile |
| `<ActionSheet>` | — | `ActionSheet.tsx` | Mobile bottom-sheet action menu (portaled) |
| `<NumberInput>` | `<input type="number">` | `NumberInput.tsx` | Numeric input with +/- stepper controls |
| `<OverflowTooltip>` | `title="..."` on names | `OverflowTooltip.tsx` | Single-line truncating text that reveals a tooltip only when it overflows |
| `<Logo>` | Inline SVG | `Logo.tsx` | The `vt_sign` open-book logo mark (static or animated) |
| `textarea-helpers` | — | `textarea-helpers.ts` | Shared utilities for textarea behavior (not a component) |

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

**Why not native checkbox:** The native checkbox is unstylable across browsers. Toggle provides a consistent 36×20px animated switch with 180ms transition. The thumb slides 16px right when checked, background changes from `s3` to `accent`.

**When to use:** Settings, feature toggles, any on/off option. NOT for per-row selection in lists (use circle toggles or `Checkbox` instead).

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
| `label` | `ReactNode?` | Label text (string or JSX) |
| `disabled` | `boolean?` | Disables interaction |
| `id` | `string?` | For form association |
| `className` | `string?` | Additional classes |

**Why not native checkbox:** Mini pill indicator (18×18px rounded) consistent with ToggleChips styling. Checked state: accent border + bg with SVG checkmark. Unchecked: subtle `s3` pill. When a `label` is provided, the entire row is clickable.

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

**Styling:** Chips are rounded pills with `px-3 py-1 text-[12px]`. Selected: accent border + bg + accent text. Unselected: border-bg + s3 bg + t2 text. Clicking toggles inclusion in the `selected` array.

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

| Prop | Type | Description |
|------|------|-------------|
| `value` | `string` | Selected value |
| `options` | `{ value: string, label: string }[]` | Available options |
| `onChange` | `(value: string) => void` | Selection change |
| `disabled` | `boolean?` | Disables interaction |
| `compact` | `boolean?` | Smaller size for tight spaces (11px text, less padding) |
| `className` | `string?` | Additional classes |

**Why not `<select>`:** All options are visible at once — one click to select. `select` requires two clicks (open, then choose). Better UX for small sets.

**Styling:** Inline flex row with `bg-s3` background, rounded segments. Active: `bg-s2` + accent text + shadow. Has `role="radiogroup"` + `aria-checked` for accessibility.

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

| Prop | Type | Description |
|------|------|-------------|
| `value` | `string` | Selected value (empty string = default) |
| `options` | `{ id: string, label: string, detail?: string }[]` | Available options |
| `placeholder` | `string?` | Text when nothing selected (default: "Select…") |
| `searchPlaceholder` | `string?` | Search input placeholder (default: "Search…") |
| `defaultOption` | `string?` | Value for the "empty/default" option |
| `onChange` | `(value: string) => void` | Selection change |
| `disabled` | `boolean?` | Disables interaction |
| `className` | `string?` | Additional classes on trigger |

**Key features:**
- **Search filter** — type to narrow options list
- **Modal-aware** — portals into `#modal-portal` when inside a Dialog, so the dropdown renders within the focus trap
- **Detail text** — optional `detail` field on options for secondary info

**Known limitation: Keyboard navigation does not work.** The search `<input>` captures focus when the dropdown opens. Arrow keys are consumed by the input before Radix Select can handle them. The `blur()` workaround in `onKeyDown` fires too late — Radix checks `document.activeElement` during its own keydown handler, and at that point focus is still on the input. This is an architectural conflict between the search input and Radix's focus-driven keyboard model. A proper fix would require either removing the search input or replacing the Radix Select with a custom listbox that manages its own focus.

**Why not native `<select>`:** Native selects break in modals (z-index issues), can't be styled, can't have search, and render differently across browsers/OS.

**When to use:** 6+ mutually exclusive options, model/provider selection, any dropdown that needs search.

---

## LinkBindingPopover

**File:** `LinkBindingPopover.tsx`
**Replaces:** Ad-hoc character/persona/lorebook binding chips

```tsx
<LinkBindingPopover
  links={[{ targetType: "character", targetId: characterId }]}
  characters={[{ id: characterId, name: characterName, avatarAssetId }]}
  personas={persona ? [{ id: persona.id, name: persona.name, avatarAssetId: persona.avatarAssetId }] : []}
  lorebooks={[{ id: lorebook.id, name: lorebook.name, avatarAssetId: null }]}
  onSetLinks={setLinks}
  t={t}
  isMobile={isMobile}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `links` | `{ targetType: "character" \| "persona" \| "lorebook"; targetId: string }[]` | Active bindings |
| `characters` | `LinkTarget[]` | Available character targets |
| `personas` | `LinkTarget[]` | Available persona targets |
| `lorebooks` | `LinkTarget[]?` | Available lorebook targets |
| `onSetLinks` | `(links) => void` | Called when a pill/chip toggles |
| `t` | `(key: string) => string` | i18n resolver |
| `isMobile` | `boolean` | Uses larger touch targets on mobile |
| `tooltipLabel` | `string?` | Optional tooltip/aria label for the plus button |

**Styling:** Matches the app's binding UI: active bindings are compact avatar pills (`h-[22px]`, `bg-s2`, `border-border`, `hover:border-danger`); the dashed `+` button opens a popover with selectable avatar chips.

**When to use:** Any UI that binds content to characters/personas/lorebooks (lorebooks, AI assistant context, future scoped resources). Do not recreate these chips manually.

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

**Styling:** Dark tooltip (`bg-t1` text on `text-bg`) with arrow, 150ms fade-in animation. `z-[9999]` to appear above everything.

**Why not native `title`:** Native titles are invisible on touch devices, have zero styling, can't be positioned, and appear after a long delay. CustomTooltip is instant, styled, and works on all devices.

**Note:** Wrap your app in `<TooltipProvider>` (exported from the same file) for tooltips to work.

---

## Modal

**File:** `Modal.tsx`
**Base:** Radix UI Dialog

```tsx
<Modal open={showSettings} onClose={() => setShowSettings(false)}>
  <div className="w-[500px] rounded-lg border border-border bg-surface p-6">
    {/* Your modal content */}
  </div>
</Modal>
```

| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Controls visibility |
| `onClose` | `() => void` | Called on Escape, overlay click |
| `children` | `ReactNode` | Modal content (styled panel) |
| `overlayClassName` | `string?` | Extra classes on overlay (use `"z-[700]"` for nested modals) |
| `compact` | `boolean?` | Force centered on mobile (for small confirm dialogs) |
| `hideOverlay` | `boolean?` | Skip overlay rendering (for nested modals that share parent overlay) |

**Key behaviors:**
- Focus trap — Tab cycles within modal
- Scroll lock — background doesn't scroll
- Escape to close
- Overlay click prevented (explicit `onPointerDownOutside` + `onInteractOutside` prevention)
- Mobile: fullscreen by default (edge-to-edge). Use `compact` for small centered dialogs.
- **Portal anchor:** Renders `<div id="modal-portal">` inside Dialog.Content. `DropdownSelect` uses `getModalPortal()` to portal its content inside the focus trap so keyboard navigation works in modals.

**Nested modals:** Use `overlayClassName="z-[700]"` + `hideOverlay` on the inner modal to layer correctly above the outer modal.

---

## AutoTextarea

**File:** `auto-textarea.tsx`
**Replaces:** `<textarea>` that needs auto-resize

```tsx
// Controlled mode:
<AutoTextarea
  className="w-full rounded-md border border-border bg-s2 px-3 py-2 text-t1"
  style={{}}
  value={text}
  onChange={e => setText(e.target.value)}
  maxHeight={300}
/>

// Uncontrolled (react-hook-form):
<AutoTextarea
  className="..."
  style={{}}
  register={register("description")}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string` | Required. Applied to textarea. |
| `style` | `CSSProperties` | Required. Applied to textarea. |
| `value` | `string?` | Controlled value |
| `onChange` | `(e) => void?` | Controlled change handler |
| `register` | `UseFormRegisterReturn?` | react-hook-form register |
| `maxHeight` | `number?` | Max height in px before internal scroll |
| `disabled` | `boolean?` | Disables editing |
| `placeholder` | `string?` | Placeholder text |

**Behavior:** Shrinks to fit content on every render. Grows on every keystroke. Respects `maxHeight` — if content exceeds, textarea scrolls internally.

**Two modes:**
- **Controlled:** Pass `value` + `onChange` — for manually managed state
- **Uncontrolled:** Pass `register={register("field")}` — delegates to react-hook-form

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

CodeMirror 6 with JS syntax highlighting, custom dark theme using CSS vars + oklch colors, line numbers, bracket matching. ~200KB vs Monaco's ~4MB.

---

## SaveBar

**File:** `SaveBar.tsx`

The public export is **`<SaveButton>`** — a sticky save bar with dirty/saved state. `SaveBar` is the internal layout component (not exported). Consumers import `SaveButton`:

```tsx
import { SaveButton } from "../shared/SaveBar.js";

<SaveButton
  dirty={isDirty}
  saveState={saveState}
  onSave={handleSave}
  onReset={handleReset}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `dirty` | `boolean` | Whether there are unsaved changes |
| `saveState` | `"idle" \| "saving" \| "saved" \| "error"` | Current save status |
| `onSave` | `() => void` | Save callback |
| `onReset` | `() => void?` | Cancel/reset callback (shows button only when dirty) |
| `label` | `string?` | Custom save button label |

**Behavior:** Shows "Unsaved changes" text when dirty. Save button transitions: idle → "Saving…" (disabled) → "Saved" (green). Cancel button appears only when dirty.

---

## TokenCounter

**File:** `TokenCounter.tsx`

```tsx
<TokenCounter text={content} />
```

| Prop | Type | Description |
|------|------|-------------|
| `text` | `string` | Text to count tokens for |
| `label` | `string?` | Custom label (default: "tokens") |
| `className` | `string?` | Override default styling |

Uses `useTokenCount(text)` hook which selects the appropriate tokenizer (tiktoken, web-tokenizers, or byte fallback) based on the active model.

---

## ConfirmCloseModal

**File:** `confirm-close-modal.tsx`

```tsx
<ConfirmCloseModal
  onConfirm={handleDiscard}
  onCancel={handleKeepEditing}
/>
```

"Discard changes?" dialog. "Keep editing" is the primary (accent) button. "Close without saving" is the destructive outline button. Uses `<Modal>` with `z-[700]`.

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

**Always use before delete/discard operations.** Cancel is the primary button. Confirm is the destructive button with danger hover color.

---

## EmptyState

**File:** `empty-state.tsx`

```tsx
<EmptyState
  icon={<Icons.Inbox />}
  title="No lorebooks yet"
  sub="Create one to add world-building entries"
  cta={<button onClick={handleCreate}>Create Lorebook</button>}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| `icon` | `ReactNode` | Large icon |
| `title` | `string` | Primary text |
| `sub` | `string?` | Secondary description |
| `cta` | `ReactNode?` | Call-to-action element |
| `onCta` | `() => void?` | CTA click handler |

---

## MobileExpandTextarea

**File:** `MobileExpandTextarea.tsx`

```tsx
<MobileExpandTextarea value={text} onChange={setText} label="Description">
  <AutoTextarea className="..." style={{}} value={text} onChange={e => setText(e.target.value)} />
</MobileExpandTextarea>
```

Wraps a textarea. On mobile, shows an expand button (↗) in the top-right corner. Tapping opens a fullscreen editor overlay with header + "Done" button. Desktop: renders children unchanged.

**When to use:** Any textarea that may need more editing space on mobile (character descriptions, lorebook entries, etc.).

---

## Icons

**File:** `icons.tsx`

All UI icons are React components under `Icons.*`. No emojis. Consistent stroke width, sizing via CSS.

```tsx
import { Icons } from "./shared/icons.js";

<Icons.Copy />
<Icons.Trash />
<Icons.Branch />
<Icons.Refresh />
```

**Why not emojis:** Emojis render differently across platforms, can't be recolored with CSS, and don't support dark mode. SVG icons are consistent, themeable, and crisp at any size.

---

## Modal Helpers

**File:** `modal-helpers.ts`

```ts
getModalPortal(): HTMLElement | null
```

Returns the `#modal-portal` element inside the active Modal's Dialog.Content. Used by `DropdownSelect` to portal its dropdown content inside the Dialog's focus trap so the dropdown renders correctly when inside a modal.

**Note:** Despite the portal fix, Radix Select keyboard navigation (arrow keys) does not work reliably due to focus conflict with the search input — see DropdownSelect known limitations.

**When to call:** Only needed by components that use Radix Portal and need to work inside modals. If building a new Radix-based dropdown/popover that will be used inside modals, call `getModalPortal()` as the portal container.

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

## ChipInput

**File:** `ChipInput.tsx`
**Purpose:** Reusable tag/chip input with add/remove behavior.

Used for compact list-style fields such as stop sequences and other token-like inputs. Prefer this over ad-hoc comma-separated text fields when the user needs to manage discrete values.

---

## AiQuickPill

**File:** `AiQuickPill.tsx`
**Purpose:** Compact AI/model quick-action pill.

Use for small inline AI actions where a full button would be visually too heavy.

---

## AvatarCropModal

**File:** `AvatarCropModal.tsx`
**Purpose:** Avatar crop dialog backed by `react-easy-crop`.

Provides a circular crop overlay with zoom/pan controls and exports a normalized square image suitable for character/persona avatars.

---

## TextDiffPreview

**File:** `TextDiffPreview.tsx`
**Purpose:** Preview text changes before applying them.

Use when AI-assisted edits or bulk transformations need a visible before/after review step.

---

## textarea-helpers

**File:** `textarea-helpers.ts`
**Purpose:** Shared textarea behavior utilities.

Not a React component. Keep textarea sizing/selection helper logic here instead of duplicating it across editors.

---

## AiAssistantModal

**File:** `AiAssistantModal.tsx` — the frontend of the [AI Assistant backend subsystem](./backend.md#ai-assistant). One modal with two shapes:

- **Full mode** (`mode="full"`) — the lightbulb "assist" generator. `apiMode` selects what to generate: `"script"`, `"lore_entry"`, or `"md_import"` (the markdown-card importer). Lets the user pick a provider/model, feeds the relevant context (character/persona via `scopeContext`), and returns the result via `onInsert` / `onReplace` (text modes) or `onMdImportApply` (the structured `md_import` fields). Maps to the backend modes in `MODE_CONFIGS`.
- **QuickPill mode** (`mode="quickpill"`) — the settings editor behind `<AiQuickPill>`: pick the quick-action model and toggle which options it shows (append toggle, key target, message count).

The modal persists the last-used model per mode in `localStorage` so the lightbulb actions remember their model across sessions.

---

## MasterDetailModal

**File:** `MasterDetailModal.tsx` — a responsive master/detail layout inside a `Modal`, used by the larger editor surfaces (e.g. script/lore management).

- **Desktop:** two-pane — master list on the left, detail panel on the right.
- **Mobile:** a single stack with drill-down navigation. Selecting a master item opens the detail as an overlay; `MasterDetailMobileDrillDown` is the chevron button that triggers `openDetail()`.

State is shared via context: `useMasterDetail()` returns `{ isMobile, isDetailOpen, openDetail, closeDetail }`. Call it inside a `MasterDetailModal` to drive the mobile transition (e.g. showing a back button when `isDetailOpen`).

---

## ActionSheet

**File:** `ActionSheet.tsx` — a mobile bottom-sheet action menu, portaled to `document.body`. Use it for the mobile equivalent of a desktop dropdown/hover action bar (message actions, list item menus).

```tsx
<ActionSheet open={open} title="Message" items={items} onClose={close} />
```

Each `ActionSheetItem` is `{ icon, label, danger?, action }`. `danger` styles the item red (delete/destroy). The sheet renders a backdrop scrim and slides up from the bottom; selecting an item runs its `action` and closes.

---

## NumberInput

**File:** `NumberInput.tsx` — a numeric input with +/- stepper buttons. Use it for numeric settings where a plain `<input type="number">` is too bare (priority, depth, token counts).

| Prop | Type | Description |
|------|------|-------------|
| `value` / `onChange` | `number` / `(val: number) => void` | Controlled value |
| `min` / `max` / `step` | `number?` | Bounds and increment |
| `hideControls` | `boolean?` | Hide the +/- stepper buttons (plain input) |
| `onBlur` | `() => void?` | Blur handler |

Clamps to `[min, max]` and steps by `step`. Steppers disable at the bounds.

---

## OverflowTooltip

**File:** `OverflowTooltip.tsx` — renders `text` in a single-line truncating div and shows a hover tooltip with the full text **only when the text actually overflows** its container. Use it for entity names / labels in sidebars and lists where truncation is expected but the full value should be reachable.

| Prop | Type | Description |
|------|------|-------------|
| `text` | `string` | The text to display |
| `className` | `string?` | Classes on the text element (color, size). `truncate` is added automatically |
| `side` | `"top" \| "right" \| ...?` | Tooltip side; defaults to `right` (sidebar-friendly) |

Unlike `<CustomTooltip>` (which always shows a tooltip), this one shows it only when needed — so non-truncated text doesn't get a redundant popover.

---

## Logo

**File:** `Logo.tsx` — the `vt_sign` open-book-with-three-stars logo mark. Static by default for sidebar/branding placements. Exposes an animated variant (the loading placeholder uses it for the startup splash). Prefer importing `<Logo>` over inlining the SVG so the mark stays consistent and the animation lives in one place.
