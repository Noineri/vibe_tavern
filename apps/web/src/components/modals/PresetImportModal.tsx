import { useState, useMemo } from "react";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { Modal } from "../shared/Modal.js";
import { Icons } from "../shared/icons.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { parseStPreset, stBlockToCanvasEntry, synthesizeCanvasEntry, type ParsedStPreset, type StPresetBlock } from "../../lib/st-preset-parser.js";
import { inferSlot } from "@vibe-tavern/domain";
import type { CustomInjection, PromptOrderEntry, PromptSlot } from "@vibe-tavern/domain";

type TargetMapping = "system" | "post" | "authors" | "nsfw" | "enhanceDefinitions" | "injection";

const TARGET_BADGE: Record<TargetMapping, { cls: string; key: string }> = {
  system: { cls: "bg-blue-500/15 text-blue-400", key: "preset_import_target_system" },
  post: { cls: "bg-purple-500/15 text-purple-400", key: "preset_import_target_post" },
  authors: { cls: "bg-amber-500/15 text-amber-400", key: "preset_import_target_authors" },
  nsfw: { cls: "bg-danger-dim text-danger-text", key: "preset_import_target_nsfw" },
  enhanceDefinitions: { cls: "bg-cyan-500/15 text-cyan-400", key: "preset_import_target_enhance_defs" },
  injection: { cls: "bg-emerald-500/15 text-emerald-400", key: "preset_import_target_injection" },
};

export interface PresetImportResult {
  system: string[];
  post: string[];
  authors: string[];
  authorsRole?: "system" | "user" | "assistant";
  nsfw: string[];
  enhanceDefinitions: string[];
  injections: CustomInjection[];
  promptOrder: PromptOrderEntry[];
  target: 'current' | 'new';
  newPresetName?: string;
}

interface PresetImportModalProps {
  onClose: () => void;
  onImport: (result: PresetImportResult) => void;
}

function smartDefault(identifier: string): TargetMapping {
  if (identifier === "main") return "system";
  if (identifier === "jailbreak") return "post";
  if (identifier === "nsfw") return "nsfw";
  if (identifier === "enhanceDefinitions") return "enhanceDefinitions";
  if (identifier === "authorsNote") return "authors";
  return "injection";
}

interface BlockInfo {
  block: StPresetBlock;
  target: TargetMapping;
  slot?: PromptSlot;
}

function computeBlockInfo(block: StPresetBlock): BlockInfo {
  const target = smartDefault(block.identifier);
  // Transient slot for the read-only preview line only — NOT persisted onto
  // the stored injection. Positional state lives on the canvas entry.
  let slot: PromptSlot | undefined;
  if (target === "injection") {
    slot = inferSlot({
      injectionPosition: block.injectionPosition,
      depth: block.injectionDepth,
      placement: block.promptOrderPlacement,
      order: block.injectionOrder,
    });
  }
  return { block, target, slot };
}

