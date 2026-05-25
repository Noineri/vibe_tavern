import { useRef, useState, useMemo } from "react";
import { useT } from "../i18n/context.js";
import { cn } from "../lib/cn.js";
import { Modal } from "./shared/Modal.js";
import { Icons } from "./shared/icons.js";
import { parseStPreset, type ParsedStPreset, type StPresetBlock } from "../lib/st-preset-parser.js";
import type { InjectionRow } from "./prompt/InjectionTable.js";

type TargetMapping = "system" | "post" | "authors" | "injection" | "skip";

interface BlockMapping {
  block: StPresetBlock;
  target: TargetMapping;
  enabled: boolean;
}

const TARGET_OPTIONS: { value: TargetMapping; labelKey: string }[] = [
  { value: "system", labelKey: "preset_import_target_system" },
  { value: "post", labelKey: "preset_import_target_post" },
  { value: "authors", labelKey: "preset_import_target_authors" },
  { value: "injection", labelKey: "preset_import_target_injection" },
  { value: "skip", labelKey: "preset_import_target_skip" },
];

export interface PresetImportResult {
  system: string[];
  post: string[];
  authors: string[];
  injections: InjectionRow[];
}

interface PresetImportModalProps {
  onClose: () => void;
  onImport: (result: PresetImportResult) => void;
}

function smartDefault(identifier: string): TargetMapping {
  if (identifier === "main") return "system";
  if (identifier === "nsfw" || identifier === "jailbreak") return "post";
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
  const fileRef = useRef<HTMLInputElement | null>(null);

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
        i === index ? { ...m, enabled: !m.enabled, target: !m.enabled ? "skip" : smartDefault(m.block.identifier) } : m
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
    injection: selected.filter((m) => m.target === "injection").length,
    total: selected.length,
    all: mappings.length,
  };

  function handleImport() {
    if (counts.total === 0) return;
    const result: PresetImportResult = { system: [], post: [], authors: [], injections: [] };
    for (const m of selected) {
      switch (m.target) {
        case "system": result.system.push(m.block.content); break;
        case "post": result.post.push(m.block.content); break;
        case "authors": result.authors.push(m.block.content); break;
        case "injection":
          result.injections.push({
            name: m.block.name,
            content: m.block.content,
            depth: m.block.injectionDepth,
            role: m.block.role,
            enabled: true,
          });
          break;
      }
    }
    onImport(result);
  }

  return (
    <Modal open={true} onClose={onClose}>
      <div className="flex max-h-[calc(100vh-60px)] w-[640px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]">
        {/* Header */}
        <div className="shrink-0 px-5 pt-[18px]">
          <div className="flex items-start justify-between">
            <div>
              <div className="mb-0.5 font-body text-[calc(var(--ui-fs)+4px)] font-medium text-t1">{t("preset_import_title")}</div>
              <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("preset_import_sub")}</div>
            </div>
            <button className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}><Icons.Close /></button>
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
          <>
            {/* Top bar: summary + bulk actions */}
            <div className="shrink-0 border-b border-border px-5 pb-2.5">
              <div className="flex items-center gap-2 mb-2.5">
                <span className="font-ui text-[calc(var(--ui-fs)-1px)] text-t1">{parsed.name}.json</span>
                <span className="font-ui text-[11px] text-t4">· {counts.all} {t("blocks")}</span>
              </div>
              {/* Summary pills */}
              <div className="flex flex-wrap items-center gap-2 mb-2.5">
                <span className="rounded bg-accent/15 px-2 py-0.5 font-ui text-[11px] text-accent-t">{counts.total} selected</span>
                {counts.system > 0 && <span className="rounded bg-blue-500/15 px-1.5 py-0.5 font-ui text-[10px] text-blue-400">{counts.system} system</span>}
                {counts.post > 0 && <span className="rounded bg-purple-500/15 px-1.5 py-0.5 font-ui text-[10px] text-purple-400">{counts.post} post</span>}
                {counts.authors > 0 && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-ui text-[10px] text-amber-400">{counts.authors} author</span>}
                {counts.injection > 0 && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-ui text-[10px] text-emerald-400">{counts.injection} injection</span>}
              </div>
              {/* Filter + bulk */}
              <div className="flex items-center gap-2">
                <input
                  className="h-[28px] w-[180px] rounded border border-border bg-s2 px-2.5 font-ui text-[11px] text-t1 outline-none placeholder:text-t4 focus:border-accent"
                  placeholder={t("search") + "…"}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <label className="flex cursor-pointer items-center gap-1.5 font-ui text-[10px] text-t4 select-none">
                  <input type="checkbox" className="h-3 w-3 accent-accent" checked={showOnlySelected} onChange={(e) => setShowOnlySelected(e.target.checked)} />
                  {t("preset_import_filter_selected")}
                </label>
                <div className="ml-auto flex items-center gap-1.5">
                  <button className="h-[24px] cursor-pointer rounded border border-border bg-s2 px-2 font-ui text-[10px] text-t3 hover:text-t1" onClick={selectAll}>{t("preset_import_select_all")}</button>
                  <button className="h-[24px] cursor-pointer rounded border border-border bg-s2 px-2 font-ui text-[10px] text-t3 hover:text-t1" onClick={deselectAll}>{t("preset_import_deselect_all")}</button>
                  <select
                    className="h-[24px] cursor-pointer rounded border border-border bg-s2 px-1.5 font-ui text-[10px] text-t2 outline-none"
                    onChange={(e) => { if (e.target.value) bulkSetTarget(e.target.value as TargetMapping); e.target.value = ""; }}
                    value=""
                  >
                    <option value="">{t("preset_import_bulk_set")}…</option>
                    {TARGET_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Block list */}
            <div className="flex-1 overflow-y-auto">
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
          </>
        )}

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3.5">
          <button className="h-[37px] cursor-pointer rounded-md border border-border bg-surface px-5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}>
            {t("cancel")}
          </button>
          {phase === "preview" && (
            <button
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
  const preview = block.content.slice(0, 80).replace(/\n/g, " ").trim() + (block.content.length > 80 ? "…" : "");
  const hasMeta = target === "injection" && enabled;

  return (
    <div className={cn(
      "grid grid-cols-[24px_1fr_130px] gap-2.5 border-b border-border2 px-5 py-2.5 hover:bg-s2/50 transition-colors",
      !enabled && "opacity-40"
    )}>
      <input
        type="checkbox"
        className="mt-1 h-3.5 w-3.5 cursor-pointer accent-accent"
        checked={enabled}
        onChange={() => onToggle(index)}
      />
      <div className="min-w-0 overflow-hidden">
        <div className="truncate font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-t1">{block.name}</div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-t4">{preview}</div>
        {hasMeta && (
          <div className="mt-0.5 flex items-center gap-3 font-mono text-[10px] text-t4">
            <span>role: <span className="text-t3">{block.role}</span></span>
            <span>depth: <span className="text-t3">{block.injectionDepth}</span></span>
          </div>
        )}
      </div>
      <select
        className="mt-1 h-[24px] cursor-pointer rounded border border-border bg-s2 px-1.5 font-ui text-[10px] text-t2 outline-none disabled:cursor-default"
        value={target}
        disabled={!enabled}
        onChange={(e) => onTarget(index, e.target.value as TargetMapping)}
      >
        {TARGET_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
        ))}
      </select>
    </div>
  );
}
