import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { Modal } from "../shared/Modal.js";
import { Icons } from "../shared/icons.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { Checkbox } from "../shared/Checkbox.js";
import { parseStPreset, type ParsedStPreset, type StPresetBlock, type StPromptOrderBlock } from "../../lib/st-preset-parser.js";
import type { InjectionRow } from "../settings/prompt/InjectionTable.js";

type TargetMapping = "system" | "post" | "authors" | "nsfw" | "enhanceDefinitions" | "injection" | "skip";

interface BlockMapping {
  block: StPresetBlock;
  target: TargetMapping;
  enabled: boolean;
}

const TARGET_OPTIONS: { value: TargetMapping; labelKey: string }[] = [
  { value: "system", labelKey: "preset_import_target_system" },
  { value: "post", labelKey: "preset_import_target_post" },
  { value: "authors", labelKey: "preset_import_target_authors" },
  { value: "nsfw", labelKey: "preset_import_target_nsfw" },
  { value: "enhanceDefinitions", labelKey: "preset_import_target_enhance_defs" },
  { value: "injection", labelKey: "preset_import_target_injection" },
  { value: "skip", labelKey: "preset_import_target_skip" },
];

export interface PresetImportResult {
  system: string[];
  post: string[];
  authors: string[];
  authorsRole?: "system" | "user" | "assistant";
  nsfw: string[];
  enhanceDefinitions: string[];
  injections: InjectionRow[];
  promptOrder: StPromptOrderBlock[];
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
  return "injection";
}

