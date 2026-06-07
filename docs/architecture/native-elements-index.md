# Native Frontend Elements Index

> Audit snapshot of native HTML controls in `apps/web/src` that may be candidates for replacement with shared components.
>
> Generated on 2026-06-06.

---

## Replacement Targets

| Native pattern | Current status | Preferred shared component | Notes |
|----------------|----------------|----------------------------|-------|
| `<select>` | **CLEARED** | `DropdownSelect` / `SegmentedControl` | All instances successfully replaced. |
| `title={...}` | **ON HOLD** | `CustomTooltip` | Bug: Tooltips might not trigger properly on mobile. Need to investigate the tooltip logic before replacing existing native titles. |
| `<textarea>` | **CLEARED** | `AutoTextarea`, `MobileExpandTextarea` | Replaced across forms and editors. |
| `<input type="range">` | **PENDING** | Shared single/dual slider | No shared component yet. Dual slider exists in memory modal, but single slider is needed for samplers. |
| `<input type="number">` | **CLEARED** | `NumberInput` | Shared component created and applied globally. |

---

## Native `<textarea>` Candidates

Replace these with `AutoTextarea` (and wrap in `MobileExpandTextarea` where the text can be very long).

| File | Purpose | Notes |
|------|---------|-------|
| `components/modals/CreateCharacterModal.tsx` | Character creation fields | High-value target, many repeated textareas. |
| `components/build/editors/CharacterForm.tsx` | Character edit fields | Same as above. |
| `components/build/editors/LoreEntryEditor.tsx` | Lore entry content | Essential for expanding text on mobile. |
| `components/build/editors/ScriptEditor.tsx` | Script AI prompt, import field | Script code uses `CodeEditor`, but AI prompt uses native. |
| `components/context/SummaryTab.tsx` | Summary instructions | Straightforward replacement. |
| `components/modals/ContextMemoryModal.tsx` | Memory field | Straightforward replacement. |
| `components/layout/WelcomeScreen.tsx` | Onboarding fields | Check UX behavior. |
| `components/settings/prompt/InjectionTable.tsx` | Injection content | |
| `components/settings/prompt/PrefillField.tsx` | Prefill text | |
| `components/chat/InputArea.tsx` | Chat composer | **DO NOT REPLACE**. Has custom keyboard/submit/mobile behavior. |

---

## Native Number Inputs (`<input type="number">`)

There are ~20 native number inputs. They currently look different and duplicate validation logic.
**Recommendation**: Create a shared `<NumberInput>` component with consistent styling, min/max clamping, and wheel-scroll suppression.

| File | Purpose |
|------|---------|
| `components/build/editors/CharacterForm.tsx` | Example messages depth / Chat history depth |
| `components/build/editors/LorebookAccordion.tsx` | Lorebook recursive depth |
| `components/build/editors/LoreEntryEditor.tsx` | Order, Display Index, Probability, Depth limit, Weight |
| `components/modals/ContextMemoryModal.tsx` | Summary intervals, token thresholds |
| `components/context/SummaryTab.tsx` | Summary interval |
| `components/modals/CreateCharacterModal.tsx` | Depth settings |
| `components/settings/prompt/InjectionTable.tsx` | Injection depth |
| `components/settings/prompt/PromptFields.tsx` | Depth limits |
| `components/settings/provider/ProviderSamplerPanel.tsx` | Sampler configuration |
| `components/settings/provider/LogitBiasPanel.tsx` | Logit bias values |
| `components/shared/AiQuickPill.tsx` | Quick action parameters |

---

## Native Range Inputs (`<input type="range">`)

| File | Purpose | Recommendation |
|------|---------|----------------|
| `components/modals/ContextMemoryModal.tsx` | Local `DualRangeSlider` | Extract to `components/shared/DualRangeSlider.tsx`. |
| `components/settings/provider/ProviderSamplerPanel.tsx` | Sampler sliders | **Requires a single-value slider**. Do not use DualRangeSlider here. Needs a new shared slider/number pair component. |
| `components/settings/popovers/MobileSettings.tsx` | Font size sliders | Keep native until a standard single slider is built. |

