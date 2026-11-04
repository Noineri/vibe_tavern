import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "../../i18n/context.js";
import type Resources from "../../i18n/resources.js";
import {
  downloadDiagnosticsZip,
  fetchDiagnosticsGenerationPreview,
  fetchDiagnosticsManifest,
  type DiagnosticsGenerationPreview,
  type DiagnosticsGenerationSelection,
  type DiagnosticsManifestEntry,
} from "../../api/diagnostics-api.js";
import { fetchTraceHistory } from "../../api/chat-api.js";
import type { PromptTraceRecordDto } from "@vibe-tavern/domain";
import { useChatStore } from "../../stores/chat-store.js";
import { formatBytes } from "../../lib/format-bytes.js";
import { codeQuoteCls, lblCls } from "../../lib/field-tokens.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { Toggle } from "../shared/Toggle.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";

/**
 * SM-9b: the diagnostics export flow, extracted from the About project block
 * into its own settings block. Every export starts technical-only; attaching
 * ONE selected generation's data is an unchecked per-export opt-in that needs
 * a preview and a separate confirmation — consent is never remembered, and
 * cancel/deselect always leaves the technical-only download available.
 */

/** Compact canon action button (frontend skill): icon by meaning, one shape. */
const compactActionCls = "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-60";

/** Zip path → its i18n description; the list shows the scope before any download. */
const ENTRY_DESCRIPTION: Record<string, keyof Resources["en"]> = {
  "vt-info.json": "settings_about_diag_info",
  "server-log.txt": "settings_about_diag_log",
  "provider-profiles.json": "settings_about_diag_providers",
  "data-sizes.json": "settings_about_diag_sizes",
  "generation/request.json": "settings_about_diag_gen_request",
  "generation/response.json": "settings_about_diag_gen_response",
  "generation/metadata.json": "settings_about_diag_gen_metadata",
};

/** Internal capture-field names (SM-9a `missing` values) → their user-facing names. */
const MISSING_FIELD_LABEL: Record<string, keyof Resources["en"]> = {
  finalPayload: "settings_about_diag_missing_request",
  providerResponse: "settings_about_diag_missing_response",
};

type DiagnosticsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "listed"; entries: DiagnosticsManifestEntry[] };

/** The attachment area, only reachable through the unchecked opt-in. */
type AttachState = "off" | "listing" | "ready" | "failed" | "noChat";
type PreviewState = { kind: "idle" | "loading" | "failed" } | { kind: "ready"; value: DiagnosticsGenerationPreview };

function selectionOfTrace(trace: PromptTraceRecordDto): DiagnosticsGenerationSelection {
  return {
    traceId: trace.id,
    chatId: trace.chatId,
    branchId: trace.branchId,
    messageId: trace.messageId,
    variantId: trace.variantId ?? null,
  };
}

/** Full date matters: different days can have attempts at the same time. */
function traceOptionLabel(trace: PromptTraceRecordDto, locale: string): string {
  const time = new Date(trace.createdAt).toLocaleString(locale);
  return `${time} · ${trace.model}`;
}

function saveBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `vibe-tavern-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function DiagnosticsSettingsBlock() {
  const { t, locale } = useT();
  const [diag, setDiag] = useState<DiagnosticsState>({ kind: "idle" });
  const [attach, setAttach] = useState<AttachState>("off");
  const [traces, setTraces] = useState<PromptTraceRecordDto[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [confirmation, setConfirmation] = useState<DiagnosticsGenerationSelection | null>(null);
  const [downloading, setDownloading] = useState(false);
  const active = useRef(false);
  const revision = useRef(0);
  const downloadRequest = useRef(0);
  const busy = useRef(false);
  // Identity is frozen at selection, not re-read from active chat after await.
  const selectionRef = useRef<DiagnosticsGenerationSelection | null>(null);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; revision.current++; selectionRef.current = null; };
  }, []);
  const isCurrent = (request: number) => active.current && revision.current === request;
  const invalidateSelection = () => {
    revision.current++;
    selectionRef.current = null;
    setSelectedId("");
    setPreview({ kind: "idle" });
    setConfirmation(null);
    busy.current = false;
    setDownloading(false);
    return revision.current;
  };
  const resetToIdle = () => {
    invalidateSelection();
    setAttach("off"); setTraces([]); setDiag({ kind: "idle" });
  };
  const collectDiagnostics = async () => {
    resetToIdle();
    const request = revision.current;
    setDiag({ kind: "loading" });
    try {
      const manifest = await fetchDiagnosticsManifest();
      if (isCurrent(request)) setDiag({ kind: "listed", entries: manifest.entries });
    } catch {
      if (!isCurrent(request)) return;
      setDiag({ kind: "idle" });
      toast.error(t("settings_about_diag_failed"));
    }
  };

  const onAttachToggle = async (checked: boolean) => {
    const request = invalidateSelection();
    setTraces([]);
    if (!checked) { setAttach("off"); return; }
    const chatId = useChatStore.getState().activeChatId;
    if (!chatId) { setAttach("noChat"); return; }
    setAttach("listing");
    try {
      const history = await fetchTraceHistory(chatId);
      if (!isCurrent(request)) return;
      setTraces(history.filter((trace) => trace.chatId === chatId));
      setAttach("ready");
    } catch {
      if (isCurrent(request)) setAttach("failed");
    }
  };

  const onPickTrace = async (traceId: string) => {
    const request = invalidateSelection();
    const trace = traces.find((candidate) => candidate.id === traceId);
    if (!trace) return;
    const selection = selectionOfTrace(trace);
    selectionRef.current = selection;
    setSelectedId(trace.id);
    setPreview({ kind: "loading" });
    try {
      const value = await fetchDiagnosticsGenerationPreview(selection);
      if (!isCurrent(request)) return;
      // A mismatched server echo is not consent to inspect/export another attempt.
      if (Object.entries(selection).some(([key, expected]) => value.selection[key as keyof DiagnosticsGenerationSelection] !== expected)) throw new Error("Diagnostics preview identity mismatch");
      setPreview({ kind: "ready", value });
    } catch {
      if (isCurrent(request)) setPreview({ kind: "failed" });
    }
  };

  const download = async (selection?: DiagnosticsGenerationSelection) => {
    if (busy.current) return;
    if (selection && (selectionRef.current !== selection || preview.kind !== "ready")) return;
    const scope = revision.current;
    const request = ++downloadRequest.current;
    busy.current = true; setDownloading(true); setConfirmation(null);
    try {
      const blob = await downloadDiagnosticsZip(selection ? { selection, confirmed: true } : undefined);
      if (!isCurrent(scope) || request !== downloadRequest.current) return;
      saveBlob(blob);
      resetToIdle();
    } catch {
      if (isCurrent(scope) && request === downloadRequest.current) toast.error(t("settings_about_diag_failed"));
    } finally {
      if (isCurrent(scope) && request === downloadRequest.current) { busy.current = false; setDownloading(false); }
    }
  };

  return (
    <>
        <button type="button" disabled={diag.kind === "loading" || downloading} className={compactActionCls} onClick={() => void collectDiagnostics()}>
          <Icons.clipboard />
          {t("settings_about_diagnostics")}
        </button>
      {diag.kind === "listed" && (
        <div className="mt-3 min-w-0 basis-full space-y-3">
          {/* The user sees exactly what the zip will hold before saving it. */}
          <ul className="space-y-1.5">
            {diag.entries.map((entry) => (
              <li key={entry.path} className="flex items-baseline justify-between gap-3 font-ui text-[calc(var(--ui-fs)-3px)]">
                <span className="min-w-0 break-words text-t2">{t(ENTRY_DESCRIPTION[entry.path] ?? "settings_about_diagnostics")}</span>
                <span className="shrink-0 text-t3">{formatBytes(entry.bytes)}</span>
              </li>
            ))}
          </ul>

          {/* The unchecked per-export opt-in — never persisted, never remembered. */}
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0">
              <div className="text-[calc(var(--ui-fs)-2px)] text-t2">{t("settings_about_diag_attach_toggle")}</div>
              <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] text-t3">{t("settings_about_diag_attach_hint")}</div>
            </div>
            <Toggle
              checked={attach !== "off"}
              aria-label={t("settings_about_diag_attach_toggle")}
              onChange={(checked) => void onAttachToggle(checked)}
            />
          </div>

          {attach === "listing" && (
            <div role="status" className="text-[calc(var(--ui-fs)-3px)] text-t3">{t("settings_about_diag_attach_loading")}</div>
          )}
          {(attach === "failed" || attach === "noChat") && (
            <div className="text-[calc(var(--ui-fs)-3px)] text-t3">
              {t(attach === "noChat" ? "settings_about_diag_attach_no_chat" : "settings_about_diag_attach_failed")}
              <button type="button" className={`${compactActionCls} mt-2`} onClick={() => void onAttachToggle(true)}>{t("retry")}</button>
            </div>
          )}
          {attach === "ready" && (
            traces.length === 0 ? (
              <div className="text-[calc(var(--ui-fs)-3px)] text-t3">{t("settings_about_diag_attach_no_traces")}</div>
            ) : (
              <div role="group" aria-label={t("settings_about_diag_attach_pick_label")}>
                <div className={lblCls}>{t("settings_about_diag_attach_pick_label")}</div>
                <DropdownSelect
                  value={selectedId}
                  searchable
                  triggerDetail={false}
                  placeholder={t("settings_about_diag_attach_pick_placeholder")}
                  options={traces.map((trace) => ({
                    id: trace.id,
                    label: traceOptionLabel(trace, locale),
                    detail: `${trace.chatId} · ${trace.branchId} · ${trace.messageId} · ${trace.variantId ?? "—"} · ${trace.id}`,
                  }))}
                  onChange={(id) => void onPickTrace(id)}
                />
              </div>
            )
          )}
          {preview.kind === "loading" && (
            <div role="status" className="text-[calc(var(--ui-fs)-3px)] text-t3">{t("settings_about_diag_preview_loading")}</div>
          )}
          {preview.kind === "failed" && <div role="alert" className="text-[calc(var(--ui-fs)-3px)] text-t3">
            {t("settings_about_diag_preview_failed")}
            <button type="button" className={`${compactActionCls} mt-2`} onClick={() => void onPickTrace(selectedId)}>{t("retry")}</button>
          </div>}
          {preview.kind === "ready" && (
            <div className="space-y-3">
              {/* What the attachment adds — the actually captured files only. */}
              <div className="mb-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2">
                {t("settings_about_diag_attached_list")} · {preview.value.model} · {new Date(preview.value.createdAt).toLocaleString(locale)}
              </div>
              <p className="break-words font-mono text-[calc(var(--ui-fs)-3px)] text-t3">{Object.values(preview.value.selection).map((value) => value ?? "—").join(" · ")}</p>
              {preview.value.missing.length > 0 && (
                <div className="text-[calc(var(--ui-fs)-3px)] text-t3">
                  {t("settings_about_diag_preview_missing", {
                    fields: preview.value.missing.map((field) => t(MISSING_FIELD_LABEL[field] ?? "settings_about_diag_missing_unknown")).join(", "),
                  })}
                </div>
              )}
              {preview.value.files.map((file) => (
                <div key={file.path}>
                  <div className="mb-1 flex items-baseline justify-between gap-3 font-ui text-[calc(var(--ui-fs)-3px)]">
                    <span className="min-w-0 break-words text-t2">{t(ENTRY_DESCRIPTION[file.path] ?? "settings_about_diagnostics")}<span className="mt-0.5 block font-mono text-t3">{file.path}</span></span>
                    <span className="shrink-0 text-t3">{formatBytes(file.bytes)}</span>
                  </div>
                  {/* Inspect the REDACTED capture before confirming the save —
                      content-specific ceiling per the codeQuote canon. */}
                  <pre className={cn(codeQuoteCls, "max-h-56 overflow-auto")}>{file.text}</pre>
                </div>
              ))}
              <div className="text-[calc(var(--ui-fs)-3px)] leading-relaxed text-t3">{t("settings_about_diag_attach_warning")}</div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-on-accent transition-[filter] hover:brightness-110 disabled:opacity-60"
                  disabled={downloading}
                  onClick={() => setConfirmation(selectionRef.current)}
                >
                  <Icons.download />
                  {t("settings_about_diag_content_download")}
                </button>
                <button type="button" className={compactActionCls} onClick={() => void onAttachToggle(false)}>
                  {t("settings_about_diag_attach_deselect")}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-on-accent transition-[filter] hover:brightness-110 disabled:opacity-60"
              disabled={downloading}
              onClick={() => void download()}
            >
              <Icons.download />
              {t("settings_about_diag_download")}
            </button>
            <button type="button" className={compactActionCls} onClick={resetToIdle}>
              {t("settings_about_diag_cancel")}
            </button>
          </div>
        </div>
      )}
      {confirmation && preview.kind === "ready" && (
        <DestructiveConfirmModal
          tone="calm"
          title={t("settings_about_diag_content_confirm_title")}
          body={t("settings_about_diag_content_confirm_body")}
          confirmLabel={t("settings_about_diag_content_confirm")}
          onConfirm={() => {
            void download(confirmation);
          }}
          onCancel={() => setConfirmation(null)}
        />
      )}
    </>
  );
}