export function PresetImportModal({ onClose, onImport }: PresetImportModalProps) {
  const { t } = useT();
  const [phase, setPhase] = useState<"drop" | "preview">("drop");
  const [errorMsg, setErrorMsg] = useState("");
  const [parsed, setParsed] = useState<ParsedStPreset | null>(null);
  const [mappings, setMappings] = useState<BlockMapping[]>([]);
  const [drag, setDrag] = useState(false);
  const [filter, setFilter] = useState("");
  const [showOnlySelected, setShowOnlySelected] = useState(false);
  const [importTarget, setImportTarget] = useState<"current" | "new">("current");
  const [newPresetName, setNewPresetName] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const isMobile = useIsMobile();

  function handleFile(file?: File | null) {
    setErrorMsg("");
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const preset = parseStPreset(reader.result as string);
        setParsed(preset);
        setMappings(
          preset.blocks.map((b) => ({
            block: b,
            target: b.enabled ? smartDefault(b.identifier) : "skip",
            enabled: b.enabled,
          }))
        );
        setPhase("preview");
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : t("preset_import_parse_error"));
      }
    };
    reader.readAsText(file);
  }

  function toggleBlock(index: number) {
    setMappings((prev) =>
      prev.map((m, i) =>
        i === index ? { ...m, enabled: !m.enabled, target: m.enabled ? "skip" : smartDefault(m.block.identifier) } : m
      )
    );
  }

  function setTarget(index: number, target: TargetMapping) {
    setMappings((prev) => prev.map((m, i) => (i === index ? { ...m, target } : m)));
  }

  function selectAll() {
    setMappings((prev) => prev.map((m) => ({ ...m, enabled: true, target: m.target === "skip" ? smartDefault(m.block.identifier) : m.target })));
  }

  function deselectAll() {
    setMappings((prev) => prev.map((m) => ({ ...m, enabled: false, target: "skip" })));
  }

  function bulkSetTarget(target: TargetMapping) {
    setMappings((prev) =>
      prev.map((m) => (m.enabled ? { ...m, target } : m))
    );
  }

  // Filter + selected counts
  const filtered = useMemo(() => {
    let list = mappings;
    if (showOnlySelected) list = list.filter((m) => m.enabled);
    if (filter.trim()) {
      const q = filter.toLowerCase();
      list = list.filter((m) => m.block.name.toLowerCase().includes(q) || m.block.identifier.toLowerCase().includes(q));
    }
    return list;
  }, [mappings, filter, showOnlySelected]);

  const selected = mappings.filter((m) => m.enabled && m.target !== "skip");
  const counts = {
    system: selected.filter((m) => m.target === "system").length,
    post: selected.filter((m) => m.target === "post").length,
    authors: selected.filter((m) => m.target === "authors").length,
    nsfw: selected.filter((m) => m.target === "nsfw").length,
    enhanceDefinitions: selected.filter((m) => m.target === "enhanceDefinitions").length,
    injection: selected.filter((m) => m.target === "injection").length,
    total: selected.length,
    all: mappings.length,
  };

  function handleImport() {
    if (counts.total === 0) return;
    const result: PresetImportResult = { system: [], post: [], authors: [], nsfw: [], enhanceDefinitions: [], injections: [], promptOrder: parsed?.promptOrder ?? [], target: importTarget, newPresetName: newPresetName || undefined };
    for (const m of selected) {
      switch (m.target) {
        case "system": result.system.push(m.block.content); break;
        case "post": result.post.push(m.block.content); break;
        case "authors":
          result.authors.push(m.block.content);
          result.authorsRole ??= m.block.role;
          break;
        case "nsfw": result.nsfw.push(m.block.content); break;
        case "enhanceDefinitions": result.enhanceDefinitions.push(m.block.content); break;
        case "injection":
          result.injections.push({
            identifier: m.block.identifier,
            name: m.block.name,
            content: m.block.content,
            depth: m.block.injectionDepth,
            role: m.block.role,
            enabled: true,
            injectionPosition: m.block.injectionPosition,
            injectionOrder: m.block.injectionOrder,
            promptOrderIndex: m.block.promptOrderIndex,
            promptOrderPlacement: m.block.promptOrderPlacement,
          });
          break;
      }
    }
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
              onClick={() => fileRef.current?.click()}
            >
              <input ref={fileRef} className="hidden" type="file" accept=".json" onChange={(e) => handleFile(e.target.files?.[0])} />
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
            {/* Top bar: summary + bulk actions */}
            <div className={cn("border-b border-border px-5 pb-2.5", !isMobile && "shrink-0")}>
              <div className="flex items-center gap-2 mb-2">
                <span className="font-ui text-[calc(var(--ui-fs)-1px)] text-t1">{parsed.name}.json</span>
                <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t4">· {counts.all} {t("blocks")}</span>
              </div>
              {/* Summary pills */}
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="rounded bg-accent/15 px-2.5 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-accent-t">{counts.total} selected</span>
                {counts.system > 0 && <span className="rounded bg-blue-500/15 px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-blue-400">{counts.system} system</span>}
                {counts.post > 0 && <span className="rounded bg-purple-500/15 px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-purple-400">{counts.post} post</span>}
                {counts.authors > 0 && <span className="rounded bg-amber-500/15 px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-amber-400">{counts.authors} author</span>}
                {counts.nsfw > 0 && <span className="rounded bg-rose-500/15 px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-rose-400">{counts.nsfw} nsfw</span>}
                {counts.enhanceDefinitions > 0 && <span className="rounded bg-cyan-500/15 px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-cyan-400">{counts.enhanceDefinitions} enhance</span>}
                {counts.injection > 0 && <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-emerald-400">{counts.injection} injection</span>}
              </div>

              {isMobile ? (
                /* Mobile: stacked rows */
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <input
                      className="h-[36px] flex-1 rounded border border-border bg-s2 px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t4 focus:border-accent"
                      placeholder={t("search") + "…"}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                    <Checkbox checked={showOnlySelected} onChange={setShowOnlySelected} label={t("preset_import_filter_selected")} />
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" className="h-[36px] flex-1 cursor-pointer rounded border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 hover:text-t1" onClick={selectAll}>{t("preset_import_select_all")}</button>
                    <button type="button" className="h-[36px] flex-1 cursor-pointer rounded border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 hover:text-t1" onClick={deselectAll}>{t("preset_import_deselect_all")}</button>
                  </div>
                  <BulkDropdown onSelect={bulkSetTarget} />
                </div>
              ) : (
                /* Desktop: two rows */
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <input
                      className="h-[30px] w-[200px] rounded border border-border bg-s2 px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t4 focus:border-accent"
                      placeholder={t("search") + "…"}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                    <Checkbox checked={showOnlySelected} onChange={setShowOnlySelected} label={t("preset_import_filter_selected")} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button type="button" className="h-[30px] cursor-pointer whitespace-nowrap rounded border border-border bg-s2 px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 hover:text-t1" onClick={selectAll}>{t("preset_import_select_all")}</button>
                    <button type="button" className="h-[30px] cursor-pointer whitespace-nowrap rounded border border-border bg-s2 px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 hover:text-t1" onClick={deselectAll}>{t("preset_import_deselect_all")}</button>
                    <BulkDropdown onSelect={bulkSetTarget} />
                  </div>
                </div>
              )}
            </div>

            {/* Block list */}
            <div className={cn(!isMobile && "flex-1 overflow-y-auto")}>
              {filtered.length === 0 ? (
                <div className="px-5 py-8 text-center font-ui text-[12px] text-t4">{t("preset_import_no_match")}</div>
              ) : (
                <div className="flex flex-col">
                  {filtered.map((m, fi) => {
                    const origIndex = mappings.indexOf(m);
                    return (
                      <BlockRow
                        key={m.block.identifier}
                        mapping={m}
                        index={origIndex}
                        onToggle={toggleBlock}
                        onTarget={setTarget}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        { parsed && (phase === "preview") && (
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
              className="h-[37px] cursor-pointer rounded-md border-0 bg-accent px-6 font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-white transition-all disabled:cursor-default disabled:opacity-40 hover:brightness-110"
              disabled={counts.total === 0}
              onClick={handleImport}
            >
              {t("preset_import_btn").replace("{n}", String(counts.total))}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Compact block row ────────────────────────────────────────────────────────

function BlockRow({ mapping, index, onToggle, onTarget }: {
  mapping: BlockMapping; index: number; onToggle: (i: number) => void; onTarget: (i: number, t: TargetMapping) => void;
}) {
  const { t } = useT();
  const { block, enabled, target } = mapping;
  const [expanded, setExpanded] = useState(false);
  const preview = block.content.slice(0, 120).replace(/\n/g, " ").trim() + (block.content.length > 120 ? "…" : "");
  const isMobile = useIsMobile();

  return (
    <div className={cn(
      "border-b border-border2 hover:bg-s2/50 transition-colors",
      !enabled && "opacity-40",
      isMobile ? "px-3 py-2.5" : "px-5 py-2.5"
    )}>
      {/* Row 1: Checkbox + Name */}
      <div className="flex items-center gap-2">
        <button type="button"
          className={cn(
            "flex shrink-0 cursor-pointer items-center justify-center rounded transition-colors",
            enabled ? "text-accent hover:bg-accent/10" : "text-t4 hover:text-t2",
            isMobile ? "h-10 w-10 text-lg" : "h-7 w-7"
          )}
          onClick={() => onToggle(index)}
        >
          {enabled ? "●" : "○"}
        </button>
        <div className="min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-t1">{block.name}</div>
      </div>

      {/* Row 2: Content preview */}
      <div
        className={cn("cursor-pointer pl-9 font-mono text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t4", !expanded && "truncate")}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? block.content : preview}
      </div>
      {expanded && block.content.length > 120 && (
        <button type="button" className="pl-9 font-ui text-[calc(var(--ui-fs)-3px)] text-accent hover:underline" onClick={() => setExpanded(false)}>
          {t("collapse")}
        </button>
      )}

      {/* Row 3: Target dropdown */}
      <div className="mt-1.5 pl-9">
        <TargetDropdown
          value={target}
          disabled={!enabled}
          onChange={(v) => onTarget(index, v)}
        />
      </div>
    </div>
  );
}

/* ── Custom dropdown for bulk-set target ── */

function BulkDropdown({ onSelect }: { onSelect: (t: TargetMapping) => void }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const options = TARGET_OPTIONS.map((o) => ({ ...o, active: false }));

  return (
    <AnchoredDropdown
      minWidth={180}
      align={isMobile ? "left" : "right"}
      button={(open) => (
        <span className={cn(
          "inline-flex cursor-pointer items-center rounded border border-border bg-s2 px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 hover:text-t1",
          isMobile ? "h-[36px]" : "h-[30px]"
        )}>{t("preset_import_bulk_set")}…</span>
      )}
      options={options}
      onSelect={onSelect}
    />
  );
}

/* ── Custom dropdown for single block target ── */

function TargetDropdown({ value, disabled, onChange }: { value: TargetMapping; disabled: boolean; onChange: (v: TargetMapping) => void }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const current = TARGET_OPTIONS.find((o) => o.value === value);
  const label = current ? t(current.labelKey) : value;

  return (
    <AnchoredDropdown
      minWidth={160}
      align="left"
      disabled={disabled}
      button={() => (
        <span className={cn(
          "inline-flex cursor-pointer items-center rounded border border-border bg-s2 px-2.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 outline-none transition-colors",
          disabled ? "cursor-default opacity-40" : "hover:bg-s3 hover:text-t1",
          isMobile ? "h-[36px]" : "h-[28px]"
        )}>{label} ▾</span>
      )}
      options={TARGET_OPTIONS.map((o) => ({ ...o, active: o.value === value }))}
      onSelect={onChange}
    />
  );
}

function AnchoredDropdown({
  button,
  options,
  onSelect,
  minWidth,
  align = "left",
  disabled = false,
}: {
  button: (open: boolean) => React.ReactNode;
  options: Array<{ value: TargetMapping; labelKey: string; active: boolean }>;
  onSelect: (value: TargetMapping) => void;
  minWidth: number;
  align?: "left" | "right";
  disabled?: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function updatePosition() {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;

    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    if (rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) {
      setOpen(false);
      return;
    }

    const menuRect = menuRef.current?.getBoundingClientRect();
    const menuWidth = Math.max(minWidth, menuRect?.width ?? minWidth);
    const menuHeight = menuRect?.height ?? (options.length * 34 + 8);
    const rawLeft = align === "right" ? rect.right - menuWidth : rect.left;
    const left = Math.max(8, Math.min(rawLeft, viewportWidth - menuWidth - 8));

    let top = rect.bottom + 4;
    if (top + menuHeight > viewportHeight - 8 && rect.top - menuHeight - 4 >= 8) {
      top = rect.top - menuHeight - 4;
    }
    top = Math.max(8, Math.min(top, viewportHeight - menuHeight - 8));
    setMenuPos({ top, left, width: menuWidth });
  }

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, align, minWidth, options.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onReposition = () => updatePosition();
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, align, minWidth]);

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className="inline-flex border-0 bg-transparent p-0"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (open) {
            setOpen(false);
          } else {
            updatePosition();
            setOpen(true);
          }
        }}
      >
        {button(open)}
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] rounded-md border border-border2 bg-surface py-1 shadow-[0_8px_24px_rgba(0,0,0,.4)]"
          style={{ top: menuPos.top, left: menuPos.left, minWidth: menuPos.width }}
        >
          {options.map((o) => (
            <button type="button" key={o.value}
              className={cn(
                "flex w-full cursor-pointer items-center px-3 py-[7px] font-ui text-[calc(var(--ui-fs)-2px)] transition-colors",
                o.active ? "bg-accent/10 text-accent-t" : "text-t2 hover:bg-s2 hover:text-t1"
              )}
              onClick={() => { onSelect(o.value); setOpen(false); }}
            >{t(o.labelKey)}</button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
