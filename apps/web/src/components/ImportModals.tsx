import type React from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ChatId } from "@rp-platform/domain";
import { extractPngMetadata, parseCharacterMetadata } from "../lib/png-reader.js";
import { importJson, uploadAsset, updateCharacterAvatar } from "../app-client.js";
import { cn } from "../lib/cn.js";
import { Icons } from "./shared/icons.js";
import { Modal } from "./shared/Modal.js";
import { useIsMobile } from "../hooks/use-mobile.js";
import { useT, getT } from "../i18n/context.js";

interface ImportModalCommonProps {
  isImporting: boolean;
  onClose: () => void;
  onImportFiles: (files: File[]) => void;
}

interface CharacterPreview {
  file: File;
  name: string;
  description: string;
  tags: string[];
  avatarUrl: string | null;
}

interface ChatPreview {
  file: File;
  fileName: string;
  title: string;
  messageCount: number;
  characterName: string;
  messages: Array<{ role: string; name: string; text: string }>;
}

// ─── ST Folder import sub-component ────────────────────────────────────────

interface StFolderImportProps {
  onImported?: () => void;
}

interface StFileEntry {
  file: File;
  relativePath: string;
  kind: "character" | "chat" | "lorebook";
}

function StFolderImport({ onImported }: StFolderImportProps) {
  const { t } = useT();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null);
  const [scanResult, setScanResult] = useState<{
    characters: StFileEntry[];
    chats: StFileEntry[];
    lorebooks: StFileEntry[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<ImportError[]>([]);
  const folderRef = useRef<HTMLInputElement | null>(null);

  async function handleFolderPick(files?: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setScanResult(null);
    setScanning(true);

    try {
      const characters: StFileEntry[] = [];
      const chats: StFileEntry[] = [];
      const lorebooks: StFileEntry[] = [];

      for (const file of Array.from(files)) {
        const rp = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        if (!rp) continue;
        const parts = rp.split("/");

        // Match: .../characters/filename.png or .../characters/filename.json
        if (parts.includes("characters")) {
          const ext = file.name.toLowerCase();
          if (ext.endsWith(".json")) {
            characters.push({ file, relativePath: rp, kind: "character" });
          } else if (ext.endsWith(".png")) {
            // Only include PNGs that have character metadata (chara/ccv3 chunk)
            try {
              const meta = await extractPngMetadata(file);
              const hasChara = meta.some(m => m.keyword === "chara" || m.keyword === "ccv3");
              if (hasChara) {
                characters.push({ file, relativePath: rp, kind: "character" });
              }
            } catch {
              // Not a valid PNG or can't read — skip
            }
          }
        }
        // Match: .../chats/CharacterName/file.jsonl
        else if (parts.includes("chats")) {
          if (file.name.toLowerCase().endsWith(".jsonl")) {
            chats.push({ file, relativePath: rp, kind: "chat" });
          }
        }
        // Match: .../worlds/filename.json
        else if (parts.includes("worlds")) {
          if (file.name.toLowerCase().endsWith(".json")) {
            lorebooks.push({ file, relativePath: rp, kind: "lorebook" });
          }
        }
      }

      if (characters.length + chats.length + lorebooks.length === 0) {
        setError(t("st_no_files"));
      } else {
        setScanResult({ characters, chats, lorebooks });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("st_scan_failed"));
    } finally {
      setScanning(false);
    }
  }

interface ImportError {
    fileName: string;
    reason: string;
  }

  async function handleImport() {
    if (!scanResult) return;
    setError(null);
    setImporting(true);
    setImportErrors([]);

    const total = scanResult.characters.length + scanResult.chats.length;
    let current = 0;
    let importedChars = 0;
    let importedChats = 0;
    const failedItems: ImportError[] = [];

    // Phase 1: Import characters
    // Build a map: character name → chatId for chat matching
    const nameToChatId = new Map<string, ChatId>();

    for (const entry of scanResult.characters) {
      current++;
      setImportProgress({ current, total });
      try {
        let jsonText: string;
        const lowerName = entry.file.name.toLowerCase();
        const isPng = lowerName.endsWith(".png") || entry.file.type === "image/png";

        if (isPng) {
          const metadata = await extractPngMetadata(entry.file);
          const parsed = parseCharacterMetadata(metadata);
          jsonText = JSON.stringify(parsed);
        } else {
          jsonText = await entry.file.text();
        }

        const result = await importJson({ fileName: entry.file.name, jsonText, skipExisting: true });
        importedChars++;

        // Upload PNG as avatar
        if (isPng && result.activeChatId) {
          try {
            const characterId = result.snapshot?.character?.id;
            if (characterId) {
              const asset = await uploadAsset(entry.file);
              await updateCharacterAvatar(characterId, result.activeChatId, asset.assetId);
            }
          } catch {
            // Avatar upload failure is non-critical
          }
        }

        // Map character name → chatId for chat matching
        const parsed = JSON.parse(jsonText);
        const data = typeof parsed.data === 'object' && parsed.data !== null ? parsed.data as Record<string, unknown> : parsed;
        const charName = (data.name as string)?.toLowerCase() ?? "";
        if (result.activeChatId) {
          nameToChatId.set(charName, result.activeChatId);
          // Also map by slug
          const slug = charName.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
          nameToChatId.set(slug, result.activeChatId);
        }
      } catch (err) {
        failedItems.push({
          fileName: entry.file.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 2: Import chats
    for (const entry of scanResult.chats) {
      current++;
      setImportProgress({ current, total });
      try {
        const parts = entry.relativePath.split("/");
        const chatIdx = parts.indexOf("chats");
        const characterFolder = chatIdx >= 0 && chatIdx + 1 < parts.length ? parts[chatIdx + 1] : "";
        const chatId = nameToChatId.get(characterFolder.toLowerCase());

        const jsonText = await entry.file.text();
        await importJson({ fileName: entry.file.name, jsonText, chatId });
        importedChats++;
      } catch (err) {
        failedItems.push({
          fileName: entry.relativePath,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    setImporting(false);
    setImportProgress(null);
    setImportErrors(failedItems);

    const msg = t("st_import_results")
      .replace("{characters}", String(importedChars))
      .replace("{chats}", String(importedChats))
      .replace("{lorebooks}", "0");
    toast.success(msg);
    if (failedItems.length > 0) {
      toast.warning(t("st_import_errors").replace("{count}", String(failedItems.length)));
    }
    onImported?.();
  }

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

      {!scanResult && !scanning && (
        <>
          <div className="mb-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("st_select_folder")}</div>
          <button
            className="flex h-[38px] cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-4 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 transition-all hover:border-accent hover:text-accent-t"
            onClick={() => folderRef.current?.click()}
          >
            <Icons.Import />
            {t("st_browse")}
          </button>
          <input
            ref={folderRef}
            className="hidden"
            type="file"
            /** @ts-expect-error webkitdirectory is not in React types */
            webkitdirectory=""
            directory=""
            onChange={(e) => handleFolderPick(e.target.files)}
          />
        </>
      )}

      {scanning && <BusyLine label={t("st_scanning")} />}

      {scanResult && !importing && (
        <div>
          <div className="mb-2.5 font-ui text-xs text-t2">
            {t("st_scan_results")
              .replace("{characters}", String(scanResult.characters.length))
              .replace("{chats}", String(scanResult.chats.length))
              .replace("{lorebooks}", String(scanResult.lorebooks.length))}
          </div>
          <button
            className="h-[34px] cursor-pointer rounded-md bg-accent px-5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-45"
            disabled={scanResult.characters.length + scanResult.chats.length === 0}
            onClick={handleImport}
          >
            {t("confirm_import")}
          </button>
        </div>
      )}

      {importing && importProgress && (
        <div>
          <div className="flex items-center gap-2 font-ui text-t2">
            <span className="inline-flex items-center gap-[3px]">
              <span className="h-1 w-1 rounded-full bg-accent animate-genp" />
              <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]" />
              <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]" />
            </span>
            {t("st_importing").replace("{current}", String(importProgress.current)).replace("{total}", String(importProgress.total))}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-s3">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 font-ui text-[calc(var(--ui-fs)-2px)] text-error">{error}</div>
      )}

      {importErrors.length > 0 && !importing && (
        <details className="mt-3">
          <summary className="cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-warning">
            {t("st_import_errors").replace("{count}", String(importErrors.length))}
          </summary>
          <div className="mt-1.5 max-h-48 overflow-y-auto rounded border border-border2 bg-surface p-2">
            {importErrors.map((e, i) => (
              <div key={i} className="border-b border-border2 py-1 last:border-0">
                <div className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">{e.fileName}</div>
                <div className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{e.reason}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ─── CharacterImportModal ──────────────────────────────────────────────────

export function CharacterImportModal(input: ImportModalCommonProps) {
  const { t } = useT();
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
      const lowerName = file.name.toLowerCase();
      const raw = lowerName.endsWith(".png") || file.type === "image/png"
        ? parseCharacterMetadata(await extractPngMetadata(file))
        : JSON.parse(await file.text());
      const data = normalizeCharacterPreview(raw, file);
      setPreview({ ...data, file, avatarUrl: lowerName.endsWith(".png") || file.type === "image/png" ? URL.createObjectURL(file) : null });
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
            <div className="mt-3 flex items-center gap-3">
              <div className="flex-1 border-t border-border2" />
              <button
                className="cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-accent-t transition-colors hover:text-accent"
                onClick={() => setStMode(true)}
              >
                {t("or_import_from_st")}
              </button>
            </div>
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
            <div className="mt-3 font-ui text-xs text-t3">{t("ready_to_import").replace("{name}", preview.file.name)}</div>
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
      const lowerName = file.name.toLowerCase();
      if (!lowerName.endsWith(".jsonl")) throw new Error(t("import_invalid_format"));
      setPreview(parseChatPreview(file, await file.text()));
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
            <div className="mt-3 flex items-center gap-3">
              <div className="flex-1 border-t border-border2" />
              <button
                className="cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-accent-t transition-colors hover:text-accent"
                onClick={() => setStMode(true)}
              >
                {t("or_import_from_st_chat")}
              </button>
            </div>
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
                <div className="font-ui text-xs text-t3">{preview.fileName} · {preview.messageCount} messages · Character: {preview.characterName}</div>
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
            <div className="mt-2 font-ui text-xs text-t3">{t("showing_parsed_messages").replace("{n}", String(preview.messages.length))}</div>
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
            <button className={cn("flex shrink-0 cursor-pointer items-center justify-center text-t3 transition-all hover:bg-s2 hover:text-t1", isMobile ? "h-10 w-10 rounded-lg active:bg-s2" : "h-8 w-8 rounded-[5px]")} onClick={props.onClose} aria-label={t("close")}><Icons.Close /></button>
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

function ModalFooter(props: { onClose: () => void; onConfirm: () => void; confirmLabel: string; disabled: boolean; busy: boolean }) {
  const { t } = useT();
  return <div className="flex shrink-0 items-center gap-2.5 border-t border-border px-5 py-3.5"><button className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" onClick={props.onClose}>{t("cancel")}</button><button className="h-[37px] cursor-pointer rounded-md bg-accent px-5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-45" disabled={props.disabled} onClick={props.onConfirm}>{props.busy ? t("importing") : props.confirmLabel}</button></div>;
}

// ─── Utility functions ─────────────────────────────────────────────────────

function normalizeCharacterPreview(raw: unknown, file: File): Omit<CharacterPreview, "file" | "avatarUrl"> {
  const obj = asRecord(raw);
  const data = asRecord(obj.data) ?? obj;
  const name = stringValue(data.name) || stringValue(obj.name) || stringValue(data.char_name) || stringValue(obj.char_name) || file.name.replace(/\.[^/.]+$/, "");
  const description = stringValue(data.description) || stringValue(data.personality) || stringValue(data.char_persona) || stringValue(obj.description) || "";
  const tags = arrayOfStrings(data.tags) ?? arrayOfStrings(obj.tags) ?? [];
  return { name, description, tags };
}

function parseChatPreview(file: File, text: string): ChatPreview {
  const messages: ChatPreview["messages"] = [];
  let characterName = "Unknown";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as unknown;
    const record = asRecord(parsed);
    const role = stringValue(record.role) || (record.is_user === true ? "user" : "assistant");
    const name = stringValue(record.name) || stringValue(record.user_name) || (role === "user" ? "User" : stringValue(record.character_name) || "Character");
    const messageText = stringValue(record.mes) || stringValue(record.text) || stringValue(record.content) || "";
    if (role !== "user" && name !== "Character") characterName = name;
    messages.push({ role, name, text: messageText });
  }
  if (messages.length === 0) throw new Error(getT()("import_no_messages"));
  return {
    file,
    fileName: file.name,
    title: file.name.replace(/\.jsonl$/i, ""),
    messageCount: messages.length,
    characterName,
    messages: messages.slice(0, 24),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function arrayOfStrings(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function initial(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "?";
}
