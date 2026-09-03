/**
 * Dictation controls for the STT-tab footer (P6, audit 2026-09-04) — the
 * SttDictationBlock replaces the old master-column `SttDictationPanel` whose
 * mode `SegmentedControl` structurally overflowed the narrow column. Exact
 * slot-pattern clone of `TtsNarrationModeBlock` (owner reference, TTS audio
 * footer): label + dropdowns INLINE in the footer row (MasterDetailFooter
 * right slot, before Cancel/Save — the same slot the LLM footer's
 * default-proxy control occupies).
 *
 * Three global (profile-independent) settings live here:
 * - Enable — local preference gate for the chat-input mic (dictation-store);
 * - Active profile — the SERVER pointer `ui_settings.activeDictationProfileId`
 *   (patchUiSettingsAction), falling back to the profile marked default;
 * - Transcript mode — Append / Replace / Auto-send (local preference), as a
 *   DropdownSelect whose options carry per-mode `detail` descriptions (the
 *   narration-mode block puts the per-mode text there — no extra footer rows).
 */

import { useT } from "../../../../i18n/context.js";
import {
  patchUiSettingsAction,
  useBootstrapStore,
} from "../../../../stores/api-actions/bootstrap-actions.js";
import { useDictationStore } from "../../../../stores/dictation-store.js";
import {
  DICTATION_MODES,
  DICTATION_MODE_LABEL_KEYS,
  type DictationMode,
} from "../../../../lib/stt/dictation-settings.js";
import type { SttProfileRecord } from "../../../../api/stt-api.js";
import { cn } from "../../../../lib/cn.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { Toggle } from "../../../shared/Toggle.js";

const NONE_VALUE = "__default__";

/** i18n detail (description) keys per mode — the dropdown's `detail` slot. */
const MODE_DESC_KEYS: Record<DictationMode, "dictation_mode_append_desc" | "dictation_mode_replace_desc" | "dictation_mode_auto_send_desc"> = {
  append: "dictation_mode_append_desc",
  replace: "dictation_mode_replace_desc",
  "auto-send": "dictation_mode_auto_send_desc",
};

export function SttDictationBlock({ profiles }: { profiles: SttProfileRecord[] }) {
  const { t } = useT();
  const enabled = useDictationStore((s) => s.enabled);
  const mode = useDictationStore((s) => s.mode);
  const setEnabled = useDictationStore((s) => s.setEnabled);
  const setMode = useDictationStore((s) => s.setMode);
  const pointer = useBootstrapStore((s) => s.data?.uiSettings.activeDictationProfileId ?? null);
  const pointed = pointer !== null ? (profiles.find((p) => p.id === pointer) ?? null) : null;
  // No profiles → nothing to dictate with: the whole setting goes GRAY
  // (owner 2026-09-05) — the toggle can no longer be flipped on without an
  // engine behind it (a mic in chat with no STT profile is a dead control).
  const noProfiles = profiles.length === 0;

  return (
    <div data-testid="stt-dictation-block" className="flex min-w-0 flex-1 items-center gap-2">
      <label
        className={cn(
          "shrink-0 font-ui text-[12px] text-t3 transition-opacity",
          noProfiles && "opacity-40",
        )}
      >
        {t("dictation_panel_title")}
      </label>
      <Toggle
        checked={enabled}
        onChange={setEnabled}
        disabled={noProfiles}
        aria-label={t("dictation_enable")}
      />
      <DropdownSelect
        contentWidth={220}
        searchable={false}
        triggerTestId="dictation-profile-select"
        value={pointed?.id ?? NONE_VALUE}
        options={[
          { id: NONE_VALUE, label: t("dictation_profile_default_fallback") },
          ...profiles.map((p) => ({
            id: p.id,
            label: p.name + (p.isDefault ? ` · ${t("dictation_profile_default_suffix")}` : ""),
          })),
        ]}
        onChange={(id) => {
          void patchUiSettingsAction({ activeDictationProfileId: id === NONE_VALUE ? null : id });
        }}
        disabled={!enabled || profiles.length === 0}
        className="min-w-0"
      />
      <DropdownSelect
        searchable={false}
        triggerTestId="dictation-mode-select"
        value={mode}
        options={DICTATION_MODES.map((m) => ({
          id: m,
          label: t(DICTATION_MODE_LABEL_KEYS[m]),
          detail: t(MODE_DESC_KEYS[m]),
        }))}
        onChange={(value) => setMode(value as DictationMode)}
        disabled={!enabled || noProfiles}
        className="min-w-0"
      />
    </div>
  );
}