---

## Native `title` Attribute Candidates (ON HOLD)

*Investigation needed: User reported `CustomTooltip` does not trigger on mobile devices.*
Do not mass-replace native `title` until mobile behavior is fixed.

| File | Element |
|------|---------|
| `components/layout/Rail.tsx` | Create/Import buttons, Avatars, Chats, Settings icons |
| `components/chat/MessageShell.tsx` | Branch, Resend, Regenerate buttons |
| `components/chat/MessageBlock.tsx` | Delete message button |
| `components/settings/provider/ProviderModelSelector.tsx` | Refresh models button |
| `components/modals/ContextMemoryModal.tsx` | Pin/unpin model button |

---

## Reusable Modal Patterns (Proposed)

### 1. `MasterDetailModal`
**Problem:** `PersonaModal`, `PromptManagerModal`, and `ProviderModal` all independently implement a two-column layout (list of items on the left, editor on the right).
**Solution:** Extract a generic `<MasterDetailModal>` layout component with two modes:
- **Desktop:** Two columns side-by-side.
- **Mobile:** Single column with automatic "Back" button navigation between the list view and the editor view.

#### Review note — `vibe_tavern_front_polish` modal refactor (2026-06-07)

**Update:** The `MasterDetailModal` implementation has been completed in the `front-polish` branch.
- It correctly calls `useIsMobile()` internally.
- It encapsulates the `isDetailOpen` state and mobile drill-down header logic.
- It exposes `openDetail()` and `closeDetail()` via render props.
- `ProviderModal`, `PromptManagerModal`, and `ContextMemoryModal` have been successfully migrated to use it.

**Merge caution:** the sibling worktree predates the advanced local-provider sampler work. Its `ProviderModal` does not include the newer fields and UI behavior (`typicalP`, `tfsZ`, Mirostat, DRY/XTC, sampler capabilities, hidden API key for local providers, local connection status, ARM local-preset filtering). Rebase/merge carefully to avoid losing those changes.

### 2. `DropZone` / `ImportSurface` Unification
**Problem:** `ImportModals.tsx` uses `<ImportSurface>`, but `PresetImportModal.tsx` duplicates the drag-and-drop file reading states and UI manually.
**Solution:** Expand `<ImportSurface>` (or create a `<SharedDropZone>`) to handle generic file parsing (text vs. images) and drop states automatically, so all import modals can share the same wrapper and logic.

### 3. `AiAssistantModal`
**Problem:** The inline AI assistant UI (provider select, context binding, prompt textarea, token counter, streaming output, diff preview, apply/replace buttons) is heavily duplicated across `ScriptEditor.tsx`, `LoreEntryEditor.tsx`, and a simplified version exists in `AiQuickPill.tsx`. This causes massive duplication of complex state logic and API calls.
**Solution:** Extract a generic `<AiAssistantModal>` (or popover/drawer) that manages the model selection and streaming internally. It should accept callbacks like `onApply(text)` and `onReplace(text)` so it can be cleanly dropped into any editor without duplicating the UI and state logic.

---

## Priority Suggestions

1. ~~**Mass-replace `<textarea>` with `<AutoTextarea>`**.~~ (DONE)
2. ~~**Build `<NumberInput>` shared component** and replace the 20+ instances across forms and samplers.~~ (DONE)
3. ~~**Build `<MasterDetailModal>` framework** to unify Provider, Persona, and Prompt Manager modals.~~ (DONE in `front-polish` branch)
4. **Build `<AiAssistantModal>`** to deduplicate the complex AI generation UI across all editors.
5. **Investigate `<CustomTooltip>` mobile bug**, fix it, then replace all `title=` attributes.
6. **Build a generic single `<Slider>` component** for samplers and settings.
