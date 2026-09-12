/**
 * Dictation mic button for the chat input (STT_PLAN ST-4b).
 *
 * OPT-IN: renders nothing unless dictation is enabled (dictation-store) AND
 * an active profile resolves (the `ui_settings.activeDictationProfileId`
 * pointer, falling back to the profile marked default). Push-to-talk: click
 * starts, click stops and transcribes, ESC cancels (discards the recording).
 * The transcript lands per the mode — append / replace / auto-send
 * (`applyDictationTranscript`); auto-send fires the chat send after the
 * draft is replaced.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listAllSttProfiles, type SttProfileRecord } from "../../api/stt-api.js";
import { useT } from "../../i18n/context.js";
import { useDictationStore } from "../../stores/dictation-store.js";
import { DICTATION_MODE_LABEL_KEYS } from "../../lib/stt/dictation-settings.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { Icons } from "../shared/icons.js";
import { applyDictationTranscript, useDictation, type DictationTranscriber } from "./use-dictation.js";
import type { VoiceRecorder } from "../../lib/stt/voice-recorder.js";

export interface DictationButtonProps {
  draft: string;
  setDraft(value: string): void;
  /** Fire the chat send (used by auto-send mode). */
  send(): void;
  /** Disable the send leg (a sending turn, no provider…) — auto-send defers
   *  to a plain replace so the text is never silently lost. */
  canSend: boolean;
  /** Test seams — forwarded to useDictation (fake transcriber / recorder). */
  transcriber?: DictationTranscriber;
  recorderFactory?: () => VoiceRecorder;
}

export function DictationButton(props: DictationButtonProps) {
  const { draft, setDraft, send, canSend } = props;
  const { t } = useT();
  const enabled = useDictationStore((s) => s.enabled);
  const mode = useDictationStore((s) => s.mode);
  const pointer = useBootstrapStore((s) => s.data?.uiSettings.activeDictationProfileId ?? null);
  const [profiles, setProfiles] = useState<SttProfileRecord[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void listAllSttProfiles()
      .then((list) => {
        if (!cancelled) setProfiles(list);
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, pointer]);

  const profile = useMemo<SttProfileRecord | null>(() => {
    if (profiles === null) return null;
    const pointed = pointer !== null ? profiles.find((p) => p.id === pointer) : undefined;
    return pointed ?? profiles.find((p) => p.isDefault) ?? null;
  }, [profiles, pointer]);

  const handleTranscript = useCallback(
    (text: string) => {
      const next = applyDictationTranscript(text, mode, draft);
      setDraft(next);
      if (mode === "auto-send" && canSend) send();
    },
    [mode, draft, setDraft, send, canSend],
  );

  const { status, errorKey, start, stop, cancel } = useDictation({
    profile,
    onTranscript: handleTranscript,
    transcriber: props.transcriber,
    recorderFactory: props.recorderFactory,
  });

  // ESC cancels an open recording (push-to-talk escape hatch).
  const recording = status === "recording";
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [recording, cancel]);

  if (!enabled || profile === null) return null;

  const tooltip =
    status === "recording"
      ? t("dictation_stop_tooltip")
      : status === "transcribing"
        ? t("dictation_transcribing")
        : status === "error" && errorKey !== null
          ? t(errorKey)
          : t("dictation_mic_tooltip", { mode: t(DICTATION_MODE_LABEL_KEYS[mode]) });

  return (
    <CustomTooltip content={tooltip}>
      <button
        type="button"
        data-testid="dictation-mic"
        data-status={status}
        aria-label={tooltip}
        className={
          "flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors disabled:opacity-45 " +
          (recording
            ? "bg-danger/15 text-danger animate-pulse"
            : "text-t3 hover:bg-s2 hover:text-t1")
        }
        disabled={status === "transcribing"}
        onClick={() => (recording ? stop() : void start())}
      >
        {recording ? <Icons.square /> : <Icons.mic />}
      </button>
    </CustomTooltip>
  );
}
