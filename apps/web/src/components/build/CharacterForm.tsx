import { useRef, useState } from "react";
import { Ic } from "../shared/icons";
import { cn } from "../../lib/cn";
import { extractPngMetadata, parseCharacterMetadata } from "../../lib/png-reader";

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

/**
 * Parse a character card file (PNG/JSON) into a partial draft that can be
 * merged into the existing character draft. Only standard V2/V3 fields are
 * mapped; unknown fields are ignored.
 */
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

export function CharacterForm({
  draft,
  patchDraft,
  setDraft,
  isDirty,
  isSaving,
  saveNotice,
  avatarUrl,
  onSave,
  onReset,
  onAvatarUpload,
}: CharacterFormProps) {
  const [altGreetIdx, setAltGreetIdx] = useState(0);
  const [tagInput, setTagInput] = useState("");
  const [importError, setImportError] = useState("");
  const avaInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const avatarPreview = draft._avatarPreview as string | null;
  const canSave = !isSaving && draft.name?.trim();

  function handleAvatarPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    // Local preview
    patchDraft("_avatarPreview", URL.createObjectURL(file));
    // Notify parent for server upload
    onAvatarUpload(file);
  }

  function handleImportFile(files: FileList | null) {
    if (!files || files.length === 0) return;
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
        if (Object.keys(merged).length === 0) {
          throw new Error("No character data found in file.");
        }
        // Merge into draft — user must Save to persist
        setDraft({ ...draft, ...merged });
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
      if (!tags.includes(tagInput.trim())) {
        patchDraft("tags", [...tags, tagInput.trim()]);
      }
      setTagInput("");
    }
  }

  const displayAvatar = avatarPreview || avatarUrl;

  return (
    <div className="max-w-[600px]">
      {/* Header row: name + save + import */}
      <div className="mb-1.5 flex items-center justify-between">
        <div className="mb-1.5 font-body text-[22px] font-medium text-t1">
          {draft.name || "Unnamed"}
        </div>
        <div className="flex items-center gap-2">
          {/* Import button — loads card into draft, does NOT save */}
          <input
            ref={importInputRef}
            type="file"
            className="hidden"
            accept=".png,.json,image/png,application/json"
            onChange={(e) => handleImportFile(e.target.files)}
          />
          <button
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border bg-s2 text-t2 transition-all hover:border-accent hover:text-accent-t"
            title="Import character card into draft"
            onClick={() => importInputRef.current?.click()}
            disabled={isSaving}
          >
            {Ic.import()}
          </button>
          {/* Save button */}
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
        <div className="mb-3 rounded-md border border-border2 bg-s2 px-3 py-1.5 font-ui text-xs text-red-400">
          {importError}
        </div>
      )}

      <div className="mb-7 font-ui text-[calc(var(--ui-fs)-1px)] text-t2 leading-[1.55]">
        Character card — edit inline
      </div>

      {/* Avatar + Name row */}
      <div className="mb-5 flex gap-4">
        <div
          className="group relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-border2 bg-s2 text-t3 transition-all hover:border-accent hover:text-accent-t"
          onClick={() => avaInputRef.current?.click()}
          title="Change avatar"
        >
          <input
            ref={avaInputRef}
            type="file"
            className="hidden"
            accept="image/*"
            onChange={(e) => handleAvatarPick(e.target.files)}
          />
          {displayAvatar ? (
            <>
              <img src={displayAvatar} alt="" className="h-full w-full object-cover" />
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100">
                <Ic.edit />
              </div>
            </>
          ) : (
            <Ic.plus />
          )}
        </div>
        <div className="flex-1">
          <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
            Name
          </label>
          <input
            type="text"
            className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent"
            value={draft.name || ""}
            disabled={isSaving}
            onChange={(e) => patchDraft("name", e.target.value)}
          />
        </div>
      </div>

      {/* Description */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          Description
        </label>
        <textarea
          className="w-full min-h-[100px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent"
          value={draft.description || ""}
          disabled={isSaving}
          onChange={(e) => patchDraft("description", e.target.value)}
        />
      </div>

      {/* First Message */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          First Message (Greeting)
        </label>
        <textarea
          className="w-full min-h-[120px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent"
          value={draft.firstMessage || ""}
          disabled={isSaving}
          onChange={(e) => patchDraft("firstMessage", e.target.value)}
          placeholder="Character's first message..."
        />
      </div>

      {/* Alternate Greetings */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          Alternate Greetings
        </label>
        <div className="mb-2 flex flex-wrap gap-1">
          {(draft.alternateGreetings || []).map((_: any, idx: number) => (
            <span
              key={idx}
              className={cn(
                "inline-flex items-center gap-1 rounded border border-border bg-s2 px-2.5 py-0.5 font-ui text-xs text-t2 cursor-pointer transition-all",
                idx === altGreetIdx && "border-accent bg-accent-dim text-accent-t",
              )}
              onClick={() => setAltGreetIdx(idx)}
            >
              Alt {idx + 1}
              <span
                className="ml-0.5 cursor-pointer text-[10px]"
                onClick={(e) => {
                  e.stopPropagation();
                  const next = [...(draft.alternateGreetings || [])];
                  next.splice(idx, 1);
                  patchDraft("alternateGreetings", next);
                  if (altGreetIdx >= next.length) setAltGreetIdx(Math.max(0, next.length - 1));
                }}
              >
                ✕
              </span>
            </span>
          ))}
          <span
            className="inline-flex items-center justify-center rounded border border-dashed border-border bg-transparent px-2.5 py-0.5 font-ui text-xs text-t3 cursor-pointer"
            onClick={() => {
              const next = [...(draft.alternateGreetings || []), ""];
              patchDraft("alternateGreetings", next);
              setAltGreetIdx(next.length - 1);
            }}
          >
            +
          </span>
        </div>
        {(draft.alternateGreetings || []).length > 0 && (
          <textarea
            className="w-full min-h-[120px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent"
            value={(draft.alternateGreetings || [])[altGreetIdx] || ""}
            disabled={isSaving}
            onChange={(e) => {
              const next = [...(draft.alternateGreetings || [])];
              next[altGreetIdx] = e.target.value;
              patchDraft("alternateGreetings", next);
            }}
            placeholder="Alternate greeting..."
          />
        )}
      </div>

      {/* Message Examples */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          Message Examples
        </label>
        <textarea
          className="w-full min-h-[120px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
          value={draft.mesExample || ""}
          disabled={isSaving}
          onChange={(e) => patchDraft("mesExample", e.target.value)}
          placeholder="<START>..."
        />
      </div>

      {/* Scenario */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          Scenario
        </label>
        <textarea
          className="w-full min-h-[100px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent"
          value={draft.scenario || ""}
          disabled={isSaving}
          onChange={(e) => patchDraft("scenario", e.target.value)}
        />
      </div>

      {/* Personality Summary */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          Personality Summary
        </label>
        <textarea
          className="w-full min-h-[60px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent"
          value={draft.personalitySummary || ""}
          disabled={isSaving}
          onChange={(e) => patchDraft("personalitySummary", e.target.value)}
        />
      </div>

      {/* Advanced separator */}
      <div
        className="border-b border-border font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t3"
        style={{ marginTop: 24, marginBottom: 12, paddingBottom: 6 }}
      >
        Advanced Fields (V3)
      </div>

      {/* Post-History Instructions */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          Post-History Instructions
        </label>
        <textarea
          className="w-full min-h-[60px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
          value={draft.postHistoryInstructions || ""}
          disabled={isSaving}
          onChange={(e) => patchDraft("postHistoryInstructions", e.target.value)}
          placeholder="Instructions appended to the end of chat history (Jailbreak)..."
        />
      </div>

      {/* Creator Notes */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          Creator Notes
        </label>
        <textarea
          className="w-full min-h-[60px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent"
          value={draft.creatorNotes || ""}
          disabled={isSaving}
          onChange={(e) => patchDraft("creatorNotes", e.target.value)}
          placeholder="Internal creator notes..."
        />
      </div>

      {/* Character Book JSON */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          Character Book (JSON)
        </label>
        <textarea
          className="w-full min-h-[80px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
          value={draft.characterBook || ""}
          disabled={isSaving}
          onChange={(e) => patchDraft("characterBook", e.target.value)}
          placeholder='{"entries":[...]}'
        />
      </div>

      {/* Depth Prompt row */}
      <div className="flex items-end gap-3">
        <div className="mb-5 flex-1">
          <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
            Depth Prompt
          </label>
          <textarea
            className="w-full min-h-[60px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
            value={draft.depthPrompt || ""}
            disabled={isSaving}
            onChange={(e) => patchDraft("depthPrompt", e.target.value)}
            placeholder="Prompt injected at a specific depth..."
          />
        </div>
        <div className="mb-5 w-20 shrink-0">
          <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
            Depth
          </label>
          <input
            type="number"
            className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent"
            min={0}
            max={999}
            value={draft.depthPromptDepth ?? 4}
            disabled={isSaving}
            onChange={(e) => patchDraft("depthPromptDepth", Number(e.target.value))}
          />
        </div>
        <div className="mb-5 w-[110px] shrink-0">
          <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
            Role
          </label>
          <select
            className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent"
            value={draft.depthPromptRole || "system"}
            disabled={isSaving}
            onChange={(e) => patchDraft("depthPromptRole", e.target.value)}
          >
            <option value="system">system</option>
            <option value="user">user</option>
            <option value="assistant">assistant</option>
          </select>
        </div>
      </div>

      {/* Extensions JSON */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          Extensions (JSON)
        </label>
        <textarea
          className="w-full min-h-[60px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
          value={draft.extensions || ""}
          disabled={isSaving}
          onChange={(e) => patchDraft("extensions", e.target.value)}
          placeholder='{"talkativeness":"0.5",...}'
        />
      </div>

      {/* System Prompt Override */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          System Prompt Override
        </label>
        <textarea
          className="w-full min-h-[80px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent font-mono text-xs"
          value={draft.systemPrompt || ""}
          disabled={isSaving}
          onChange={(e) => patchDraft("systemPrompt", e.target.value)}
          placeholder="Leave empty to use the global prompt..."
        />
      </div>

      {/* Tags — input + chips */}
      <div className="mb-5">
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          Tags
        </label>
        <input
          type="text"
          className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent"
          value={tagInput}
          disabled={isSaving}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={handleTagKey}
          placeholder="Enter tag and press Enter"
        />
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {(draft.tags || []).map((tag: string) => (
            <span
              key={tag}
              className="cursor-pointer rounded bg-accent-dim px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-all hover:bg-border2 hover:text-t1"
              onClick={() => toggleTag(tag)}
            >
              {tag} ✕
            </span>
          ))}
        </div>
      </div>

      {/* Footer: Reset + save notice */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <button
          className="cursor-pointer rounded-md bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
          style={{ height: 28, padding: "0 12px" }}
          disabled={isSaving || !isDirty}
          onClick={onReset}
        >
          Reset
        </button>
        <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3" style={{ margin: 0 }}>
          {saveNotice || (isDirty ? "Unsaved changes" : "Saved state")}
        </span>
      </div>
    </div>
  );
}
