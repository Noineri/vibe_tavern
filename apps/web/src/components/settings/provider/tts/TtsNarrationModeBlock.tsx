import { useState } from "react";

import { useT } from "../../../../i18n/context.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import {
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
 * `useAutoNarrate`) read the persisted mode at narrate time — this block only
 * writes it. Honest per-mode descriptions; neutral naming (no "actions" —
 * asterisk spans are mechanically indistinguishable from emphasis).
 */
export function TtsNarrationModeBlock() {
  const { t } = useT();
  const [mode, setMode] = useState<NarrationTextMode>(() => readTtsNarrationMode());

  const change = (next: NarrationTextMode): void => {
    setMode(next);
    persistTtsNarrationMode(next);
  };

  return (
    <div data-testid="tts-narration-mode-block" className="mx-3 mb-2 mt-3 flex flex-col gap-1.5 border-b border-border pb-3">
      <div className="font-ui text-[12px] font-semibold uppercase tracking-wide text-t3">
        {t("tts_narration_mode_label")}
      </div>
      <SegmentedControl<NarrationTextMode>
        value={mode}
        compact
        mobileSelect
        wrap
        options={NARRATION_TEXT_MODES.map((m) => ({ value: m, label: t(MODE_LABEL_KEYS[m]) }))}
        onChange={change}
      />
      <div data-testid="tts-narration-mode-desc" className="font-ui text-[12px] leading-snug text-t3">
        {t(MODE_DESC_KEYS[mode])}
      </div>
    </div>
  );
}
