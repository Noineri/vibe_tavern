import { useRef, useState } from "react";
import { Ic } from "../shared/icons";
import { cn } from "../../lib/cn";
import { CharacterImportModal } from "../ImportModals.js";
import { extractPngMetadata, parseCharacterMetadata } from "../../lib/png-reader";
import { useTokenCount } from "../../hooks/use-token-count.js";

export interface CharacterFormProps {
  draft: Record<string, any>;
  patchDraft: (key: string, value: any) => void;
  setDraft: (draft: Record<string, any>) => void;
  isDirty: boolean;
  isSaving: boolean;
  saveNotice: string;
  avatarUrl?: string;
  onSave: () => void;
  onReset: () => void;
  onAvatarUpload: (file: File) => void;
}

function parseCardToDraft(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== "object") return {};
  const data = (raw as any).data && typeof (raw as any).data === "object" ? (raw as any).data : raw;
  const result: Record<string, any> = {};
  if (data.name) result.name = String(data.name);
  if (data.description) result.description = String(data.description);
  if (data.first_mes) result.firstMessage = String(data.first_mes);
  if (data.mes_example) result.mesExample = String(data.mes_example);
  if (data.scenario) result.scenario = String(data.scenario);
  if (data.personality) result.personalitySummary = String(data.personality);
  if (data.system_prompt) result.systemPrompt = String(data.system_prompt);
  if (data.post_history_instructions) result.postHistoryInstructions = String(data.post_history_instructions);
  if (data.creator_notes) result.creatorNotes = String(data.creator_notes);
  if (data.depth_prompt) result.depthPrompt = String(data.depth_prompt);
  if (typeof data.depth_prompt_depth === "number") result.depthPromptDepth = data.depth_prompt_depth;
  if (data.depth_prompt_role) result.depthPromptRole = String(data.depth_prompt_role);
  if (Array.isArray(data.alternate_greetings)) result.alternateGreetings = data.alternate_greetings.map(String);
  if (Array.isArray(data.tags)) result.tags = data.tags.map(String);
  if (data.extensions && typeof data.extensions === "object") {
    try { result.extensions = JSON.stringify(data.extensions); } catch {}
  }
  if (data.character_book && typeof data.character_book === "object") {
    try { result.characterBook = JSON.stringify(data.character_book); } catch {}
  }
  return result;
}

/* ── shared inline style objects (avoids Tailwind v4 numeric spacing bugs) ── */
const s = {
  fieldWrap: { marginBottom: 20 } as React.CSSProperties,
  label: { marginBottom: 6, display: "block" } as React.CSSProperties,
  inputPadding: { padding: "6px 10px" } as React.CSSProperties,
  sectionGap: { marginTop: 24, marginBottom: 12, paddingBottom: 6 } as React.CSSProperties,
};

const inputCls = "w-full rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent";
const textareaCls = inputCls;
const monoCls = inputCls + " font-mono text-xs";

/** Small inline token badge for character form fields */
function TokenBadge({ text }: { text: string }) {
  const count = useTokenCount(text);
  return <span className="flex justify-end font-ui text-[11px] tabular-nums text-t3">{count.toLocaleString()} tokens</span>;
}

