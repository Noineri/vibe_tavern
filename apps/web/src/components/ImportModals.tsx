import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { ChatId } from "@rp-platform/domain";
import { extractPngMetadata, parseCharacterMetadata } from "../lib/png-reader.js";
import { cn } from "../lib/cn.js";
import { Icons } from "./shared/icons.js";

interface ImportModalCommonProps {
  isImporting: boolean;
  importNotice: string;
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

export function CharacterImportModal(input: ImportModalCommonProps) {
  const [drag, setDrag] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<CharacterPreview | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => {
    if (preview?.avatarUrl) URL.revokeObjectURL(preview.avatarUrl);
  }, [preview?.avatarUrl]);

  async function processFile(file?: File | null): Promise<void> {
    if (!file) return;
    setParsing(true);
    setError("");
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
      setError(err instanceof Error ? err.message : "Could not read character card.");
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
    <ImportModalFrame title="Import character" subtitle="Upload a PNG character card or JSON character file." onClose={input.onClose}>
      <div className="flex-1 overflow-y-auto p-5">
        {!preview && !parsing && !error && (
          <Dropzone
            drag={drag}
            setDrag={setDrag}
            accept=".png,.json,image/png,application/json"
            fileRef={fileRef}
            title="Click or drop character file here"
            subtitle="PNG character cards and JSON are supported"
            onFile={processFile}
          />
        )}
        {parsing && <BusyLine label="Reading character metadata..." />}
        {error && <ErrorCard error={error} onRetry={() => setError("")} />}
        {preview && !parsing && !error && (
          <div>
            <div className="flex gap-4 rounded-lg border border-border bg-s2 p-4">
              {preview.avatarUrl ? (
                <img src={preview.avatarUrl} className="h-16 w-16 shrink-0 rounded-lg bg-s3 object-cover object-top" alt="" />
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-s3 font-body text-2xl italic text-t3">{initial(preview.name)}</div>
              )}
              <div className="min-w-0 flex-1 font-ui">
                <div className="mb-1 text-base font-medium text-t1">{preview.name}</div>
                <div className="line-clamp-3 mb-2.5 text-xs leading-relaxed text-t3">{preview.description || "No description"}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {preview.tags.slice(0, 6).map((tag) => <span key={tag} className="rounded bg-s3 px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t2">{tag}</span>)}
                </div>
              </div>
            </div>
            <div className="mt-3 font-ui text-xs text-t3">Ready to import: {preview.file.name}</div>
          </div>
        )}
        {input.importNotice && <div className="mt-3 rounded-md bg-s2 px-3 py-2 font-ui text-xs text-t2">{input.importNotice}</div>}
      </div>
      <ModalFooter onClose={input.onClose} confirmLabel="Add to library" disabled={!preview || input.isImporting} busy={input.isImporting} onConfirm={confirm} />
    </ImportModalFrame>
  );
}

export function ChatImportModal(input: ImportModalCommonProps & { activeChatId: ChatId | null }) {
  const [drag, setDrag] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<ChatPreview | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function processFile(file?: File | null): Promise<void> {
    if (!file) return;
    setParsing(true);
    setError("");
    setPreview(null);
    try {
      const lowerName = file.name.toLowerCase();
      if (!lowerName.endsWith(".jsonl")) throw new Error("Only SillyTavern JSONL chat files are supported here.");
      setPreview(parseChatPreview(file, await file.text()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read chat history.");
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
    <ImportModalFrame title="Import chat history" subtitle="Upload a SillyTavern JSONL history file. It will be imported through the real chat import pipeline." onClose={input.onClose}>
      <div className="flex-1 overflow-y-auto p-5">
        {!preview && !parsing && !error && (
          <Dropzone
            drag={drag}
            setDrag={setDrag}
            accept=".jsonl"
            fileRef={fileRef}
            title="Click or drop chat history here"
            subtitle="SillyTavern JSONL is supported"
            onFile={processFile}
          />
        )}
        {parsing && <BusyLine label="Reading chat history..." />}
        {error && <ErrorCard error={error} onRetry={() => setError("")} />}
        {preview && !parsing && !error && (
          <div>
            <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-s2 px-4 py-3">
              <div>
                <div className="font-ui text-sm font-medium text-t1">Parsed preview</div>
                <div className="font-ui text-xs text-t3">{preview.fileName} · {preview.messageCount} messages · Character: {preview.characterName}</div>
              </div>
              <div className="rounded-full bg-success-dim px-2.5 py-0.5 font-ui text-xs font-medium text-success-text">Ready</div>
            </div>
            <div className="max-h-[250px] overflow-y-auto">
              {preview.messages.map((message, index) => (
                <div key={index} className={cn("flex items-start gap-2 rounded-md px-2 py-1.5", message.role === "user" && "bg-s2")}>
                  <div className={cn("min-w-[44px] shrink-0 pt-0.5 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold", message.role === "user" ? "text-info" : "text-accent-t")}>{message.name}</div>
                  <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t2">{truncate(message.text, 140)}</div>
                </div>
              ))}
            </div>
            <div className="mt-2 font-ui text-xs text-t3">Showing first {preview.messages.length} parsed messages.</div>
          </div>
        )}
        {input.importNotice && <div className="mt-3 rounded-md bg-s2 px-3 py-2 font-ui text-xs text-t2">{input.importNotice}</div>}
      </div>
      <ModalFooter onClose={input.onClose} confirmLabel="Import chat" disabled={!preview || input.isImporting} busy={input.isImporting} onConfirm={confirm} />
    </ImportModalFrame>
  );
}

function ImportModalFrame(props: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/55 backdrop-blur-[2px]" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <div className="flex max-h-[calc(100vh-60px)] w-[500px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]">
        <div className="shrink-0" style={{padding:'18px 20px 0'}}>
          <div className="flex items-start justify-between">
            <div>
              <div className="mb-0.5 font-body text-[calc(var(--ui-fs)+4px)] font-medium text-t1">{props.title}</div>
              <div className="mb-3.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{props.subtitle}</div>
            </div>
            <button className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={props.onClose} aria-label="Close"><Icons.Close /></button>
          </div>
        </div>
        {props.children}
      </div>
    </div>
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

function ErrorCard(props: { error: string; onRetry: () => void }) {
  return <div className="rounded-lg border border-danger bg-danger-dim p-4 font-ui text-[13px] leading-relaxed text-danger-text"><div className="mb-1 font-medium">Import error</div>{props.error}<button className="mt-3 block h-[34px] rounded-md bg-s3 px-3.5 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={props.onRetry}>Try again</button></div>;
}

function ModalFooter(props: { onClose: () => void; onConfirm: () => void; confirmLabel: string; disabled: boolean; busy: boolean }) {
  return <div className="flex shrink-0 items-center gap-2.5 border-t border-border px-5 py-3.5"><button className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" onClick={props.onClose}>Cancel</button><button className="h-[37px] cursor-pointer rounded-md bg-accent px-5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-45" disabled={props.disabled} onClick={props.onConfirm}>{props.busy ? "Importing..." : props.confirmLabel}</button></div>;
}

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
  if (messages.length === 0) throw new Error("No messages found in JSONL file.");
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