export function PresetImportModal({ onClose, onImport }: PresetImportModalProps) {
  const { t } = useT();
  const [phase, setPhase] = useState<"drop" | "preview">("drop");
  const [errorMsg, setErrorMsg] = useState("");
  const [parsed, setParsed] = useState<ParsedStPreset | null>(null);
  const [drag, setDrag] = useState(false);
  const [importTarget, setImportTarget] = useState<"current" | "new">("current");
  const [newPresetName, setNewPresetName] = useState("");
  const [fileRefEl, setFileRefEl] = useState<HTMLInputElement | null>(null);
  const isMobile = useIsMobile();

  function handleFile(file?: File | null) {
    setErrorMsg("");
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const preset = parseStPreset(reader.result as string);
        setParsed(preset);
        setPhase("preview");
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : t("preset_import_parse_error"));
      }
    };
    reader.readAsText(file);
  }

  // Compute block infos, sorted by prompt_order index when available
  const blockInfos = useMemo(() => {
    const infos = parsed?.blocks.map(computeBlockInfo) ?? [];
    // Sort by promptOrderIndex (position in ST prompt_order array).
    // Blocks without a promptOrderIndex (not in prompt_order) go last.
    infos.sort((a, b) => {
      const ai = a.block.promptOrderIndex ?? Infinity;
      const bi = b.block.promptOrderIndex ?? Infinity;
      return ai - bi;
    });
    return infos;
  }, [parsed]);

  // Counts per target
  const counts = useMemo(() => {
    const c = { system: 0, post: 0, authors: 0, nsfw: 0, enhanceDefinitions: 0, injection: 0, total: blockInfos.length, enabled: 0, disabled: 0 };
    for (const info of blockInfos) {
      c[info.target]++;
      if (info.block.enabled) c.enabled++; else c.disabled++;
    }
    return c;
  }, [blockInfos]);

  function handleImport() {
    if (!parsed || blockInfos.length === 0) return;

    // Start canvas from ALL parsed ST prompt_order entries (complete PromptOrderEntry).
    // This preserves built-in markers (main, chatHistory, worldInfoBefore, etc.)
    // and any custom entries ST already positioned.
    const canvas: PromptOrderEntry[] = parsed.promptOrder.map(stBlockToCanvasEntry);
    const canvasIds = new Set(canvas.map((e) => e.identifier));

    // Content-only custom injections
    const injections: CustomInjection[] = [];

    const result: PresetImportResult = {
      system: [], post: [], authors: [], nsfw: [], enhanceDefinitions: [],
      injections: [], promptOrder: canvas,
      target: importTarget, newPresetName: newPresetName || undefined,
    };

    for (const info of blockInfos) {
      const { block, target } = info;
      switch (target) {
        case "system": result.system.push(block.content); break;
        case "post": result.post.push(block.content); break;
        case "authors":
          result.authors.push(block.content);
          result.authorsRole ??= block.role;
          break;
        case "nsfw": result.nsfw.push(block.content); break;
        case "enhanceDefinitions": result.enhanceDefinitions.push(block.content); break;
        case "injection": {
          // Content-only: {identifier, name, content, role}
          injections.push({
            identifier: block.identifier,
            name: block.name,
            content: block.content,
            role: block.role,
          });
          // Ensure a canvas entry exists — synthesize if absent from ST prompt_order.
          if (!canvasIds.has(block.identifier)) {
            const entry = synthesizeCanvasEntry(block);
            canvas.push(entry);
            canvasIds.add(block.identifier);
          }
          break;
        }
      }
    }
    result.injections = injections;
    onImport(result);
  }

  return (
    <Modal open={true} onClose={onClose}>
      <div className={cn(
        "flex flex-col overflow-hidden bg-surface",
        isMobile
          ? "w-full h-full"
          : "max-h-[calc(100vh-60px)] w-[640px] max-w-[calc(100vw-32px)] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]"
      )}>
        {/* Header */}
        <div className="shrink-0 px-5 pt-[18px] pb-1">
          <div className="flex items-start justify-between">
            <div>
              <div className="mb-0.5 font-body text-[calc(var(--ui-fs)+4px)] font-medium text-t1">{t("preset_import_title")}</div>
              <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3 mb-6">{t("preset_import_sub")}</div>
            </div>
            <button type="button" className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}><Icons.Close /></button>
          </div>
        </div>

        {/* Dropzone */}
        {phase === "drop" && (
          <div className="px-5 pb-4">
            <div
              className={cn(
                "flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed px-5 py-10 font-ui text-t3 transition-all hover:border-accent hover:bg-s2 hover:text-t2",
                drag && "border-accent bg-s2 text-t2"
              )}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
              onClick={() => fileRefEl?.click()}
            >
              <input ref={setFileRefEl} className="hidden" type="file" accept=".json" onChange={(e) => handleFile(e.target.files?.[0])} />
              <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-s3 text-t2"><Icons.Import /></div>
              <div className="font-ui text-sm">{t("preset_import_drop_title")}</div>
              <div className="font-ui text-xs text-t4">{t("preset_import_drop_sub")}</div>
            </div>
            {errorMsg && (
              <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-center font-ui text-xs text-danger">{errorMsg}</div>
            )}
          </div>
        )}

        {/* Preview */}
        {phase === "preview" && parsed && (
          <div className={cn(isMobile ? "flex-1 overflow-y-auto" : "contents")}>
            {/* Summary bar */}
            <div className={cn("border-b border-border px-5 pb-2.5", !isMobile && "shrink-0")}>
              <div className="flex items-center gap-2 mb-2">
                <span className="font-ui text-[calc(var(--ui-fs)-1px)] text-t1">{parsed.name}.json</span>
                <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t4">· {counts.total} {t("blocks")}</span>
                {counts.disabled > 0 && (
                  <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t4">· {counts.enabled} on, {counts.disabled} off</span>
                )}
              </div>
              {/* Category pills */}
              <div className="flex flex-wrap items-center gap-2">
                {counts.system > 0 && <span className={cn("rounded px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)]", TARGET_BADGE.system.cls)}>{counts.system} system</span>}
                {counts.post > 0 && <span className={cn("rounded px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)]", TARGET_BADGE.post.cls)}>{counts.post} post</span>}
                {counts.authors > 0 && <span className={cn("rounded px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)]", TARGET_BADGE.authors.cls)}>{counts.authors} author</span>}
                {counts.nsfw > 0 && <span className={cn("rounded px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)]", TARGET_BADGE.nsfw.cls)}>{counts.nsfw} nsfw</span>}
                {counts.enhanceDefinitions > 0 && <span className={cn("rounded px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)]", TARGET_BADGE.enhanceDefinitions.cls)}>{counts.enhanceDefinitions} enhance</span>}
                {counts.injection > 0 && <span className={cn("rounded px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)]", TARGET_BADGE.injection.cls)}>{counts.injection} injection</span>}
              </div>
            </div>

            {/* Block list */}
            <div className={cn(!isMobile && "flex-1 overflow-y-auto")}>
              {blockInfos.length === 0 ? (
                <div className="px-5 py-8 text-center font-ui text-[12px] text-t4">{t("preset_import_no_match")}</div>
              ) : (
                <div className="flex flex-col">
                  {blockInfos.map((info) => (
                    <BlockPreview key={info.block.identifier} info={info} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Import target */}
        {parsed && phase === "preview" && (
          <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-2.5">
            <label className="flex cursor-pointer items-center gap-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 select-none">
              <input type="radio" name="importTarget" className="accent-accent" checked={importTarget === "current"} onChange={() => setImportTarget("current")} />
              {t("preset_import_to_current")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 select-none">
              <input type="radio" name="importTarget" className="accent-accent" checked={importTarget === "new"} onChange={() => setImportTarget("new")} />
              {t("preset_import_to_new")}
            </label>
            {importTarget === "new" && (
              <input
                className="ml-2 h-[30px] flex-1 rounded border border-border bg-s2 px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t4 focus:border-accent"
                placeholder={t("preset_import_new_name_placeholder")}
                value={newPresetName}
                onChange={(e) => setNewPresetName(e.target.value)}
              />
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3.5">
          <button type="button" className="h-[37px] cursor-pointer rounded-md border border-border bg-surface px-5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}>
            {t("cancel")}
          </button>
          {phase === "preview" && (
            <button type="button"
              className="h-[37px] cursor-pointer rounded-md border-0 bg-accent px-6 font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-on-accent transition-all disabled:cursor-default disabled:opacity-40 hover:brightness-110"
              disabled={blockInfos.length === 0}
              onClick={handleImport}
            >
              {t("preset_import_btn").replace("{n}", String(blockInfos.length))}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Read-only block preview row ─────────────────────────────────────────────

function BlockPreview({ info }: { info: BlockInfo }) {
  const { t } = useT();
  const { block, target, slot } = info;
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();

  const preview = block.content.slice(0, 120).replace(/\n/g, " ").trim() + (block.content.length > 120 ? "…" : "");
  const badge = TARGET_BADGE[target];

  return (
    <div className={cn(
      "border-b border-border2 transition-colors",
      !block.enabled && "opacity-40",
      isMobile ? "px-3 py-2.5" : "px-5 py-2.5"
    )}>
      {/* Row 1: enabled dot + name + target badge */}
      <div className="flex items-center gap-2">
        <div className={cn("h-2 w-2 shrink-0 rounded-full", block.enabled ? "bg-accent" : "bg-t4")} />
        <div className="min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-t1">{block.name}</div>
        <span className={cn("shrink-0 rounded px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)]", badge.cls)}>
          {t(badge.key)}
        </span>
      </div>

      {/* Row 2: content preview */}
      <div
        className={cn("cursor-pointer pl-4 font-mono text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t4", !expanded && "truncate")}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? block.content : preview}
      </div>
      {expanded && block.content.length > 120 && (
        <button type="button" className="pl-4 font-ui text-[calc(var(--ui-fs)-3px)] text-accent hover:underline" onClick={() => setExpanded(false)}>
          {t("collapse")}
        </button>
      )}

      {/* Row 3: slot info for injections */}
      {slot && (
        <div className="pl-4 mt-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
          {slot.zone === "in_chat"
            ? `In chat · depth ${slot.depth}`
            : slot.zone === "after_chat"
              ? "After chat"
              : "Before chat"}
          {" · order "}{slot.order}
        </div>
      )}
    </div>
  );
}
