/**
 * Dictation settings panel inside the STT tab (STT_PLAN ST-4b): the opt-in
 * gate for the chat-input mic. Three controls:
 * - Enable switch — local preference (dictation-store/localStorage);
 * - Active profile — the SERVER pointer `ui_settings.activeDictationProfileId`
 *   (patchUiSettingsAction), falling back to the profile marked default;
 * - Transcript mode — Append / Replace / Auto-send (local preference).
 * Rendered at the bottom of the STT master column, below the profile list.
 */

import { useT } from "../../../../i18n/context.js";
import {
  patchUiSettingsAction,
  useBootstrapStore,
} from "../../../../stores/api-actions/bootstrap-actions.js";
import { useDictationStore } from "../../../../stores/dictation-store.js";
import { DICTATION_MODES, DICTATION_MODE_LABEL_KEYS, type DictationMode } from "../../../../lib/stt/dictation-settings.js";
import type { SttProfileRecord } from "../../../../api/stt-api.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { Toggle } from "../../../shared/Toggle.js";

const NONE_VALUE = "__default__";

export function SttDictationPanel({ profiles }: { profiles: SttProfileRecord[] }) {
  const { t } = useT();
  const enabled = useDictationStore((s) => s.enabled);
  const mode = useDictationStore((s) => s.mode);
  const setEnabled = useDictationStore((s) => s.setEnabled);
  const setMode = useDictationStore((s) => s.setMode);
  const pointer = useBootstrapStore((s) => s.data?.uiSettings.activeDictationProfileId ?? null);
  const pointed = pointer !== null ? (profiles.find((p) => p.id === pointer) ?? null) : null;
  const effective = pointed?.name ?? t("dictation_profile_default_fallback");

  return (
    <div data-testid="stt-dictation-panel" className="m-3 mt-0 shrink-0 rounded-lg border border-border bg-s2/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-ui text-[12px] font-semibold uppercase tracking-wide text-t3">
          {t("dictation_panel_title")}
        </span>
        <div className="flex items-center gap-2" data-testid="dictation-enable">
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            aria-label={t("dictation_enable")}
          />
          <span className="font-ui text-[12px] text-t2">{t("dictation_enable")}</span>
        </div>
      </div>

      <div className={"mt-2.5 flex flex-col gap-2 " + (enabled ? "" : "opacity-50")}>
        <DropdownSelect
          contentWidth={220}
          side="top"
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
        />
        <SegmentedControl
          value={mode}
          onChange={(value) => setMode(value as DictationMode)}
          options={DICTATION_MODES.map((m) => ({ value: m, label: t(DICTATION_MODE_LABEL_KEYS[m]) }))}
          compact
          disabled={!enabled}
        />
      </div>

      <div className="mt-2 font-ui text-[11px] leading-snug text-t4">
        {enabled ? t("dictation_panel_hint_on") : t("dictation_panel_hint_off")}
      </div>
    </div>
  );
}
