import { useRef, useState, type ReactNode } from "react";
import { useT } from "../../../../i18n/context.js";
import { lblCls } from "../../../../lib/field-tokens.js";
import { TextInput } from "../../../shared/text-input.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { Ic } from "../../../shared/icons.js";
import { cloneTtsVoice, type TtsBackendCapabilities, type TtsVoiceRecord } from "../../../../api/tts-api.js";
import { GLUE_GAP_SECONDS, GlueVoiceSamplesError, glueDecoder, glueVoiceSamples } from "../../../../lib/tts/glue-voice-samples.js";
import { TtsSectionCard } from "./TtsSectionCard.js";

/** Voice-cloning section (clone field design, agreed with the owner
 *  2026-08-31): name + reference audio + Clone button with inline
 *  error/result — rendered only for backends that reported the capability
 *  (the editor gates it). Single reusable form; provider differences live
 *  in the backend adapters, not here. No language field in v1; mic input is
 *  mic-later. The audio passes through the server's memory only — nothing
 *  is persisted. */
export function TtsVoiceCloneCard({ backend, config, profileId, capabilities, onCloned }: {
  backend: string;
  config: Record<string, unknown>;
  profileId: string | undefined;
  capabilities: TtsBackendCapabilities;
  onCloned: (voice: TtsVoiceRecord) => void;
}): ReactNode {
  const { t } = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const selectionToken = useRef(0);
  const [name, setName] = useState("");
  const [referenceText, setReferenceText] = useState("");
  // TPE-11: MANY short samples glue into one mono WAV at upload time; a lone
  // sample passes through untouched (owner decision 2026-09-05).
  const [files, setFiles] = useState<File[]>([]);
  const [durations, setDurations] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const formats = capabilities.formats ?? ["wav", "mp3", "flac", "m4a", "ogg"];
  const maxMb = capabilities.maxSizeMb ?? 10;
  // The total the backend will actually see (gaps included for multi).
  const totalSeconds =
    durations !== null && durations.length === files.length
      ? durations.reduce((sum, d) => sum + d, 0) +
        (files.length > 1 ? GLUE_GAP_SECONDS * (files.length - 1) : 0)
      : null;

  function handleFiles(picked: File[]): void {
    setFiles(picked);
    setError(null);
    setResult(null);
    if (picked.length === 0) {
      setDurations(null);
      return;
    }
    // Duration facts for Σ and the 10–30 s warning; a decode failure here is
    // silent (no AudioContext in tests; a truly broken file surfaces at clone
    // time with the typed decode error).
    const token = ++selectionToken.current;
    void (async () => {
      try {
        const decode = glueDecoder();
        const secs: number[] = [];
        for (const file of picked) {
          const raw = await decode(file);
          secs.push(raw.channels[0].length / raw.sampleRate);
        }
        if (selectionToken.current === token) setDurations(secs);
      } catch {
        if (selectionToken.current === token) setDurations(null);
      }
    })();
  }

  async function handleClone(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      setError(t("tts_clone_err_name"));
      setResult(null);
      return;
    }
    if (files.length === 0) {
      setError(t("tts_clone_err_file"));
      setResult(null);
      return;
    }
    // SiliconFlow (and any provider whose upload carries the transcript):
    // the field is required — an empty transcript is a bad clone upstream.
    const transcript = referenceText.trim();
    if (capabilities.cloneRequiresReferenceText === true && transcript === "") {
      setError(t("tts_clone_err_text"));
      setResult(null);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Multi → glue into one mono WAV (the size cap rides the glue); single
      // → passthrough with the plain file-size check.
      let audio: File;
      if (files.length === 1) {
        audio = files[0];
        if (audio.size > maxMb * 1024 * 1024) {
          setError(t("tts_clone_err_size", { size: maxMb }));
          setResult(null);
          return;
        }
      } else {
        try {
          audio = (await glueVoiceSamples(files, glueDecoder(), maxMb * 1024 * 1024)).file;
        } catch (cause) {
          if (cause instanceof GlueVoiceSamplesError) {
            setError(
              cause.code === "size"
                ? t("tts_clone_err_size", { size: maxMb })
                : t("tts_clone_glue_err_decode"),
            );
            setResult(null);
            return;
          }
          throw cause;
        }
      }
      const voice = await cloneTtsVoice({
        backend,
        config,
        profileId,
        name: trimmed,
        audio,
        ...(capabilities.cloneRequiresReferenceText === true || transcript !== ""
          ? { referenceText: transcript }
          : {}),
      });
      onCloned(voice);
      setResult(t("tts_clone_success", { name: voice.label }));
      setName("");
      setReferenceText("");
      setFiles([]);
      setDurations(null);
      // Same-file re-pick must re-fire onChange — clearing the hidden input
      // is what makes the browser treat it as a fresh selection.
      if (fileRef.current !== null) fileRef.current.value = "";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <TtsSectionCard title={t("tts_clone_section_title")} testid="tts-clone-section">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tts-clone-name" className={lblCls}>
          {t("tts_clone_name_label")}
        </label>
        <TextInput
          id="tts-clone-name"
          data-testid="tts-clone-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {capabilities.cloneRequiresReferenceText === true && (
        <div className="flex flex-col gap-1.5" data-testid="tts-clone-reference-text">
          <label htmlFor="tts-clone-reference-text" className={lblCls}>
            {t("tts_clone_reference_text_label")}
          </label>
          <AutoTextarea
            id="tts-clone-reference-text"
            value={referenceText}
            onChange={(event) => setReferenceText(event.target.value)}
            minRows={2}
            maxRows={4}
            placeholder={t("tts_clone_reference_text_placeholder")}
          />
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <span className={lblCls}>{t("tts_clone_file_label")}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="tts-clone-file-btn"
            className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
            onClick={() => fileRef.current?.click()}
          >
            <Ic.import />
            {t("tts_clone_choose_file")}
          </button>
          <span data-testid="tts-clone-file-name" className="min-w-0 truncate font-ui text-[12px] text-t3">
            {files.length === 0
              ? t("tts_clone_no_file")
              : files.length === 1
                ? files[0].name
                : t("tts_clone_files_selected", { count: files.length })}
          </span>
          <input
            ref={fileRef}
            className="hidden"
            type="file"
            multiple
            data-testid="tts-clone-file"
            accept={formats.map((f) => "." + f).join(",") + ",audio/*"}
            onChange={(event) => {
              handleFiles(Array.from(event.target.files ?? []));
            }}
          />
        </div>
        {files.length > 1 && (
          <div data-testid="tts-clone-sample-list" className="flex flex-col gap-0.5">
            {files.map((file, index) => (
              <span key={`${file.name}-${index}`} data-testid="tts-clone-sample-row" className="min-w-0 truncate font-ui text-[11px] text-t3">
                {t("tts_clone_sample_row", {
                  name: file.name,
                  seconds: (durations?.[index] ?? 0).toFixed(1),
                })}
              </span>
            ))}
          </div>
        )}
        {totalSeconds !== null && (
          <div data-testid="tts-clone-samples-total" className="font-ui text-[11px] text-t3">
            {t("tts_clone_samples_total", {
              seconds: totalSeconds.toFixed(1),
              count: files.length,
            })}
          </div>
        )}
        {totalSeconds !== null && (totalSeconds < 10 || totalSeconds > 30) && (
          <div data-testid="tts-clone-duration-warning" className="font-ui text-[11px] text-t4">
            {t("tts_clone_duration_warning")}
          </div>
        )}
        <div data-testid="tts-clone-hint" className="font-ui text-[11px] text-t4">
          {t("tts_clone_hint", { formats: formats.join(" · "), size: maxMb })}
        </div>
        {backend === "minimax" ? (
          <div data-testid="tts-clone-hint-minimax" className="font-ui text-[11px] text-t4">
            {t("tts_clone_hint_minimax")}
          </div>
        ) : null}
        {backend === "volcengine" ? (
          <div data-testid="tts-clone-hint-volcengine" className="font-ui text-[11px] text-t4">
            {t("tts_clone_hint_volcengine")}
          </div>
        ) : null}
        {capabilities.cloneCaveatKey === "siliconflow" ? (
          <div data-testid="tts-clone-hint-siliconflow" className="font-ui text-[11px] text-t4">
            {t("tts_clone_hint_siliconflow")}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="tts-clone-submit"
          disabled={busy}
          className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40 disabled:pointer-events-none"
          onClick={() => void handleClone()}
        >
          <Ic.user />
          {busy ? t("tts_clone_busy") : t("tts_clone_action")}
        </button>
        {error !== null && (
          <span data-testid="tts-clone-error" className="font-ui text-[11px] text-danger">
            {error}
          </span>
        )}
        {result !== null && (
          <span data-testid="tts-clone-success" className="font-ui text-[11px] text-t2">
            {result}
          </span>
        )}
      </div>
    </TtsSectionCard>
  );
}
