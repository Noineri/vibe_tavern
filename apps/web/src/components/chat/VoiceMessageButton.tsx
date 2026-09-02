/**
 * Voice-message record button for the chat input (STT_PLAN ST-6).
 *
 * Unlike {@link DictationButton} (client-side push-to-talk that transcribes
 * into the textarea), this records a clip that becomes a `purpose: "voice"`
 * AUDIO ATTACHMENT — the transcript is produced server-side at send time by
 * the active voice-message STT profile (`ui_settings.activeVoiceMessageProfileId`,
 * falling back to the default profile).
 *
 * GATED like the dictation mic: renders nothing until an STT profile resolves
 * (pointer → default) — otherwise every recorded clip would dead-end at the
 * send gate with the honest-but-late configuration error. Push-to-talk shape:
 * click starts, click stops and uploads, ESC cancels (discards the clip).
 * While recording the button pulses red and a live second counter runs.
 */

import { useEffect, useRef, useState } from "react";

import { listAllSttProfiles, type SttProfileRecord } from "../../api/stt-api.js";
import { useT } from "../../i18n/context.js";
import { toast } from "sonner";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { dictationErrorTextKey } from "./use-dictation.js";
import { createVoiceRecorder, type VoiceRecorder } from "../../lib/stt/voice-recorder.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { Icons } from "../shared/icons.js";

export interface VoiceMessageButtonProps {
  /** Upload + add the finished clip as a voice draft attachment. */
  onRecorded(blob: Blob, durationMs: number): Promise<boolean>;
  /** Test seam — fake recorder factory (happy-dom has no MediaRecorder). */
  recorderFactory?: () => VoiceRecorder;
}

function formatSeconds(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function VoiceMessageButton(props: VoiceMessageButtonProps) {
  const { t } = useT();
  const pointer = useBootstrapStore((s) => s.data?.uiSettings.activeVoiceMessageProfileId ?? null);
  const [profiles, setProfiles] = useState<SttProfileRecord[] | null>(null);
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const startedAtRef = useRef(0);

  useEffect(() => {
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
  }, [pointer]);

  const profileResolves =
    profiles !== null &&
    ((pointer !== null ? profiles.some((p) => p.id === pointer) : false) ||
      profiles.some((p) => p.isDefault));

  // Live duration counter while recording.
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  // ESC discards an open recording.
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        recorderRef.current?.cancel();
        recorderRef.current = null;
        setRecording(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [recording]);

  if (!profileResolves) return null;

  const start = async (): Promise<void> => {
    const recorder = props.recorderFactory ? props.recorderFactory() : createVoiceRecorder();
    try {
      await recorder.start();
    } catch (err) {
      toast.error(t(dictationErrorTextKey(err)));
      return;
    }
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setRecording(true);
  };

  const stop = async (): Promise<void> => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setRecording(false);
    setUploading(true);
    try {
      const blob = await recorder.stop();
      const durationMs = Math.max(0, Date.now() - startedAtRef.current);
      await props.onRecorded(blob, durationMs);
    } catch (err) {
      if (!(err instanceof Error && err.name === "VoiceRecorderError")) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setUploading(false);
    }
  };

  const tooltip = recording
    ? t("voice_message_stop_tooltip")
    : uploading
      ? t("voice_message_uploading")
      : t("voice_message_record_tooltip");

  return (
    <CustomTooltip content={tooltip}>
      <button
        type="button"
        data-testid="voice-message-record"
        data-status={recording ? "recording" : uploading ? "uploading" : "idle"}
        aria-label={tooltip}
        className={
          "flex h-[26px] items-center justify-center gap-1 rounded-md px-1 transition-colors disabled:opacity-45 " +
          (recording ? "bg-danger/15 text-danger" : "text-t3 hover:bg-s2 hover:text-t1")
        }
        disabled={uploading}
        onClick={() => (recording ? void stop() : void start())}
      >
        {recording ? (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger" aria-hidden />
            <span className="font-ui text-[11px] tabular-nums text-danger">{formatSeconds(elapsedMs)}</span>
            <Icons.square />
          </>
        ) : (
          <Icons.audioLines />
        )}
      </button>
    </CustomTooltip>
  );
}
