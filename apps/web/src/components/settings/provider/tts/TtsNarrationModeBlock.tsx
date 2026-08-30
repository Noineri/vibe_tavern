import { useState } from "react";

import { useT } from "../../../../i18n/context.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import {
  isNarrationTextMode,
  NARRATION_TEXT_MODES,
  type NarrationTextMode,
} from "../../../../lib/tts/narration-text.js";
import { persistTtsNarrationMode, readTtsNarrationMode } from "../../../../lib/local-storage.js";

const MODE_LABEL_KEYS: Record<NarrationTextMode, "tts_narration_mode_full" | "tts_narration_mode_skip" | "tts_narration_mode_quoted"> = {
  full: "tts_narration_mode_full",
  "skip-asterisk-spans": "tts_narration_mode_skip",
  "quoted-dialogue": "tts_narration_mode_quoted",
};

const MODE_DESC_KEYS: Record<NarrationTextMode, "tts_narration_mode_full_desc" | "tts_narration_mode_skip_desc" | "tts_narration_mode_quoted_desc"> = {
  full: "tts_narration_mode_full_desc",
  "skip-asterisk-spans": "tts_narration_mode_skip_desc",
  "quoted-dialogue": "tts_narration_mode_quoted_desc",
};

/**
 * D26: the ONE narration text-mode setting (TS-10 remediation). Replaces the
 * v1 hardcoded `stripAsteriskActions: true, quotedOnly: false`. Both narrate
 * call sites (manual button `useMessageNarration`, stream-end
 * `useAutoNarrate`) read the persisted mode at narrate time — this control
 * only writes it. Honest per-mode descriptions; neutral naming (no "actions" —
 * asterisk spans are mechanically indistinguishable from emphasis).
 *
 * Rendered INLINE in the TTS audio footer (owner 2026-08-31 field-test): a
 * label + dropdown mirroring the LLM footer's default-proxy slot. The
 * per-mode descriptions ride the options as `detail` (the proxy slot puts the
 * proxy URL there), shown when the list is open — no extra footer rows.
 */
export function TtsNarrationModeBlock() {
  const { t } = useT();
  const [mode, setMode] = useState<NarrationTextMode>(() => readTtsNarrationMode());

  const change = (next: string): void => {
    if (!isNarrationTextMode(next)) return;
    setMode(next);
    persistTtsNarrationMode(next);
  };

  return (
    <div data-testid="tts-narration-mode-block" className="flex min-w-0 flex-1 items-center gap-2">
      <label className="shrink-0 font-ui text-[12px] text-t3">{t("tts_narration_mode_label")}</label>
      <DropdownSelect
        value={mode}
        options={NARRATION_TEXT_MODES.map((m) => ({
          id: m,
          label: t(MODE_LABEL_KEYS[m]),
          detail: t(MODE_DESC_KEYS[m]),
        }))}
        onChange={change}
        searchable={false}
        className="min-w-0 flex-1"
        triggerTestId="tts-narration-mode-select"
      />
    </div>
  );
}
