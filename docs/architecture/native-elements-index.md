# Native Frontend Elements Index

> Audit snapshot of native HTML controls in `apps/web/src` that may be candidates for replacement with shared components.
>
> Generated from `rg` searches on 2026-05-30. This is an index for later review, not an implementation plan.

---

## Replacement Targets

| Native pattern | Current count | Preferred shared component | Notes |
|----------------|---------------|----------------------------|-------|
| `<select>` | 15 | `DropdownSelect` or `SegmentedControl` | Highest-value cleanup. Native selects are visually inconsistent. |
| `title={...}` native attribute | ~17 direct/indirect | `CustomTooltip` | Some `title` hits are component props and should not be changed. |
| `<input type="checkbox">` | 0 | `Checkbox`, `Toggle`, `ToggleChips` | Already clean outside shared components. |
| `<textarea>` | 22 | `AutoTextarea`, `MobileExpandTextarea`, `CodeEditor` | Review case-by-case. Chat input and specialized editors may stay native. |
| `<input type="range">` | 8 | Shared slider not yet extracted | Several are range sliders; `DualRangeSlider` currently lives locally in `ContextMemoryModal`. |
| `<input type="number">` | many | No shared number component yet | Candidate for future `NumberInput` only if styling/validation duplication becomes painful. |
| `<input type="file">` | 9 | Usually keep native-hidden | Most are hidden file inputs behind custom buttons/dropzones. |

---

## Native `<select>` Candidates

### Replace with `SegmentedControl`

Small fixed option sets, all options should be visible at once.

| File | Line | Purpose | Options | Suggested replacement |
|------|------|---------|---------|-----------------------|
| `components/settings/popovers/TweaksPanel.tsx` | 48 | Chat font size | small / medium / large | `SegmentedControl compact` |
| `components/settings/popovers/TweaksPanel.tsx` | 56 | UI font size | small / medium / large | `SegmentedControl compact` |
| `components/settings/popovers/TweaksPanel.tsx` | 64 | Message width | narrow / medium / wide | `SegmentedControl compact` |
| `components/settings/popovers/TweaksPanel.tsx` | 72 | Language | EN / RU | `SegmentedControl compact` |
| `components/build/editors/CharacterForm.tsx` | 482 | Example message activation mode | always / once / depth | `SegmentedControl compact` (keep tooltip wrapper) |
| `components/build/editors/CharacterForm.tsx` | 562 | Depth prompt role | system / user / assistant | `SegmentedControl compact` |
| `components/modals/CreateCharacterModal.tsx` | 368 | Depth prompt role | system / user / assistant | `SegmentedControl compact` |
| `components/build/editors/LorebookAccordion.tsx` | 136 | Lorebook scope while renaming | global / character / persona / chat | `SegmentedControl compact` or keep if too cramped on mobile |
| `components/settings/prompt/InjectionTable.tsx` | 141 | Injection role | roleOptions, currently 3 roles | `SegmentedControl compact` |
| `components/settings/provider/ProviderSamplerPanel.tsx` | 248 | Reasoning effort | low / medium / high | `SegmentedControl` |

### Replace with `DropdownSelect`

Dynamic or potentially long option lists.

| File | Line | Purpose | Notes |
|------|------|---------|-------|
| `components/context/SummaryTab.tsx` | 200 | Summarization provider | Dynamic provider list. Use `DropdownSelect`; no need for search if list is short, but component includes it. |
| `components/settings/provider/ProviderForm.tsx` | 84 | Provider preset group | `PRESET_GROUPS`; include custom/default option. |
| `components/settings/provider/ProviderForm.tsx` | 111 | API format / provider preset | `filteredPresets`; include custom/default option. |
| `components/settings/provider/ProviderEditHeader.tsx` | 68 | Provider preset group | Same logic as `ProviderForm`; likely extract shared provider-preset selector. |
| `components/settings/provider/ProviderEditHeader.tsx` | 79 | API format / provider preset | Same logic as `ProviderForm`; likely extract shared provider-preset selector. |

### DropdownSelect keyboard caveat

Do not promise arrow-key navigation for `DropdownSelect`. The search `<input>` captures focus, and Radix Select's focus-driven keyboard model does not handle this reliably. This is acceptable for now because search is the primary navigation path.

---

## Native `title` Attribute Candidates

Only replace true native DOM `title` attributes. Ignore component props like `<ImportModalFrame title=...>` or `<DestructiveConfirmModal title=...>`.

### High-value replacements

| File | Line | Element | Suggested change |
|------|------|---------|------------------|
| `components/layout/Rail.tsx` | 29 | `Ico` wrapper uses native `title` | Wrap returned `<div>` in `CustomTooltip`. This fixes all `Ico` callsites. |
| `components/layout/Rail.tsx` | 300 | Create character rail button | `CustomTooltip` |
| `components/layout/Rail.tsx` | 305 | Import character rail button | `CustomTooltip` |
| `components/layout/Rail.tsx` | 319 | Character avatar button | `CustomTooltip`; content = character name |
| `components/layout/Rail.tsx` | 332 | `+N` more characters button | `CustomTooltip` |
| `components/layout/Rail.tsx` | 348 | Chat indicator button | `CustomTooltip`; content = chat title |
| `components/layout/Rail.tsx` | 358 | New chat button | `CustomTooltip` |
| `components/chat/MessageBlock.tsx` | 814 | Resend button | `CustomTooltip` |
| `components/chat/MessageBlock.tsx` | 819 | Regenerate button | `CustomTooltip` |
| `components/chat/MessageBlock.tsx` | 824 | Branch button | `CustomTooltip` |
| `components/settings/provider/ProviderModelSelector.tsx` | 232 | Refresh models button | `CustomTooltip` |
| `components/modals/ContextMemoryModal.tsx` | 545 | Pin/unpin model button | `CustomTooltip` |

