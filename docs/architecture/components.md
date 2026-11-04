# Shared Components Guide

> **Reusable UI components in `components/shared/`**. Use these instead of native HTML elements to maintain visual consistency, accessibility, and modal compatibility across the app.
>
> Field shapes come from the **field canon** (`lib/field-tokens.ts` — bases + modifiers, one home for the whole app), enforced by the field primitives below. The decision table for "which primitive do I need" lives in the `vibe-tavern-frontend` skill (`.agents/skills/vibe-tavern-frontend/SKILL.md`); this file is the full per-component reference.
>
> Text sizing follows the **UI font ladder**: size text only through `calc(var(--ui-fs)±Kpx)` (or `var(--ui-fs)` itself) — never fixed pixel classes (`text-[11px]`), Tailwind size classes (`text-xs` … `text-2xl`), or inline `fontSize` values; those ignore the Tweaks «UI font size» setting and render ~3px smaller than ladder-sized neighbours at the default 17px. `scripts/arch-gate.ts` bans every fixed size under `apps/web/src` outright — any occurrence fails the gate (the audit converted them all, so there is no baseline left to count down) — and `scripts/font-size-codemod.ts` converts fixed sizes onto the ladder mechanically (`--dry-run` lists per-area counts and the flagged places). The one exception is roleplay message content, which follows the chat font size `--mfs` instead (FIXED_FONT_SIZE_AUDIT_REPORT).
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
| `<AutoTextarea>` | `<textarea>` | `auto-textarea.tsx` | Auto-resizing textarea; canon field base + thin custom scroll lane by default (CNR-8n), `className` extends (FS-8b), `bare` = composer-family chrome escape hatch, `containerClassName` = scrollbar-root layout |
| `<SearchInput>` | hand-rolled search shells | `SearchInput.tsx` | Search field: shell owns chrome, borderless input inside, glass icon default, `trailing` slot (clear-✕) |
| `<InlineRenameInput>` | hand-rolled rename inputs | `InlineRenameInput.tsx` | Compact inline-rename field; accent-at-rest border = edit-state marker |
| `<ChipInput>` | Custom tag input | `ChipInput.tsx` | Tag/chip input, chips inside the box; `mode="tokens"` (Shift+Enter commits) / `mode="words"` (Enter commits) |
| `<MaskedConnectionKeyField>` | forked API-key fields | `masked-connection-key-field.tsx` | Masked key input + show/hide toggle + stored-key status (STT/TTS) |
| `<NumberInput>` | `<input type="number">` | `NumberInput.tsx` | Numeric input with +/- stepper controls |
| `<Slider>` | `<input type="range">` | `slider.tsx` | Base UI slider: `field` scrubber for parameters or glowing `rail` for media |
| `<SliderField>` | hand-rolled range rows | `SliderField.tsx` | Bounded numeric setting rendered as the `Slider appearance="field"` scrubber: label inside the field, value on the right, typing through the inline number editor (double-click / Enter); optional `help` node (the «?» tooltip) inside the field; optional `onCommit` = persist on release, keyboard commit and inline commit (drag ticks stay local) |
| `<CodeEditor>` | `<textarea>` for code | `CodeEditor.tsx` | CodeMirror 6 wrapper |
| `<CustomTooltip>` | `title="..."` | `Tooltip.tsx` | Dark tooltip with arrow |
| `<OverflowTooltip>` | `title="..."` on names | `OverflowTooltip.tsx` | Truncating text that tooltips only when it overflows |
| `<Modal>` | Custom dialogs | `Modal.tsx` | Radix Dialog, focus trap, scroll lock |
| `<MasterDetailModal>` | Custom two-pane modals | `MasterDetailModal.tsx` | Two-pane on desktop, drill-down stack on mobile |
| `<MasterDetailFooter>` | Custom editor footers | `MasterDetailModal.tsx` | Canonical desktop/mobile actions with disabled and destructive states |
| `<MasterList>` + `<SortableMasterListRow>` / `<MasterListPhoneRow>` + `<MasterListDragOverlayRow>` | Hand-rolled master-list rows + `@dnd-kit/*` per list | `master-list/master-list.tsx` + `master-list-row.tsx` + `master-list-phone-row.tsx` + `master-list-overlay-row.tsx` | The ONE master-detail list primitive: header/search/sortable/empty-state/footer slots, wrapping title (`rowTitleCls`), second line (`rowSecondCls`), status slot with ★ active marker, handle-only drag, pinned rows without handles |
| `<ConfirmCloseModal>` | Custom confirm | `confirm-close-modal.tsx` | "Discard changes?" dialog |
| `<DestructiveConfirmModal>` | Custom confirm | `destructive-confirm-modal.tsx` | "Are you sure?" for delete actions (+ optional secondary) |
| `<ActionSheet>` | Mobile action menus | `ActionSheet.tsx` | Mobile bottom-sheet action menu (portaled) |
| `<SaveBar>` / `<SaveButton>` | Custom save buttons | `SaveBar.tsx` | Sticky save button with dirty/saved state |
| `<TokenCounter>` | Custom token display | `TokenCounter.tsx` | "123 tokens" badge |
| `<EmptyState>` | Custom empty states | `empty-state.tsx` | Icon + title + CTA placeholder |
| `<Dropzone>` | Hand-copied file drop targets | `dropzone.tsx` | Desktop drag/click target; mobile native file-picker target |
| `<LinkBindingPopover>` | Custom binding chips | `LinkBindingPopover.tsx` | Binding pills + add-trigger popover (character/persona/lorebook/script/preset/regex) |
| `<MobileExpandTextarea>` | — | `MobileExpandTextarea.tsx` | Fullscreen editor overlay on mobile |
| `<Icons.* />` / `<Ic.* />` | Emoji / SVG inline | `icons.tsx` | All UI icons as React components |
| `<Logo>` | Inline SVG | `Logo.tsx` | The `vt_sign` open-book logo mark |
| `<AiQuickPill>` | — | `AiQuickPill.tsx` | Compact AI model quick-select pill |
| `<AvatarCropModal>` | — | `AvatarCropModal.tsx` | Circular crop overlay using react-easy-crop |
| `<TextDiffPreview>` | — | `TextDiffPreview.tsx` | Side-by-side or inline text diff view |
| `<AiAssistantModal>` | — | `AiAssistantModal.tsx` | AI Assistant modal (script/lore_entry/md_import generate + AiQuickPill settings editor) |
| `<AiAssistantShell>` | Hand-built assistant modal chrome | `ai-assistant/AiAssistantShell.tsx` | Shared header/content/footer shell with responsive structured actions |
| `textarea-helpers` | — | `textarea-helpers.ts` | Shared utilities for textarea behavior (not a component) |
| `<DiceFaces>` | per-feature dice markup | `dice-faces.tsx` | Shared 2D SVG dice renderer + pure helpers |
| `<ResizableSidePane>` | per-panel drag/resize code | `resizable-side-pane.tsx` | Resizable side column: persisted width, drag line, width glide open/close |
| `<ScrollArea>` | Custom-chrome scroll regions | `scroll-area.tsx` | Base UI native viewport with themed overlay chrome: 3px-at-rest thumbs (thin) expanding to 5px over an invisible wider grab lane, static 8px (regular), vertical/horizontal/biaxial via `orientation` |
| `<ChatScrollRail>` / `<ScrollRail>` | Transcript native scrollbar | `chat/scroll-rail.tsx` | Shared RP/Co-Author story map: quiet thread, hover previews, desktop jumps/drag and mobile edge scrub |

