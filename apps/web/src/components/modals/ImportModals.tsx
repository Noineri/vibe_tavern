import type React from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ChatId } from "@vibe-tavern/domain";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { Modal } from "../shared/Modal.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { fetchBootstrapAction, fetchPersonasAction } from "../../stores/api-actions/bootstrap-actions.js";
import { loadPromptPresetsAction } from "../../stores/api-actions/preset-actions.js";
import { inputCls } from "../build/fields/field-styles.js";
import {
  openNativeDialog,
  scanStDirectory,
  importStDirectoryStream,
} from "../../api/import-api.js";
import type { StScanResult, StImportResult, StScanError, ImportPhase } from "../../api/import-api.js";
import {
  initial,
  truncate,
  parseCharacterFile,
  parseChatFile,
  type CharacterPreview,
  type ChatPreview,
} from "./import/parse-import-file.js";

interface ImportModalCommonProps {
  isImporting: boolean;
  onClose: () => void;
  onImportFiles: (files: File[]) => void;
}

// ─── ST Folder import sub-component ─────────────────────────────────────
//
// Backend-driven flow (ST_NATIVE_DIALOG_IMPORT_PLAN). The previous flow scanned
// the folder in the browser via <input webkitdirectory>, parsed every card on
// the main thread, and POSTed each one individually — a PNG-decode + HTTP
// roundtrip storm that froze the UI. Now: native OS folder picker obtains a
// path; the backend reads + parses + imports every surface (characters,
// chats, lorebooks, presets, personas) directly from disk. The frontend just
// drives three buttons. Mobile is excluded — native desktop picker is the
// whole point, and ST import is meaningless without a SillyTavern install
// on the same machine.

interface StFolderImportProps {
  onImported?: () => void;
}

