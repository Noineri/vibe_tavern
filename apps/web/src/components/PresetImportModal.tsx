import { useRef, useState } from "react";
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
  const [phase, setPhase] = useState<"drop" | "preview" | "error">("drop");
  const [errorMsg, setErrorMsg] = useState("");
  const [parsed, setParsed] = useState<ParsedStPreset | null>(null);
  const [mappings, setMappings] = useState<BlockMapping[]>([]);
  const [drag, setDrag] = useState(false);
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
        setPhase("error");
      }
    };
    reader.onerror = () => {
      setErrorMsg(t("preset_import_parse_error"));
      setPhase("error");
    };
    reader.readAsText(file);
  }

  function toggleBlock(index: number) {
    setMappings((prev) =>
      prev.map((m, i) =>
        i === index
          ? {
              ...m,
              enabled: !m.enabled,
              target: !m.enabled ? smartDefault(m.block.identifier) : "skip",
            }
          : m
      )
    );
  }

  function setTarget(index: number, target: TargetMapping) {
    setMappings((prev) =>
      prev.map((m, i) => (i === index ? { ...m, target } : m))
    );
  }

  const selected = mappings.filter((m) => m.enabled && m.target !== "skip");
  const counts = {
    system: selected.filter((m) => m.target === "system").length,
    post: selected.filter((m) => m.target === "post").length,
    authors: selected.filter((m) => m.target === "authors").length,
    injection: selected.filter((m) => m.target === "injection").length,
  };
  const totalSelected = selected.length;

  function handleImport() {
    if (totalSelected === 0) return;
    const result: PresetImportResult = { system: [], post: [], authors: [], injections: [] };
    for (const m of selected) {
      switch (m.target) {
        case "system":
          result.system.push(m.block.content);
          break;
        case "post":
          result.post.push(m.block.content);
          break;
        case "authors":
          result.authors.push(m.block.content);
          break;
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
      <div className="flex max-h-[calc(100vh-60px)] w-[580px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]">
        {/* Header */}
        <div className="shrink-0 px-5 pt-[18px]">
          <div className="flex items-start justify-between">
            <div>
              <div className="mb-0.5 font-body text-[calc(var(--ui-fs)+4px)] font-medium text-t1">
                {t("preset_import_title")}
              </div>
              <div className="mb-3.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
                {t("preset_import_sub")}
              </div>
            </div>
            <button
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1"
              onClick={onClose}
            >
              <Icons.Close />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 pb-4">
          {/* Dropzone */}
          {(phase === "drop" || phase === "error") && (
            <>
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
                <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-s3 text-t2">
                  <Icons.Import />
                </div>
                <div className="font-ui text-sm">{t("preset_import_drop_title")}</div>
                <div className="font-ui text-xs text-t4">{t("preset_import_drop_sub")}</div>
              </div>
              {phase === "error" && (
                <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-center font-ui text-xs text-danger">
                  {errorMsg}
                </div>
              )}
            </>
          )}

          {/* Preview */}
          {phase === "preview" && parsed && (
            <>
              {/* Summary card */}
              <div className="mb-3 flex items-center gap-3 rounded-md border border-border2 bg-s2 px-3.5 py-2.5">
                <span className="flex-1 truncate font-ui text-[calc(var(--ui-fs)-1px)] text-t1">
                  {parsed.name}.json · {parsed.blocks.length} {t("blocks")}
                </span>
                <span className="shrink-0 rounded bg-accent/15 px-2 py-0.5 font-ui text-[11px] text-accent-t">
                  ✓
                </span>
              </div>

              {/* Block list */}
              <div className="flex flex-col gap-1.5 max-h-[50vh] overflow-y-auto">
                {mappings.map((m, i) => (
                  <BlockRow
                    key={m.block.identifier}
                    mapping={m}
                    index={i}
                    onToggle={toggleBlock}
                    onTarget={setTarget}
                  />
                ))}
              </div>

              {/* Summary */}
              <div className="mt-3 rounded-md border border-border2 bg-s2 px-3 py-2 text-center font-ui text-[11px] text-t3">
                {totalSelected > 0
                  ? t("preset_import_selected")
                      .replace("{n}", String(totalSelected))
                      .replace("{sys}", String(counts.system))
                      .replace("{post}", String(counts.post))
                      .replace("{an}", String(counts.authors))
                      .replace("{inj}", String(counts.injection))
                  : t("preset_import_no_blocks")}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3.5">
          <button
            className="h-[37px] cursor-pointer rounded-md border border-border bg-surface px-5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-all hover:bg-s2 hover:text-t1"
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          {phase === "preview" && (
            <button
              className="h-[37px] cursor-pointer rounded-md border-0 bg-accent px-6 font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-white transition-all disabled:cursor-default disabled:opacity-40 hover:brightness-110"
              disabled={totalSelected === 0}
              onClick={handleImport}
            >
              {t("preset_import_btn").replace("{n}", String(totalSelected))}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Block Row ────────────────────────────────────────────────────────────────

function BlockRow({
  mapping,
  index,
  onToggle,
  onTarget,
}: {
  mapping: BlockMapping;
  index: number;
  onToggle: (i: number) => void;
  onTarget: (i: number, t: TargetMapping) => void;
}) {
  const { t } = useT();
  const { block, enabled, target } = mapping;
  const preview = block.content.length > 100
    ? block.content.slice(0, 100).replace(/\n/g, " ") + "…"
    : block.content.replace(/\n/g, " ");

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2.5 transition-colors",
        enabled ? "border-border bg-surface" : "border-border2 bg-s1 opacity-55"
      )}
    >
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-accent"
          checked={enabled}
          onChange={() => onToggle(index)}
        />
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-t1">
            {block.name}
          </div>
          <div className="font-mono text-[calc(var(--ui-fs)-3px)] text-t3 leading-[1.45] line-clamp-2">
            {preview}
          </div>
          {target === "injection" && enabled && (
            <div className="mt-1.5 flex items-center gap-3 font-ui text-[10px] text-t4">
              <span>role: <span className="text-t3">{block.role}</span></span>
              <span>depth: <span className="text-t3">{block.injectionDepth}</span></span>
            </div>
          )}
        </div>
        <select
          className="h-[26px] shrink-0 cursor-pointer rounded border border-border bg-s2 px-2 font-ui text-[11px] text-t2 outline-none"
          value={target}
          disabled={!enabled}
          onChange={(e) => onTarget(index, e.target.value as TargetMapping)}
        >
          {TARGET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.labelKey)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