---

## Scroll Area

**File:** `scroll-area.tsx`.
Wraps the installed Base UI Root/Viewport/Content/Scrollbar/Thumb/Corner; the viewport remains a native scroll container, with native scrollbar chrome hidden by Base UI itself and the cross axis clipped by the orientation.
`orientation="vertical"` (the default) clips horizontal overflow; `orientation="horizontal"` clips vertical overflow; `orientation="both"` keeps one biaxial scroller and mounts exactly two lanes plus one inert (`pointer-events-none`, aria-hidden) Corner at their intersection.
Vertical-list Content is explicitly viewport-wide (`width: 100%; min-width: 0` inline), overriding Base UI's inline `min-width: fit-content`; long names must truncate inside their list rather than expand headers, rows or portal contents beyond the clipped viewport.
Keep that width contract in the shared primitive, not in per-row pixel widths or stacking overrides; it does not apply to horizontal/biaxial regions (which keep Base UI's `fit-content` so wide content really overflows) or to the native-editor viewport branch, which has no Content wrapper.
Wave-7 hover contract (CNR-8b, owner-approved): the track is an invisible absolutely positioned grab lane — the real pointer hit target — and the visible thumb hugs the lane's outer edge with a `--border2` fill and fully rounded ends in Chromium and Firefox alike.
`scrollbarSize="thin"` rests at a 3px thumb expanding to 5px only while the pointer is inside the lane or a drag is held, over a minimal 5px lane (owner ruling 2026-11-02: the invisible overlay must not eat interactive content at list edges; 5px still exceeds the 3px thumb so the hit target never moves); the default `regular` keeps today's static 8px mapping (lane, rest and hover all 8px) so unmigrated consumers look exactly as before.
All geometry budgets (`--vt-scrollbar-lane`, `--vt-scrollbar-thumb`, `--vt-scrollbar-thumb-hover`) live once in the `styles.css` custom-property layer keyed off the root `data-scroll-area` variant and the track `data-orientation`; themes override the variables, and migration units may widen `--vt-scrollbar-lane` per surface where the scroll edge has no interactive content, never per-screen CSS.
Expansion is paint-only: only the thumb's cross-axis size changes inside the overlay lane, so the viewport's `clientWidth`/`clientHeight` never change on hover or drag and no content reflows, wraps or shifts.
Hover expansion is gated behind `@media (hover: hover)` so touch devices never keep a sticky 5px thumb after a tap, and `prefers-reduced-motion` disables the 120ms cross-axis transition (only the cross axis transitions — Base UI's inline scroll-length sizing is never smoothed).
The installed Base UI 1.9.0 exposes no dragging state (its drag latch lives in refs, and `data-scrolling` is a 500ms scroll debounce that drops while a held drag merely pauses), so the component mirrors the library's own drag lifecycle — primary pointerdown on the lane through pointerup/cancel/lost-capture — as `data-dragging` on the track, which the stylesheet keys the held 5px thumb on.
`className`/`style` size the root (including flex or max-height constraints); `contentClassName` carries row layout, gaps and padding; `viewportProps` forwards the ref, accessible name, scroll events and viewport-local classes to the actual scroller.
Use `render={<section />}` when the existing semantic root must remain a section.
Base UI owns measurement, conditional scrollbar mounting, thumb dragging and native keyboard/wheel/touch interaction; non-overflowing viewports stay out of tab order.
`viewportRender` composes a native editor element as the vertical viewport without a Content wrapper (it implies `orientation="vertical"`); native inputs remain focusable even without overflow and keep their own focus chrome.
After editor renders, a programmatic scroll notification refreshes Base UI's measurements when a capped textarea's value changes scrollHeight without resizing its box; no scroll position is assigned and the editor is not remounted.
Since the CNR-8n flip every `AutoTextarea` (form fields and composers alike) composes into the thin lane by default, with the textarea itself as the native viewport — autosizing, native selection/caret scrolling, register refs and macro autocomplete retained; the lane mounts only when the capped field really overflows.
Both agent-shell composers (`AgentInputArea` and `AgentMobileInputArea`, including Experience Copilot) keep their explicit `AutoTextarea scrollbarSize="thin"` (pre-flip opt-ins, still valid), preserving their 3–12 / 1–6 row autosizing, controlled prefills, mentions, attachments and desktop Enter-to-send / mobile button-only send behavior; form fields get the same chrome without passing anything.
In the mobile agent input row, `containerClassName="flex-1"` assigns the row's remaining width to the ScrollArea root; a flex class on the nested textarea alone cannot size that root.
The mobile RP/Co-Author composers (hand-rolled px-capped `<textarea>`, no autosize lib) compose the same way directly — `ScrollArea scrollbarSize="thin" viewportRender={<textarea …/>}` with the root taking the input row's `flex-1` — keeping their imperative 40vh growth cap, native refs, attachment/send controls and touch input.
The primitive does not replace the message navigation rail, CodeMirror, or sandboxed iframe documents (their integrations are later Wave-7 migration units).
The host stylesheet hides native chrome on non-textareas at widths up to 768px and on touch-first devices (`hover: none` with `pointer: coarse`), including the real RP/Co-Author navigation drawers, collapsed strips, sheets, modal lists, CodeMirror scrollers and horizontal markdown overflow; it never changes their overflow/touch-action behavior.
The same media rule hides non-editor ScrollArea lanes and corners from layout and pointer hit testing; `data-scroll-editor` identifies the existing native-editor composition, whose 3px thumb remains visible when overflowing.
Viewport/input-capability changes update this policy through CSS, preserving mounted editor/list state; desktop lanes and the separate transcript navigation rail are unchanged.
Opaque-origin experience documents receive the host stylesheet's phone-policy verdict through `ExperienceFrame`: since CNR-8r the signal is the stylesheet-owned root custom property `--vt-hide-content-scrollbars`, set ONLY inside the same phone-policy media block that hides native chrome (unset/empty at desktop widths), read via `getComputedStyle` on `documentElement` — computed `scrollbar-width` is no longer a reliable verdict now that the host is custom-chrome-only (a custom-only future suppresses native chrome on desktop too). The property is baked into both generated documents initially and then kept live through a parent-source/type/boolean-validated layout-only message on load, viewport resize and touch-first input changes.
The frame's own width is never used to infer phone state; a narrow desktop mini-app retains desktop chrome, while host policy changes hide non-textarea body/list chrome without reloading the blob, restarting a round, changing the gameplay bridge/SDK or relaxing sandbox/CSP.
Inside those documents the scrollbar chrome itself is the vanilla micro-scrollbar (`experience/experience-frame-micro-scrollbar.ts`, CNR-8q): host CSS cannot cross the opaque-origin boundary (CNR-8a probe D), so both document builders bake one self-contained CSS+JS script next to the CNR-7h policy receiver. It re-implements the shared thin contract — 3px resting thumb expanding to 5px only over a stable invisible 5px grab lane, held through drag by a `data-dragging` latch, `@media (hover: hover)` gated, transition-free under reduced motion — over one fixed click-through overlay layer, so lane mounting and expansion are paint-only and no user-owned element is ever mutated (native chrome is hidden by CSS, not by touching the visual's styles).
Coverage is automatic: the root/body scroller, every `overflow:auto/scroll/overlay` region the authored visual or the realtime runtime creates (MutationObserver), resizes (ResizeObserver) and every scroll (one capture-phase listener, coalesced into a single rAF pass) — textareas included on desktop (the CNR-8n default-thin precedent), with their native chrome returning under the phone policy when the whole layer hides.
The thumb color comes from the `--vt-sb-thumb` token the builders bake from the host's computed `--border2` (neutral fallback baked alongside); there is no per-surface configuration — one system per document.
Native gallery grids, the mobile media picker and the gallery lightbox ride the shared thin lanes directly (CNR-8k); caption/description textareas compose as editor viewports, and image zoom/pan remains separate from scrollbar handling.

## Chat Navigation Rail

**Files:** `chat/scroll-rail.tsx`, `chat/scroll-rail-model.ts`, `chat/message-jump.ts`.

`MessageScroller` mounts one `ChatScrollRail` for both RP and Co-Author and hides only the transcript's native scrollbar through `scrollbar-hide`.
Since CNR-8r the host is custom-chrome-only: the global native fallback (8px WebKit geometry + the Firefox-thin `@supports` rule) is REMOVED from `styles.css` — every desktop-visible scrollbar is the shared lane system (or a named exception below). Standard properties still override WebKit geometry in Chromium wherever both are present, and utility-based hiding (`.scrollbar-hide`, the phone-policy block) still wins because it is unlayered against Tailwind's layered utilities.
RP and Co-Author character/chat lists, collapsed avatar strips, and RP build navigation use the shared `ScrollArea scrollbarSize="thin"` for true 3px custom chrome in Chromium and Firefox.
Sidebar-owned portal lists opt in explicitly too: both chat flyouts and both build-character switcher variants use the same primitive, with Radix available-height bounds applied to the complete popup so header/search height is included.
The expanded build-character switcher also caps its content-driven popup width at Radix's available viewport width, keeping the trigger-width minimum without letting long names place the popup offscreen.
Their section headers, row controls, filtering, and height allocation remain inside native scroll viewports; editors, modal panels, and the transcript rail are unchanged (the experience frame documents own their in-document micro-scrollbar chrome).
The engine-knowledge fact survives the fallback's removal in new context: Firefox 153+ also accepts WebKit selectors, so selector support no longer identifies the engine — which is why every surviving native-chrome rule in the host (`.scrollbar-hide`, the phone-policy block) always pairs the standard property with the WebKit selector instead of gating on either alone.

#### CNR-8r residual verdicts and the CNR-8r2 handoff

Settled by CNR-8r (source-level audit + pins in the touched suites):

- **Migrated onto thin lanes**: the ExperienceModal host viewport (the confirm overlays stay absolutely positioned INSIDE the viewport scroller, scrolling with content — only the scrollbar changed), the ExperienceDetachedWindow twin viewport (a desktop-resizable popup must not fall back to raw native), the markdown table wrapper (`.md-table-wrap`, same 8c horizontal idiom as language code blocks — the 8a inventory's diff/code row had missed it), the ThemeTuner tool panes (`.tt-scroll`/`.tt-stage`/`.tt-editor` + the export textarea as an editor viewport, baked 7px rules removed; the tuner stylesheet lives in `dev/theme-tuner-css.ts`), and the missed modal-body family batch (CreateCharacterModal, UpdateModal body + release-notes quote + error-detail pre, ImportPreview list, ImportPreviewModal body, ImportModals bodies + error lists, PresetImportModal desktop block list, RegexImportModal body, AgentSettingsModal body, CoauthorCharacterForm editor body).
- **Phone-only (fork-gated ≤768px/mobile-UA; the 7g media rule hides native chrome there)**: ToolbarSelect's mobile BottomSheet list, QuickSwitchPopover's mobile half, MobileInputArea's persona/preset sheets, CoauthorLoreAssistantSettings' mobile BottomSheet half, PresetImportModal's mobile preview wrapper. BottomSheet and ActionSheet primitives render no scroller of their own (consumers own lists).
- **Already migrated by earlier units (stale ledger entries)**: dice-rolls and experience-report popovers (CNR-8p), MobileModelSheet (CNR-8m).
- **Sanctioned exceptions**: the `.scrollbar-hide` utility and the phone-policy block (the only surviving native-chrome rules in the host stylesheet); deliberately hidden strips (`BuildMode`, `CharacterForm` tag row, `AttachmentPreview`, `mobile-variant-carousel`); the ThemeTuner preview-window replicas (`.tt-win-list`/`.tt-win-messages` — fixed sample content, excluded by design in the 8a inventory, 7px baked chrome retained); library-inlined inert `overflow` classes (Radix/cmdk Viewports).

**CNR-8r2 (settled) — the CNR-8r residual surfaces migrated onto thin lanes**: `chat/DiceTray.tsx`'s attempt-detail popover body (cap `max-h-[60vh]` on the lane root, `space-y-2 p-3` on the content), the dice tray's no-actor fallback, and the desktop wide split (checks column keeps its `w-[15rem]` cap + split border on the lane root; results padding rides the content), `coauthor/CoauthorLoreAssistantSettings.tsx`'s desktop Popover.Content (the flyout idiom — available-height cap on the Radix content, lane `flex-1` inside), `hooks/use-st-persona-import.tsx`'s ST preview list (cap `max-h-[200px]` on the lane root, `space-y-1.5` on the content, confirm row docked outside), `settings/provider/ProviderModelList.tsx`'s cmdk list (the 8d idiom from DropdownSelect — cap on the lane root, `Command.List` keeps `p-1`, cmdk's element-level active-item `scrollIntoView` rides the lane viewport unchanged), and `agent-shell/AgentTimelineSeparator.tsx`'s disclosure body (cap + card chrome on the lane root — the element the `timeline-separator-body` testid marks — with `p-2.5` on the content). Phone-only halves stay native under the 7g policy: the dice tray's narrow stacked branch and the lore-assistant mobile BottomSheet half; shared bodies (attempt detail, ST preview) render their lanes hidden on phone, identical to their already-hidden native chrome. Idiom notes that stayed validated through 8r2: caps/docked controls live outside the scroll content (8g), padding that scrolled with content rides `contentClassName` (8j), and a `{/* comment */}` may NOT precede the element inside a `) : (` expression arm — put it inside the element's children.

- **Rest:** a quiet 2px thread and accent viewport thumb on desktop; a 2.5px mobile thread rides the reading position inside a transparent 24×48px handle, 4px inboard of the edge.
- **Hover / focus:** desktop reveals typographic ticks, user turns use the theme's quoted-text warmth, and nearby ticks expand into a fisheye wave.
- **Preview:** one persistent contrast card uses the shared tooltip's `bg-t1` / `text-bg` chrome and UI font ladder, shows canonical number, speaker, role, and a three-line content snippet, and is measured/clamped inside the live pane.
- **Desktop navigation:** press/click teleports, captured pointer movement scrubs live, and Home/End/Arrow/Page keys navigate the same entries.
- **Desktop hit lanes:** the straight 36px rail hugs the transcript edge unless the shell's closed-sidechat opener is mounted; only then it moves 28px inboard (24px toggle target plus a 4px gap).
  `chat-rail-layout.css` derives the inset from the actual direct-child opener in `AppShell`, including close-slide completion, rather than duplicating served-mode or pane-open state.
  Preview clearance and jump-to-bottom placement consume the same inherited geometry; the button sits 24px left of the full hit lane (22px even at its 1.1 hover scale), at a 60px edge offset without the opener or 88px with it.
- **Mobile navigation:** only the inboard handle claims touch input, the full-height rail remains pointer-transparent, and captured scrubbing shows the same card centered above the finger; release/cancel ends the scrub and fades the card.
- **Haptics:** a changed mobile selection calls `navigator.vibrate(8)` when available; unsupported browsers retain visual feedback, with no polyfill or new setting.
- **Accessibility:** the named vertical scrollbar exposes its controlled transcript, ordinal range, and canonical message number/speaker as value text; pending-only/empty lists expose no rail.

The pure model derives entries from the caller's display IDs and canonical message records.
Numbers are always wire `position + 1`, never the rail ordinal; synthetic pending IDs, tools, missing records, and records without a canonical position are excluded.
Co-Author supplies its grouped turn IDs through the existing renderer, so the rail does not introduce another grouping or numbering source.
At most one tick per 4px is rendered (2px minimum tick + 2px gap); contiguous merged buckets never reduce pointer access to the underlying messages.
Store subscriptions stay inside `ChatScrollRail`, below the transcript renderer, and scroll/resize/content observations update only the rail.

Every jump goes through `jumpToMessage` and `useStickToBottom.beginExplicitNavigation()`.
The controller drops the pin before navigation, suppresses follow during the transaction, owns mounted-row alignment, and re-evaluates the real bottom only on settlement.
Stable-tail rows settle directly; virtualized rows use Virtuoso's forced-start `scrollIntoView` with its `done` callback, not a guessed timeout.
Native scroll intent, another navigation, explicit bottom navigation, chat/branch reset, or teardown invalidates an old completion so it cannot realign a stale target.
The landing highlight is local to the target row and is cancelled on the next landing or list reset.

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
| `inline` | `boolean?` | Uses a phrasing-content root for a checkbox nested in an inline chip |

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
| `options` | `{ value: string, label: string, tooltip?: string }[]` | Available options, with an optional per-chip tooltip |
| `onChange` | `(selected: string[]) => void` | Updated selection |
| `disabled` | `boolean?` | Disables all chips |
| `minSelected` | `number?` | Minimum selected chips; defaults to no selection guard |
| `className` | `string?` | Additional classes on wrapper |

Built on `@radix-ui/react-toggle-group` (`type="multiple"`): `aria-pressed` per chip, one Tab stop for the whole group, arrow-key navigation. Pills `px-3 py-1 text-[calc(var(--ui-fs)-2px)]`; selected = accent border + bg + text.

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
| `ariaLabel` | `string?` | Accessible name for the radiogroup — for controls whose meaning lives outside their segment labels (e.g. a mode switch); most call sites are self-describing |
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

**Scroll chrome (CNR-8n):** the default is the shared thin custom lane (3px thumb, 5px on hover/drag) — the same composition the composers proved: the field is a `ScrollArea` editor viewport, the textarea stays the real native scroller (focus/caret/IME/autosize on one DOM node), the native scrollbar is hidden, and the overlay lane mounts only when the capped field actually overflows — non-scrolling fields show no chrome. On phones the field rides the CNR-7g mobile editor exception: its 3px thumb stays the scrollbar affordance. A field inside a horizontal flex row must carry its row layout (`flex-1` etc.) on `containerClassName` — a flex class on the nested textarea cannot size the scrollbar root (the 8h2 lesson).

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string?` | Extension appended AFTER the base (base always composes — the FS-8b flip killed the silent-replace window) |
| `containerClassName` | `string?` | Layout classes on the always-rendered custom-scrollbar root (CNR-8n), e.g. `flex-1` in a horizontal composer row; does not change the native textarea's classes |
| `scrollbarSize` | `"thin"?` | Accepted for explicitness at the pre-flip composer seams; `"thin"` IS the default for every consumer — the textarea remains the native viewport |
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
| `renderChipAction` | `(value: string, index: number) => ReactNode?` | Optional control rendered within each existing chip |
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
| `onBlur` | `((event: FocusEvent<HTMLInputElement>) => void)?` | Fires after the blur commit; the event's `relatedTarget` shows where focus is going |
| `autoFocus` | `boolean?` | Focuses the input and selects its text on mount (inline editors) |
| `onEscape` | `(() => void)?` | Fires on Escape; the caller decides what cancelling means |
| `inputTestId` | `string?` | Test id on the real `<input>`, not on the wrapper |
| `disabled` | `boolean?` | Disables editing |
| `className` / `inputClassName` | `string?` | Classes on wrapper / input (a conflicting base utility needs the `!` modifier) |

Clamps to `[min, max]` and steps by `step`. Steppers disable at the bounds.

---

## Slider

**File:** `slider.tsx`
**Replaces:** raw `<input type="range">` controls

```tsx
<Slider value={volume} min={0} max={100} step={1} aria-label="Volume" onValueChange={setVolume} />
```

| Prop | Type | Description |
|------|------|-------------|
| `value` / `onValueChange` | `number` or `[number, number]` / matching callback value | Controlled scalar or two-thumb range value |
| `min` / `max` / `step` | `number` | Bounds and increment |
| `onValueCommitted` | `((value: number \| [number, number]) => void)?` | Fires once when Base UI commits an interaction |
| `size` | `"md" \| "sm" \| "xs"?` | Visual density; defaults to `md` |
| `orientation` | `"horizontal" \| "vertical"?` | Rail direction; defaults to `horizontal` |
| `appearance` | `"rail" \| "field"?` | Visual interaction mode; defaults to `rail` so existing callers retain media-rail behavior |
| `formatValue` | `((value: Value) => string)?` | Formats the complete scalar or tuple value for a rail bubble or field value text |
| `valueClassName` | `string?` | Field-only value-span classes replacing the default `text-t1` color; ignored by the rail |
| `label` / `help` | `ReactNode?` | Field-only left-side label and caller-owned help node; long labels move above rather than truncate |
| `aria-label` | `string?` | Accessible label for a scalar thumb |
| `getAriaLabel` | `((index: number) => string)?` | Accessible label for each range thumb |
| `inputTestId` | `string` or `[string, string]?` | Test id placed on Base UI's nested range input(s) |
| `numberTestId` | `string?` | Field-only inline number editor test id |
| `disabled` / `className` | `boolean?` / `string?` | Disables interaction / extends the primitive base |

Built on Base UI Slider with its hidden native range input and keyboard semantics.
Range thumbs use Base UI's non-crossing collision behavior.
`appearance="rail"` is for media timelines, volume, and zoom: it has the gradient accent fill, near-white accent-ringed thumb, focus/drag halo, and an optional formatted value bubble owned by the active thumb.
`appearance="field"` is for parameters and `SliderField`: it uses the canon field box, supports press-to-set/scrubbing, exact ten-step Shift+arrow large steps, inline number editing, and two-value window dragging.
On touch it defers horizontal scrubbing until 4 px and leaves vertical swipes to scroll.
The inline editor (`slider-field-editor.tsx`) is a `NumberInput`: Enter or blur commits once only if the clamped number differs from the value the editor opened with (untouched, empty/reverted or same-value edits emit neither `onValueChange` nor `onValueCommitted`; changed numbers stay exact, never snapped to the step grid), Escape cancels, and keyboard focus returns to the field's thumb input afterwards.
The field fill (single value or two-value window) is a theme-independent translucent accent, 16 % of `--accent`, never `--accent-hover`, which is opaque in some themes; label, help and value always paint above it.
Field labels remain authored in full; when label and value do not fit, the label moves above using `lblCls` spacing.
Both appearances keep disabled opacity and the 44 px coarse-pointer hit area without inflating the visible rail thumb.

**When to use:** Parameters use `Slider appearance="field"` (or `SliderField`); media timeline, volume, and zoom use `Slider appearance="rail"`.

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

Consumers: `ProviderModal` (provider profiles), `PromptManagerModal` (prompt presets / regex presets / service prompt profiles / image prompt profiles — one master-detail per tab; image prompt profiles live in `ImagePromptTemplatesPane`, a fork of the service-prompt profile flow whose detail side is mode rows × family dropdowns, kept SEPARATE from service-prompt profiles and LLM presets), `PersonaModal` (personas), `ContextMemoryModal`, coauthor module/skill modals. Canonical structure: header/title/subtitle/dirty-dot/headerActions + master list (scrollable rows with `border-l-2` + active dot, dashed "+ New" docked at the list bottom — never in headerActions) + stable footer with `border-t`.

`MasterDetailMobileDrillDown` accepts an optional item-specific `ariaLabel` and otherwise uses the localized generic open-detail label.
Use the item name when several drill-down buttons share one list.

`MasterDetailFooter` keeps editor actions in one canonical location.
Its `actions` entries are `{ icon, label, onClick, disabled?, destructive? }`: desktop renders labeled actions, while mobile renders 36px icon buttons with the same label as their accessible name.
`disabled` prevents activation on both layouts, and `destructive` applies the danger treatment without changing action behavior.
The `right` slot remains one atomic action row; move controls that cannot fit beside it on mobile into `mobileBottomRow`.

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
  cta="Create Lorebook"
  onCta={handleCreate}
  ctaProminent
  secondaryCta="Import"
  onSecondaryCta={handleImport}
/>
```

`EmptyState` owns the real `<button>` elements for both actions; pass their visible content and callbacks rather than nesting buttons inside `cta`.

| Prop | Type | Description |
|------|------|-------------|
| `icon` | `ReactNode` | Large icon |
| `title` | `string` | Primary text |
| `sub` | `string?` | Secondary description |
| `cta` | `ReactNode?` | Primary action content |
| `onCta` | `() => void?` | Primary action callback |
| `ctaProminent` | `boolean?` | Give the primary action a 44px minimum touch target |
| `secondaryCta` | `ReactNode?` | Secondary action content |
| `onSecondaryCta` | `() => void?` | Secondary action callback |

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

## AiAssistantShell

**File:** `ai-assistant/AiAssistantShell.tsx`

Layout-only chrome shared by assistant modals: title/header extras, a streaming-aware close action, the no-provider guard, scrollable content, and the footer.
Business logic and body markup remain in each consumer.

Prefer the structured footer contract over a hand-built `footer`:

- `primaryAction?: { label, onClick, disabled?, busy?, busyLabel? }`
- `secondaryActions?: Array<{ label, onClick, disabled?, busy?, busyLabel? }>`

A busy action is disabled, exposes `aria-busy`, and may replace its visible label with `busyLabel`.
Desktop actions stay compact; mobile actions become full-width 44px rows and the footer adds safe-area bottom spacing.
The legacy `footer` slot remains for existing consumers, but new multi-action footers should use the structured contract.
The Regex AI assistant is the reference consumer.

---

## AiAssistantModal

**File:** `AiAssistantModal.tsx` — the frontend of the [AI Assistant backend subsystem](./backend.md#ai-assistant). One modal with two shapes:

- **Full mode** (`mode="full"`) — the lightbulb "assist" generator. `apiMode` selects what to generate: `"lore_entry"`, `"md_import"` (the markdown-card importer), `"scene_schema"`, or `"scene_rules"`. Lets the user pick a provider/model, feeds the relevant context (character/persona via `scopeContext`), and returns the result via `onInsert` / `onReplace` (text modes) or `onMdImportApply` (the structured `md_import` fields). Maps to the backend modes in `MODE_CONFIGS`.
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

## ResizableSidePane

**File:** `resizable-side-pane.tsx` — the ONE home of side-column behaviour (SC-16b). First consumer: the desktop sidechat panel; SC-16c reuses it for scripts, mini-apps and the co-author editor. Never copy its drag/clamp/glide logic into a panel — wire this instead.

```tsx
<ResizableSidePane
  open={open}
  storageKey="vt.sidechat.width"
  defaultWidth={400}
  minWidth={320}
  resizeEdge="left"
  className="border-l border-border/50 bg-surface"
  panelTestId="sidechat-panel"
  resizeHandleTestId="sidechat-resize"
  closedView={<SidechatHandle variant="desktop" label={label} onOpen={() => setOpen(true)} />}
>
  {content}
</ResizableSidePane>
```

Pane-edge toggles come only from `SidechatHandle` (`chat/sidechat/SidechatHandle.tsx`): a closed pane shows a half-opacity capsule (full on hover or keyboard focus); an open pane shows a thin line that grows into the capsule while the pointer is anywhere over the pane — the pane adds `EDGE_PANE_GROUP` to its `className` for that. Each button keeps a 24 × 48 px hit area.

| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Presence: false starts the close glide, true mounts and opens |
| `storageKey` | `string` | `usePersistedNumber` key for the one shared width preference |
| `defaultWidth` | `number` | Resting width (px) — also the double-click reset target |
| `minWidth` | `number` | Static floor (px) — enforced on read, write, drag and reset |
| `resizeEdge` | `"left" \| "right"` | Which pane edge carries the drag line (drag sign follows the edge) |
| `children` | `ReactNode` | Pane content — squeezing content must carry its own `overflow-hidden` + `min-w-0` (the pane never clips: edge chrome outset shadows must survive) |
| `closedView` | `ReactNode?` | Rendered instead of the pane once the close glide ends (default: nothing) |
| `className` | `string?` | Extends the pane chrome (`cn` is join-only — appended, never replaced) |
| `panelTestId` / `resizeHandleTestId` | `string?` | Test hooks for the pane element and the drag line |

Owns the 6 px `col-resize` drag line (GalleryViewer mousedown → window mousemove/mouseup pattern), the clamp (static min, max = half the live window, resize re-clamps without touching stored intent), the persisted width, the double-click reset, and the open/close width glide (`transition-[width_0.18s_ease-out]` — the rail flyouts' `flyoutIn` curve; off while held; `motion-reduce:transition-none` + instant mount logic under `prefers-reduced-motion`). Close keeps the pane mounted until its own width `transitionend` (child transitions filtered by target + property; 200 ms timeout fallback), then unmounts.

**When to use:** any side column that resizes and glides (sidechat, SC-16c panes). NOT for overlays/popovers (use `Modal`/Radix) or mobile sheets (use `BottomSheet`/`ActionSheet`).

---

## CopilotPlanSection

**File:** `build/editors/copilot/CopilotPlanSection.tsx` — the Experience Copilot's mount of the shared agent-plan mechanic (see [Agent plan mechanic](./frontend.md#agent-plan-mechanic)), part of the [copilot subsystem](./experience-copilot.md). Mounted in the shell's chat tab directly below the todo section (pinned stack: header → meter → todo panel → plan section → scrolling feed — it does not scroll with the feed); the plan is the durable script document living beside the session-scoped todo panel (PM-7).

- Owns one `useAgentPlan(owner)` subscription for the script plus the editor modal's local open state; renders `AgentPlanPanel` + `AgentPlanEditorModal` (both in `shared/agent-plan/`).
- The shell passes `locked={ctrl.isSending}` — the panel's editor button and every modal field lock while a turn streams, so the model's rewrite and the user's edit can never race.
- Props are prop-driven by contract (`owner`, `locked`); nothing imports from the copilot dir in the shared components.

---

## StoryPlanStrip

**File:** `chat/sidechat/StoryPlanStrip.tsx` — the chat column's story-plan row (DR-11): the active branch's plan as a compact, constant-height strip pinned above the message list, mounted as the first child of `PlayModeChatPane` (so the desktop surface and the mobile «Chat» pane share it).

- Composition, not a fork: a thin mount of the shared `AgentPlanSection` in curtain presentation — the SAME `useAgentPlan` chatBranch cache, editor modal and revert write the sidechat pane uses — plus the strip's own extras: no editor button in the collapsed row, the goal tracker's manual check («Check now», `story_plan_check_now`) through the panel's `headerActionsBefore` slot, and the call-director button through the `actions` slot (disabled while a sidechat turn streams).
- Renders NOTHING while the active branch's plan is empty (without a plan the chat pane is byte-identical); after the last event completes the strip stays with the done label (A8).
- The row refreshes the plan entry (`refreshAgentPlan`) whenever the chat's objective state changes in the snapshot — the server's follow-back writes completed statuses into the plan, and the re-GET is how the row learns the next event (no second fetch path, no second objective derivation).
- Passed-check flash (R4): a goal-status transition of the plan's current event IS «the check passed this event» (the projection copies ids 1:1), so the strip shows the passed label on the success tint for ~6 s (`STORY_PLAN_FLASH_MS`), then the next event — no toast.
- The call-director default handler runs the `callDirector` store action (open + optional profile switch + one queued message, DR-12); `onCallDirector` stays an override for tests.

---

## Sidechat proposal cards

**Files:** `chat/sidechat/ObjectiveProposalCard.tsx` (source), `StoryPlanProposalCard.tsx` (fork #1, DR-10a), `TrackerSceneProposalCard.tsx` (fork #2, DR-10b) — the review cards for the sidechat's three record proposals, registered in the sidechat host's `recordProposalRenderers` (`objective`, `story-plan`, `tracker-scene`).

- The Objective card is the fork source: it is itself fork #1 of the shell's `RecordProposalFallbackCard`, carries the fork count (`forks: 2`) in its header, and each fork's header carries its own correspondence map (the house fork rule).
- The StoryPlan card shows the model's summary, the proposed events as a pure diff by id against the stored branch plan (new / changed / removed markers, the current event's body), the goals-replacement warning only when Accept will replace goals not from the plan, and the auto-check toggle (only while the tracker's frequency is 0, off by default, sent with Accept).
- The TrackerScene card shows the generated scene half through the shared `TrackerTemplateSchemaPreview` — the objective half never rides it (goals come from the plan).
- The Objective card itself gained a plan mode (R3): while the active branch plan has events it retitles («New story-plan event», «will go next, after …») and Accept inserts the goal as the next plan event; with no plan events it is exactly the original goal card.

---

## CopilotTodoSection

**File:** `build/editors/copilot/CopilotTodoSection.tsx` + `CopilotTodoPanel.tsx` — the Experience Copilot's mount of the session-scoped todo mechanic (restored PM-7, owner ruling 2026-10-11: todo = the thread's session; plan = the script), part of the [copilot subsystem](./experience-copilot.md). Pinned directly below the context meter and directly ABOVE `CopilotPlanSection` — it does not scroll with the feed.

- The section owns the turn-store subscription (`todoByThread[threadId]`, seeded from the thread wire by the controller, rewritten live by `todo` tool events); the panel is strictly read-only (model-owned).
- **Hidden until the first `todo` call ever happens** on the thread (`items.length === 0` → `null`) — each pinned panel hides itself independently of the other.
- **Collapsed:** `[status glyph] current-title · N` + chevron; the whole row is the expand button. Current = first `active` item, falling back to first `pending` (mirrors the objective tracker's `pickActiveTask`); a fully-resolved list shows the done label. N = remaining = `pending + active`. The active glyph's dot pulses — the "live" indicator.
- **Expanded:** `Ic.target` header + i18n title + remaining count, then the full ordered list with per-status glyphs (status classes/NodeGlyph styling borrowed verbatim from `chat/message-slots/objective-zone.tsx`).
- Collapse/expand is per-mount local state (a UI toggle, deliberately NOT persisted to the store).

---

## CopilotAskCard

**File:** `build/editors/copilot/CopilotAskCard.tsx` — renders an `ask_user` activity from the [copilot](./experience-copilot.md) turn store, wherever it sits in the message feed (history anchor or live trailing turn).

- **Interactive (trailing awaiting ask):** the question, option chips (click = answer), the single `recommended` chip accent-highlighted with a star marker (defensively only when it is actually one of `options`), a free-text `AutoTextarea` with Enter-submit, and a skip button. Submitting goes through the controller's `handleAnswer` → the stream endpoint in answer mode — the answer resumes the same logical turn (no user row is ever appended).
- **Read-only states:** answered (shows the answer text), skipped (muted skip label), expired/unanswered (a later activity superseded this ask — rendered muted, non-interactive).
- State comes from the activity's `ask` payload (`{ question, options?, recommended?, status, answer? }`), produced identically by live SSE ingestion and persisted hydration (the parity parsers in the turn store are the guarantee).