export function StFolderImport({ onImported }: StFolderImportProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  // Mobile guard — ST folder import requires a desktop SillyTavern install +
  // the native OS folder picker (desktop-only endpoint). Hide the whole panel
  // rather than rendering a broken control. The entry buttons in the parent
  // modals are also gated on !isMobile so mobile users never reach this state.
  if (isMobile) return null;

  const [path, setPath] = useState("");
  const [dialogLoading, setDialogLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<StScanResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<StImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<StScanError[]>([]);
  // Live import progress, fed from the SSE stream (importStDirectoryStream).
  // `activePhase` is the surface currently being processed; `counts[phase]` is
  // the running item count. Per-phase totals come from `scanResult`, which is
  // always present when importing (the Import button renders only after scan).
  const [progress, setProgress] = useState<{ activePhase: ImportPhase | null; counts: Partial<Record<ImportPhase, number>> }>({ activePhase: null, counts: {} });

  async function onBrowse() {
    setError(null);
    setDialogLoading(true);
    try {
      const result = await openNativeDialog();
      if ("path" in result) {
        setPath(result.path);
        // A new folder invalidates any prior scan/import.
        setScanResult(null);
        setImportResult(null);
        setImportErrors([]);
      } else if ("cancelled" in result) {
        // User dismissed the dialog — leave everything as-is.
      } else if ("available" in result) {
        // Linux stub (or future unsupported platform): tell the user to type
        // the path manually. The text input below stays editable.
        setError(t("st_dialog_unavailable"));
      } else {
        // { error: string } — broken PowerShell/osascript, etc.
        setError(result.error);
      }
    } catch (err) {
      // AbortError from the 5-min client timeout, or a network failure.
      setError(err instanceof Error ? err.message : t("st_scan_failed"));
    } finally {
      setDialogLoading(false);
    }
  }

  async function onScan() {
    const trimmed = path.trim();
    if (!trimmed || scanning) return;
    setError(null);
    setScanResult(null);
    setImportResult(null);
    setImportErrors([]);
    setScanning(true);
    try {
      const result = await scanStDirectory(trimmed);
      const totalImportable =
        result.characters.length +
        result.chats.length +
        result.lorebooks.length +
        result.presets.length +
        (result.persona?.count ?? 0);
      if (totalImportable === 0 && result.errors.length === 0) {
        setError(t("st_no_files"));
      } else {
        setScanResult(result);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("st_scan_failed"));
    } finally {
      setScanning(false);
    }
  }

  async function onImport() {
    const trimmed = path.trim();
    if (!trimmed || importing) return;
    setError(null);
    setImportErrors([]);
    setProgress({ activePhase: null, counts: {} });
    setImporting(true);
    try {
      const result = await importStDirectoryStream(trimmed, (event) => {
        if (event.type === "phase") {
          setProgress((p) => ({ activePhase: event.phase, counts: p.counts }));
        } else {
          setProgress((p) => ({
            activePhase: event.phase,
            counts: { ...p.counts, [event.phase]: event.current },
          }));
        }
      });
      setImportResult(result);
      setImportErrors(result.errors);

      const msg = t("st_import_results", {
        characters: result.characters,
        chats: result.chats,
        lorebooks: result.lorebooks,
        presets: result.presets,
        personas: result.personas,
      });
      toast.success(msg);
      if (result.errors.length > 0) {
        toast.warning(t("st_import_errors", { count: result.errors.length }));
      }

      // Refresh stores so the newly imported surfaces appear without a reload.
      // Sequential to avoid racing bootstrapStore.
      await fetchBootstrapAction({ silent: true });
      await fetchPersonasAction();
      await loadPromptPresetsAction();

      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("st_scan_failed"));
    } finally {
      setImporting(false);
    }
  }

  const pathEmpty = path.trim().length === 0;
  const scanCounts = scanResult
    ? scanResult.characters.length +
      scanResult.chats.length +
      scanResult.lorebooks.length +
      scanResult.presets.length +
      (scanResult.persona?.count ?? 0)
    : 0;

  return (
    <div className="rounded-lg border border-border2 bg-s2 p-4">
      <div className="mb-3 font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-t1">
        SillyTavern
      </div>

      <details className="mb-3">
        <summary className="cursor-pointer font-ui text-xs text-t3 hover:text-t2 transition-colors">
          {t("st_where_to_find")}
        </summary>
        <div className="mt-1.5 rounded border border-border2 bg-surface p-2.5 font-mono text-[calc(var(--ui-fs)-2px)] text-t3 leading-relaxed">
          <div>SillyTavern/data/default-user <span className="text-t4">← {t("st_hint_root")}</span></div>
          <div>SillyTavern/data/default-user/characters <span className="text-t4">← {t("st_hint_characters")}</span></div>
          <div>SillyTavern/data/default-user/chats <span className="text-t4">← {t("st_hint_chats")}</span></div>
          <div>SillyTavern/data/default-user/worlds <span className="text-t4">← {t("st_hint_worlds")}</span></div>
        </div>
      </details>

      {/* Path row: editable text input + native-picker Browse button. */}
      <div className="mb-2 flex gap-2">
        <input
          type="text"
          className={inputCls + " h-[38px] px-3 font-ui text-[calc(var(--ui-fs)-2px)]"}
          placeholder={t("st_path_placeholder")}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          disabled={dialogLoading || scanning || importing}
        />
        <button type="button"
          className="flex h-[38px] shrink-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 transition-all hover:border-accent hover:text-accent-t disabled:cursor-default disabled:opacity-45"
          onClick={onBrowse}
          disabled={dialogLoading || scanning || importing}
        >
          <Icons.Import />
          {t("st_browse_btn")}
        </button>
      </div>

      {dialogLoading && <BusyLine label={t("st_dialog_loading")} />}

      {/* Scan button: appears once a path is entered. */}
      {!dialogLoading && (
        <button type="button"
          className="mt-1 h-[34px] cursor-pointer rounded-md border border-border2 bg-surface px-5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 transition-all hover:border-accent hover:text-accent-t disabled:cursor-default disabled:opacity-45"
          onClick={onScan}
          disabled={pathEmpty || scanning || importing}
        >
          {t("st_scan_btn")}
        </button>
      )}

      {scanning && <div className="mt-2"><BusyLine label={t("st_scanning")} /></div>}

      {/* Scan results: counts + scan errors. */}
      {scanResult && !scanning && !importing && (
        <div className="mt-3">
          <div className="mb-2.5 font-ui text-xs text-t2">
            {t("st_scan_results", {
              personas: scanResult.persona?.count ?? 0,
              characters: scanResult.characters.length,
              chats: scanResult.chats.length,
              presets: scanResult.presets.length,
              lorebooks: scanResult.lorebooks.length,
            })}
          </div>
          <button type="button"
            className="h-[34px] cursor-pointer rounded-md bg-accent px-5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-45"
            disabled={scanCounts === 0}
            onClick={onImport}
          >
            {t("st_folder_import")}
          </button>
          {scanResult.errors.length > 0 && (
            <details className="mt-2.5">
              <summary className="cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-warning">
                {t("st_import_errors", { count: scanResult.errors.length })}
              </summary>
              <div className="mt-1.5 max-h-48 overflow-y-auto rounded border border-border2 bg-surface p-2">
                {scanResult.errors.map((e, i) => (
                  <div key={i} className="border-b border-border2 py-1 last:border-0">
                    <div className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">{e.file}</div>
                    <div className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{e.message}</div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Import in progress — live per-phase progress fed from the SSE stream. */}
      {importing && scanResult && (
        <StImportProgress scanResult={scanResult} progress={progress} />
      )}
      {importing && !scanResult && (
        <div className="mt-3">
          <BusyLine label={t("st_importing_backend")} />
        </div>
      )}

      {/* Import result summary + per-item errors. */}
      {importResult && !importing && (
        <div className="mt-3">
          <div className="font-ui text-xs text-t2">
            {t("st_import_results", {
              characters: importResult.characters,
              chats: importResult.chats,
              lorebooks: importResult.lorebooks,
              presets: importResult.presets,
              personas: importResult.personas,
            })}
          </div>
          {importErrors.length > 0 && (
            <details className="mt-2.5">
              <summary className="cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-warning">
                {t("st_import_errors", { count: importErrors.length })}
              </summary>
              <div className="mt-1.5 max-h-48 overflow-y-auto rounded border border-border2 bg-surface p-2">
                {importErrors.map((e, i) => (
                  <div key={i} className="border-b border-border2 py-1 last:border-0">
                    <div className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">{e.file}</div>
                    <div className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{e.message}</div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {error && (
        <div className="mt-2 font-ui text-[calc(var(--ui-fs)-2px)] text-error">{error}</div>
      )}
    </div>
  );
}
// ─── CharacterImportModal ──────────────────────────────────────────────────

export function CharacterImportModal(input: ImportModalCommonProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [drag, setDrag] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<CharacterPreview | null>(null);
  const [stMode, setStMode] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => {
    if (preview?.avatarUrl) URL.revokeObjectURL(preview.avatarUrl);
  }, [preview?.avatarUrl]);

  async function processFile(file?: File | null): Promise<void> {
    if (!file) return;
    setParsing(true);
    setPreview((current) => {
      if (current?.avatarUrl) URL.revokeObjectURL(current.avatarUrl);
      return null;
    });
    try {
      setPreview(await parseCharacterFile(file));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("import_error_read_card"));
    } finally {
      setParsing(false);
    }
  }

  function confirm(): void {
    if (!preview || input.isImporting) return;
    input.onImportFiles([preview.file]);
    input.onClose();
  }

  return (
    <ImportModalFrame title={t("character_import_title")} subtitle={t("character_import_sub")} onClose={input.onClose}>
      <div className="flex-1 overflow-y-auto p-5">
        {!preview && !parsing && !stMode && (
          <>
            <Dropzone
              drag={drag}
              setDrag={setDrag}
              accept=".png,.json,image/png,application/json"
              fileRef={fileRef}
              title={t("click_or_drop_file")}
              subtitle={t("st_jsonl_png_supported")}
              onFile={processFile}
            />
            {!isMobile && (
              <div className="mt-3 flex items-center gap-3">
                <div className="flex-1 border-t border-border2" />
                <button type="button"
                  className="cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-accent-t transition-colors hover:text-accent"
                  onClick={() => setStMode(true)}
                >
                  {t("or_import_from_st")}
                </button>
              </div>
            )}
          </>
        )}
        {stMode && !parsing && (
          <StFolderImport onImported={input.onClose} />
        )}
        {parsing && <BusyLine label={t("analyzing_metadata")} />}
        {preview && !parsing && (
          <div>
            <div className="flex gap-4 rounded-lg border border-border bg-s2 p-4">
              {preview.avatarUrl ? (
                <img src={preview.avatarUrl} className="h-16 w-16 shrink-0 rounded-lg bg-s3 object-cover object-top" alt="" />
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-s3 font-body text-2xl italic text-t3">{initial(preview.name)}</div>
              )}
              <div className="min-w-0 flex-1 font-ui">
                <div className="mb-1 text-base font-medium text-t1">{preview.name}</div>
                <div className="line-clamp-3 mb-2.5 text-xs leading-relaxed text-t3">{preview.description || t("no_description")}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {preview.tags.slice(0, 6).map((tag) => <span key={tag} className="rounded bg-s3 px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t2">{tag}</span>)}
                </div>
              </div>
            </div>
            <div className="mt-3 font-ui text-xs text-t3">{t("ready_to_import", { name: preview.file.name })}</div>
          </div>
        )}
      </div>
      <ModalFooter onClose={input.onClose} confirmLabel={t("add_to_library")} disabled={!preview || input.isImporting} busy={input.isImporting} onConfirm={confirm} />
    </ImportModalFrame>
  );
}

// ─── ChatImportModal ───────────────────────────────────────────────────────

export function ChatImportModal(input: ImportModalCommonProps & { activeChatId: ChatId | null }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [drag, setDrag] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<ChatPreview | null>(null);
  const [stMode, setStMode] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function processFile(file?: File | null): Promise<void> {
    if (!file) return;
    setParsing(true);
    setPreview(null);
    try {
      setPreview(await parseChatFile(file));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("import_error_read_chat"));
    } finally {
      setParsing(false);
    }
  }

  function confirm(): void {
    if (!preview || input.isImporting) return;
    input.onImportFiles([preview.file]);
    input.onClose();
  }

  return (
    <ImportModalFrame title={t("chat_import_title")} subtitle={t("chat_import_sub")} onClose={input.onClose}>
      <div className="flex-1 overflow-y-auto p-5">
        {!preview && !parsing && !stMode && (
          <>
            <Dropzone
              drag={drag}
              setDrag={setDrag}
              accept=".jsonl"
              fileRef={fileRef}
              title={t("click_or_drop_chat")}
              subtitle={t("st_jsonl_supported")}
              onFile={processFile}
            />
            {!isMobile && (
              <div className="mt-3 flex items-center gap-3">
                <div className="flex-1 border-t border-border2" />
                <button type="button"
                  className="cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-accent-t transition-colors hover:text-accent"
                  onClick={() => setStMode(true)}
                >
                  {t("or_import_from_st_chat")}
                </button>
              </div>
            )}
          </>
        )}
        {stMode && !parsing && (
          <StFolderImport onImported={input.onClose} />
        )}
        {parsing && <BusyLine label={t("reading_chat_history")} />}
        {preview && !parsing && (
          <div>
            <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-s2 px-4 py-3">
              <div>
                <div className="font-ui text-sm font-medium text-t1">{t("parsed_preview")}</div>
                <div className="font-ui text-xs text-t3">{preview.fileName} · {preview.messageCount} {t("import_messages_label")} · {t("import_character_label")} {preview.characterName}</div>
              </div>
              <div className="rounded-full bg-success-dim px-2.5 py-0.5 font-ui text-xs font-medium text-success-text">{t("ready")}</div>
            </div>
            <div className="max-h-[250px] overflow-y-auto">
              {preview.messages.map((message, index) => (
                <div key={index} className={cn("flex items-start gap-2 rounded-md px-2 py-1.5", message.role === "user" && "bg-s2")}>
                  <div className={cn("min-w-[44px] shrink-0 pt-0.5 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold", message.role === "user" ? "text-info" : "text-accent-t")}>{message.name}</div>
                  <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t2">{truncate(message.text, 140)}</div>
                </div>
              ))}
            </div>
            <div className="mt-2 font-ui text-xs text-t3">{t("showing_parsed_messages", { n: preview.messages.length })}</div>
          </div>
        )}
      </div>
      <ModalFooter onClose={input.onClose} confirmLabel={t("confirm_import")} disabled={!preview || input.isImporting} busy={input.isImporting} onConfirm={confirm} />
    </ImportModalFrame>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────

function ImportModalFrame(props: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  return (
    <Modal open={true} onClose={props.onClose}>
      <div className={cn("flex flex-col overflow-hidden bg-surface", isMobile ? "w-full h-full" : "max-h-[calc(100vh-60px)] w-[500px] max-w-[calc(100vw-32px)] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]")}>
        <div className={cn("shrink-0", isMobile ? "px-4 pt-4" : "px-5 pt-[18px]")}>
          <div className="flex items-start justify-between">
            <div>
              <div className={cn("mb-0.5 font-body font-medium text-t1", isMobile ? "text-lg" : "text-[calc(var(--ui-fs)+4px)]")}>{props.title}</div>
              <div className={cn("mb-3.5 font-ui text-t3", isMobile ? "text-xs" : "text-[calc(var(--ui-fs)-2px)]")}>{props.subtitle}</div>
            </div>
            <button type="button" className={cn("flex shrink-0 cursor-pointer items-center justify-center text-t3 transition-all hover:bg-s2 hover:text-t1", isMobile ? "h-10 w-10 rounded-lg active:bg-s2" : "h-8 w-8 rounded-[5px]")} onClick={props.onClose} aria-label={t("close")}><Icons.Close /></button>
          </div>
        </div>
        {props.children}
      </div>
    </Modal>
  );
}

function Dropzone(props: {
  drag: boolean;
  setDrag: (drag: boolean) => void;
  accept: string;
  fileRef: React.RefObject<HTMLInputElement | null>;
  title: string;
  subtitle: string;
  onFile: (file?: File | null) => void;
}) {
  return (
    <div
      className={cn("flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed px-5 py-10 font-ui text-t3 transition-all hover:border-accent hover:bg-s2 hover:text-t2", props.drag && "border-accent bg-s2 text-t2")}
      onDragOver={(event) => { event.preventDefault(); props.setDrag(true); }}
      onDragLeave={() => props.setDrag(false)}
      onDrop={(event) => { event.preventDefault(); props.setDrag(false); props.onFile(event.dataTransfer.files[0]); }}
      onClick={() => props.fileRef.current?.click()}
    >
      <input ref={props.fileRef} className="hidden" type="file" accept={props.accept} onChange={(event) => props.onFile(event.target.files?.[0])} />
      <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-s3 text-t2 transition-all"><Icons.Import /></div>
      <div className="font-ui text-sm">{props.title}</div>
      <div className="font-ui text-xs text-t4">{props.subtitle}</div>
    </div>
  );
}

function BusyLine(props: { label: string }) {
  return <div className="flex items-center gap-2 font-ui text-t2"><span className="inline-flex items-center gap-[3px]"><span className="h-1 w-1 rounded-full bg-accent animate-genp"/><span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/><span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/></span>{props.label}</div>;
}

// Fixed import order (matches the scanner's phase sequence).
const IMPORT_PHASES: ImportPhase[] = ["characters", "chats", "lorebooks", "presets", "personas"];

/** Per-phase progress breakdown for a streaming ST directory import. Reuses
 *  the old bar visual (animated accent dots + width:% fill) but drives it from
 *  SSE events instead of a frontend loop. Per-phase totals come from the prior
 *  scanResult; the current surface is highlighted, completed surfaces are
 *  ticked, pending ones are dimmed. */
function StImportProgress(props: {
  scanResult: StScanResult;
  progress: { activePhase: ImportPhase | null; counts: Partial<Record<ImportPhase, number>> };
}) {
  const { t, tDynamic } = useT();
  const totals: Record<ImportPhase, number> = {
    characters: props.scanResult.characters.length,
    chats: props.scanResult.chats.length,
    lorebooks: props.scanResult.lorebooks.length,
    presets: props.scanResult.presets.length,
    personas: props.scanResult.persona?.count ?? 0,
  };
  const activeIdx = props.progress.activePhase ? IMPORT_PHASES.indexOf(props.progress.activePhase) : -1;

  return (
    <div className="mt-3 space-y-2">
      <BusyLine label={t("st_importing_backend")} />
      <div className="space-y-1.5">
        {IMPORT_PHASES.map((phase, idx) => {
          const total = totals[phase];
          const current = props.progress.counts[phase] ?? 0;
          const status = idx < activeIdx ? "done" : idx === activeIdx ? "active" : "pending";
          // A surface with zero items (e.g. no lorebooks in the folder) shows as
          // full when passed, empty before — so the bar never looks stuck at 0%.
          const pct = total > 0 ? Math.min(100, (current / total) * 100) : status === "done" ? 100 : 0;
          return (
            <div key={phase} className="space-y-0 font-ui text-[calc(var(--ui-fs)-2px)]">
              <div className="flex items-center gap-2">
                <span className="w-3 shrink-0" />
                <span className="w-20 shrink-0" aria-hidden="true" />
                <span className="shrink-0 text-[calc(var(--ui-fs)-4px)] tabular-nums text-t3">
                  {status === "pending" ? "—" : current}
                </span>
                <div className="flex-1" />
                <span className="shrink-0 text-[calc(var(--ui-fs)-4px)] tabular-nums text-t3">
                  {status === "pending" ? "—" : total}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 shrink-0 text-center text-t3">
                  {status === "done" ? "✓" : status === "active" ? "●" : "○"}
                </span>
                <span className={cn("w-20 shrink-0", status === "pending" ? "text-t3" : "text-t2")}>
                  {tDynamic(`st_phase_${phase}`)}
                </span>
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-s3">
                  <div className="h-full rounded-full bg-accent transition-all duration-150" style={{ width: `${pct}%` }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ModalFooter(props: { onClose: () => void; onConfirm: () => void; confirmLabel: string; disabled: boolean; busy: boolean }) {
  const { t } = useT();
  return <div className="flex shrink-0 items-center gap-2.5 border-t border-border px-5 py-3.5"><button type="button" className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" onClick={props.onClose}>{t("cancel")}</button><button type="button" className="h-[37px] cursor-pointer rounded-md bg-accent px-5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-45" disabled={props.disabled} onClick={props.onConfirm}>{props.busy ? t("importing") : props.confirmLabel}</button></div>;
}