### Lower-priority / maybe keep

| File | Line | Element | Reason |
|------|------|---------|--------|
| `components/settings/popovers/AvatarPanel.tsx` | 209 | Draggable/zoomable image container | This is a non-button interaction hint. Native title is not great, but wrapping the whole drag surface in a tooltip may interfere with pointer behavior. |

### False positives from `rg 'title={...'`

These are component props, not native DOM `title` attributes:

- `components/modals/ImportModals.tsx` — `ImportModalFrame`, `ImportDropZone`
- `components/modals/PersonaModal.tsx` — `DestructiveConfirmModal`
- `components/modals/PromptManagerModal.tsx` — `DestructiveConfirmModal`
- `components/modals/ProviderModal.tsx` — `DestructiveConfirmModal`
- `components/settings/prompt/PromptFields.tsx` — `SectionHeader`
- `components/settings/prompt/PresetList.tsx` — `EmptyState`

---

## Native `<textarea>` Candidates

There are 22 native textareas outside `components/shared/`. Many should probably be moved to `AutoTextarea` now that shrinking-on-delete is fixed.

| File | Lines | Suggested replacement | Notes |
|------|-------|-----------------------|-------|
| `components/modals/CreateCharacterModal.tsx` | 248, 257, 297, 313, 323, 332, 344, 354, 391, 401 | `AutoTextarea` + `MobileExpandTextarea` for long fields | High-value: create modal has many repeated native textareas. |
| `components/build/editors/LoreEntryEditor.tsx` | 187 | `AutoTextarea` + `MobileExpandTextarea` | Lore entry content can be long. |
| `components/settings/prompt/PrefillField.tsx` | 29 | `AutoTextarea` | Small straightforward replacement. |
| `components/settings/prompt/InjectionTable.tsx` | 151 | `AutoTextarea` | Injection content field. |
| `components/context/SummaryTab.tsx` | 160 | `AutoTextarea` | Summary prompt/instructions field. |
| `components/modals/ContextMemoryModal.tsx` | 484 | `AutoTextarea` | Memory/summary modal text field. |
| `components/build/editors/ScriptEditor.tsx` | 393 | `CodeEditor` or keep native | Script import code should probably use `CodeEditor`; might be overkill in modal. |
| `components/build/editors/ScriptEditor.tsx` | 453 | `AutoTextarea` | AI prompt field. |
| `components/layout/WelcomeScreen.tsx` | 101, 110 | `AutoTextarea` or keep | Onboarding/import fields; review UI behavior. |
| `components/settings/prompt/PromptFields.tsx` | 122 | `AutoTextarea` | Currently has a local resize helper with shrink limitations; likely replace with shared helper/component. |
| `components/chat/InputArea.tsx` | 194, 225 | Keep native for now | Chat composer has custom keyboard/submit/mobile behavior; do not blindly replace. |

---

## Native Range Inputs

Current range sliders:

| File | Lines | Purpose | Recommendation |
|------|-------|---------|----------------|
| `components/modals/ContextMemoryModal.tsx` | 75, 81 | Local `DualRangeSlider` implementation | Consider extracting to `components/shared/DualRangeSlider.tsx`. |
| `components/modals/ContextMemoryModal.tsx` | 598, 633 | Single range controls for summary ranges | Could share styling with extracted slider. |
| `components/context/SummaryTab.tsx` | 176 | Summary range slider | Could share styling. |
| `components/settings/popovers/MobileSettings.tsx` | 126, 143 | Mobile font size sliders | Keep until shared `Slider` exists. |
| `components/settings/provider/ProviderSamplerPanel.tsx` | 70 | Sampler slider | Consider a shared `NumberSlider` pair because it has range + numeric input. |

---

## Native Number Inputs

There are many `type="number"` inputs across provider samplers, prompt depth, lore entry settings, summary ranges, etc. No shared `NumberInput` exists yet.

Recommended later extraction:

```tsx
<NumberInput
  value={value}
  min={0}
  max={100}
  step={1}
  onChange={setValue}
/>
```

Potential benefits:
- consistent height/border/font styling
- clamped parsing (`Number.isFinite`, min/max)
- optional empty-value handling
- wheel-scroll suppression if desired

Do not replace yet unless we create the shared component first.

---

## Native File Inputs

Found 9 native file inputs. Most are hidden (`className="hidden"`) and triggered by custom buttons/dropzones.

Recommendation: keep as-is unless we extract a shared `FilePicker`/`DropZone`. Native file inputs are necessary; the important part is that visible UI is custom.

---

## Priority Suggestions

1. **Replace all native `<select>`** — cleanest, visible UX improvement, low risk.
2. **Replace native `title` on Rail + MessageBlock + ProviderModelSelector** — improves tooltip consistency.
3. **Replace simple native `<textarea>` with `AutoTextarea`** — now safe because shrink-on-delete is fixed.
4. **Extract slider components later** — useful but broader scope.
5. **Leave hidden file inputs and chat composer native** unless there is a specific UX issue.