export function CharacterForm({
  draft, patchDraft, setDraft, isDirty, isSaving, saveNotice, avatarUrl, onSave, onReset, onAvatarUpload,
}: CharacterFormProps) {
  const [altGreetIdx, setAltGreetIdx] = useState(0);
  const [tagInput, setTagInput] = useState("");
  const [importError, setImportError] = useState("");
  const [importModalOpen, setImportModalOpen] = useState(false);
  const avaInputRef = useRef<HTMLInputElement>(null);

  const avatarPreview = draft._avatarPreview as string | null;
  const canSave = !isSaving && draft.name?.trim();

  function handleAvatarPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    patchDraft("_avatarPreview", URL.createObjectURL(file));
    onAvatarUpload(file);
  }

  function handleImportFiles(files: File[]): void {
    if (files.length === 0) return;
    const file = files[0];
    setImportError("");
    (async () => {
      try {
        let raw: unknown;
        const lowerName = file.name.toLowerCase();
        if (file.type === "image/png" || lowerName.endsWith(".png")) {
          const metadata = await extractPngMetadata(file);
          raw = parseCharacterMetadata(metadata);
        } else if (lowerName.endsWith(".json") || file.type === "application/json") {
          const text = await file.text();
          raw = JSON.parse(text);
        } else {
          throw new Error("Unsupported file type. Use PNG or JSON character cards.");
        }
        const merged = parseCardToDraft(raw);
        if (Object.keys(merged).length === 0) throw new Error("No character data found in file.");
        setDraft({ ...draft, ...merged });
        setImportModalOpen(false);
      } catch (err) {
        setImportError(err instanceof Error ? err.message : "Failed to import");
      }
    })();
  }

  function toggleTag(tag: string) {
    const tags: string[] = draft.tags || [];
    const newTags = tags.includes(tag) ? tags.filter((t: string) => t !== tag) : [...tags, tag];
    patchDraft("tags", newTags);
  }

  function handleTagKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && tagInput.trim()) {
      e.preventDefault();
      const tags: string[] = draft.tags || [];
      if (!tags.includes(tagInput.trim())) patchDraft("tags", [...tags, tagInput.trim()]);
      setTagInput("");
    }
  }

  const displayAvatar = avatarPreview || avatarUrl;
  const lblCls = "block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3";

  // Total character tokens (all text fields)
  const charTotal = useTokenCount([
    draft.description, draft.firstMessage, draft.mesExample, draft.scenario,
    draft.personalitySummary, draft.postHistoryInstructions, draft.creatorNotes,
    draft.systemPrompt, draft.depthPrompt,
    ...(draft.alternateGreetings || []),
  ].filter(Boolean).join("\n"));

  return (
    <div style={{ maxWidth: 600 }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div className="font-body text-[22px] font-medium text-t1" style={{ marginBottom: 6 }}>
          {draft.name || "Unnamed"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="font-ui text-[11px] tabular-nums text-t3">{charTotal.toLocaleString()} tokens</span>
          <button
            className="flex cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-accent hover:text-accent-t"
            style={{ height: 28, width: 28 }}
            title="Import character card into draft"
            onClick={() => setImportModalOpen(true)}
            disabled={isSaving}
          >
            {Ic.import()}
          </button>
          <button
            className="cursor-pointer rounded-md border-0 bg-accent font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-white transition-all disabled:cursor-default disabled:opacity-40"
            style={{ height: 28, padding: "0 14px" }}
            disabled={!canSave || !isDirty}
            onClick={onSave}
          >
            {isSaving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {importError && (
        <div className="rounded-md border border-border2 bg-s2 font-ui text-xs text-red-400" style={{ marginBottom: 12, padding: "6px 12px" }}>
          {importError}
        </div>
      )}

      <div className="font-ui text-[calc(var(--ui-fs)-1px)] text-t2" style={{ marginBottom: 28, lineHeight: 1.55 }}>
      </div>

      {/* Avatar + Name */}
      <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
        <div
          className="group relative flex shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-border2 bg-s2 text-t3 transition-all hover:border-accent hover:text-accent-t"
          style={{ height: 64, width: 64 }}
          onClick={() => avaInputRef.current?.click()}
          title="Change avatar"
        >
          <input ref={avaInputRef} type="file" className="hidden" accept="image/*" onChange={(e) => handleAvatarPick(e.target.files)} />
          {displayAvatar ? (
            <>
              <img src={displayAvatar} alt="" className="h-full w-full object-cover" />
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"><Ic.edit /></div>
            </>
          ) : <Ic.plus />}
        </div>
        <div style={{ flex: 1 }}>
          <label className={lblCls} style={s.label}>Name</label>
          <input type="text" className={inputCls} style={s.inputPadding} value={draft.name || ""} disabled={isSaving} onChange={(e) => patchDraft("name", e.target.value)} />
        </div>
      </div>

      {/* Description */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>Description</label>
        <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 100 }} value={draft.description || ""} disabled={isSaving} onChange={(e) => patchDraft("description", e.target.value)} />
        <TokenBadge text={draft.description || ""} />
      </div>

      {/* First Message */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>First Message (Greeting)</label>
        <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 120 }} value={draft.firstMessage || ""} disabled={isSaving} onChange={(e) => patchDraft("firstMessage", e.target.value)} placeholder="Character's first message..." />
        <TokenBadge text={draft.firstMessage || ""} />
      </div>

      {/* Alternate Greetings */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>Alternate Greetings</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
          {(draft.alternateGreetings || []).map((_: any, idx: number) => (
            <span
              key={idx}
              className={cn(
                "inline-flex items-center rounded border border-border bg-s2 font-ui text-xs text-t2 cursor-pointer transition-all",
                idx === altGreetIdx && "border-accent bg-accent-dim text-accent-t",
              )}
              style={{ padding: "2px 10px", gap: 4 }}
              onClick={() => setAltGreetIdx(idx)}
            >
              Alt {idx + 1}
              <span style={{ marginLeft: 2, fontSize: 10 }} className="cursor-pointer" onClick={(e) => {
                e.stopPropagation();
                const next = [...(draft.alternateGreetings || [])]; next.splice(idx, 1);
                patchDraft("alternateGreetings", next);
                if (altGreetIdx >= next.length) setAltGreetIdx(Math.max(0, next.length - 1));
              }}>✕</span>
            </span>
          ))}
          <span
            className="inline-flex items-center justify-center rounded border border-dashed border-border bg-transparent font-ui text-xs text-t3 cursor-pointer"
            style={{ padding: "2px 10px" }}
            onClick={() => {
              const next = [...(draft.alternateGreetings || []), ""];
              patchDraft("alternateGreetings", next);
              setAltGreetIdx(next.length - 1);
            }}
          >+</span>
        </div>
        {(draft.alternateGreetings || []).length > 0 && (
          <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 120 }} value={(draft.alternateGreetings || [])[altGreetIdx] || ""} disabled={isSaving} onChange={(e) => {
            const next = [...(draft.alternateGreetings || [])]; next[altGreetIdx] = e.target.value; patchDraft("alternateGreetings", next);
          }} placeholder="Alternate greeting..." />
        )}
      </div>

      {/* Message Examples */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>Message Examples</label>
        <textarea className={monoCls} style={{ ...s.inputPadding, minHeight: 120 }} value={draft.mesExample || ""} disabled={isSaving} onChange={(e) => patchDraft("mesExample", e.target.value)} placeholder="<START>..." />
        <TokenBadge text={draft.mesExample || ""} />
      </div>

      {/* Scenario */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>Scenario</label>
        <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 100 }} value={draft.scenario || ""} disabled={isSaving} onChange={(e) => patchDraft("scenario", e.target.value)} />
        <TokenBadge text={draft.scenario || ""} />
      </div>

      {/* Personality Summary */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>Personality Summary</label>
        <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 60 }} value={draft.personalitySummary || ""} disabled={isSaving} onChange={(e) => patchDraft("personalitySummary", e.target.value)} />
        <TokenBadge text={draft.personalitySummary || ""} />
      </div>

      {/* Advanced separator */}
      <div className="border-b border-border font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3" style={s.sectionGap}>
        Advanced Fields (V3)
      </div>

      {/* Post-History Instructions */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>Post-History Instructions</label>
        <textarea className={monoCls} style={{ ...s.inputPadding, minHeight: 60 }} value={draft.postHistoryInstructions || ""} disabled={isSaving} onChange={(e) => patchDraft("postHistoryInstructions", e.target.value)} placeholder="Instructions appended to the end of chat history (Jailbreak)..." />
        <TokenBadge text={draft.postHistoryInstructions || ""} />
      </div>

      {/* Creator Notes */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>Creator Notes</label>
        <textarea className={textareaCls} style={{ ...s.inputPadding, minHeight: 60 }} value={draft.creatorNotes || ""} disabled={isSaving} onChange={(e) => patchDraft("creatorNotes", e.target.value)} placeholder="Internal creator notes..." />
        <TokenBadge text={draft.creatorNotes || ""} />
      </div>

      {/* Character Book JSON */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>Character Book (JSON)</label>
        <textarea className={monoCls} style={{ ...s.inputPadding, minHeight: 80 }} value={draft.characterBook || ""} disabled={isSaving} onChange={(e) => patchDraft("characterBook", e.target.value)} placeholder='{"entries":[...]}'  />
        <TokenBadge text={draft.characterBook || ""} />
      </div>

      {/* Depth Prompt */}
      <div style={s.fieldWrap}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <label className={lblCls} style={{ marginBottom: 0 }}>Depth Prompt</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span className="font-ui text-[10px] uppercase tracking-[0.06em] text-t3">Depth</span>
              <input type="number" className={inputCls} style={{ ...s.inputPadding, width: 56, textAlign: "center" }} min={0} max={999} value={draft.depthPromptDepth ?? 4} disabled={isSaving} onChange={(e) => patchDraft("depthPromptDepth", Number(e.target.value))} />
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span className="font-ui text-[10px] uppercase tracking-[0.06em] text-t3">Role</span>
              <select className={inputCls} style={{ ...s.inputPadding, width: 90 }} value={draft.depthPromptRole || "system"} disabled={isSaving} onChange={(e) => patchDraft("depthPromptRole", e.target.value)}>
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
            </div>
          </div>
        </div>
        <textarea className={monoCls} style={{ ...s.inputPadding, minHeight: 60 }} value={draft.depthPrompt || ""} disabled={isSaving} onChange={(e) => patchDraft("depthPrompt", e.target.value)} placeholder="Prompt injected at a specific depth..." />
        <TokenBadge text={draft.depthPrompt || ""} />
      </div>

      {/* Extensions JSON */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>Extensions (JSON)</label>
        <textarea className={monoCls} style={{ ...s.inputPadding, minHeight: 60 }} value={draft.extensions || ""} disabled={isSaving} onChange={(e) => patchDraft("extensions", e.target.value)} placeholder='{"talkativeness":"0.5",...}' />
        <TokenBadge text={draft.extensions || ""} />
      </div>

      {/* System Prompt Override */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>System Prompt Override</label>
        <textarea className={monoCls} style={{ ...s.inputPadding, minHeight: 80 }} value={draft.systemPrompt || ""} disabled={isSaving} onChange={(e) => patchDraft("systemPrompt", e.target.value)} placeholder="Leave empty to use the global prompt..." />
        <TokenBadge text={draft.systemPrompt || ""} />
      </div>

      {/* Tags */}
      <div style={s.fieldWrap}>
        <label className={lblCls} style={s.label}>Tags</label>
        <input type="text" className={inputCls} style={s.inputPadding} value={tagInput} disabled={isSaving} onChange={(e) => setTagInput(e.target.value)} onKeyDown={handleTagKey} placeholder="Enter tag and press Enter" />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {(draft.tags || []).map((tag: string) => (
            <span key={tag} className="cursor-pointer rounded bg-accent-dim font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-all hover:bg-border2 hover:text-t1" style={{ padding: "4px 10px" }} onClick={() => toggleTag(tag)}>
              {tag} ✕
            </span>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <button className="cursor-pointer rounded-md bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" style={{ height: 28, padding: "0 12px" }} disabled={isSaving || !isDirty} onClick={onReset}>Reset</button>
        <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{saveNotice || (isDirty ? "Unsaved changes" : "Saved state")}</span>
      </div>

      {importModalOpen && (
        <CharacterImportModal
          isImporting={false}
          importNotice={importError}
          onClose={() => setImportModalOpen(false)}
          onImportFiles={handleImportFiles}
        />
      )}
    </div>
  );
}
