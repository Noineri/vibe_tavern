import { cn } from "../../lib/cn.js";
import { PrefillField } from "./PrefillField.js";
import { TokenCounter } from "../shared/TokenCounter.js";

type TabId = "system" | "jailbreak" | "authorsNote" | "tools";

interface DraftData {
  system: string;
  jailbreak: string;
  prefill: string;
  authorsNote: string;
  authorsNoteDepth: number;
  summary: string;
  tools: string;
}

interface PromptTabsProps {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  draft: DraftData | null;
  onUpdateField: (key: keyof DraftData, value: string | number) => void;
  prefillSupported?: boolean;
}

const tabCls = (active: boolean) =>
  cn(
    "cursor-pointer border-b-2 border-b-transparent font-ui text-xs font-medium text-t3 transition-all hover:text-t1",
    active && "border-b-accent text-accent-t"
  );

const textareaCls =
  "w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent resize-none";
const labelCls =
  "mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3";

const tabs: Array<{ id: TabId; label: string }> = [
  { id: "system", label: "System Prompt" },
  { id: "jailbreak", label: "Post-History (Jailbreak)" },
  { id: "authorsNote", label: "Author's Note" },
  { id: "tools", label: "Summary & Tools" },
];

export function PromptTabs({
  activeTab,
  setActiveTab,
  draft,
  onUpdateField,
  prefillSupported,
}: PromptTabsProps) {
  const disabled = !draft;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Tab bar */}
      <div className="mb-4 flex shrink-0 gap-4 border-b border-b-border">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={tabCls(activeTab === tab.id)}
            style={{ padding: "8px 4px" }}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </div>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1">
        {activeTab === "system" && (
          <div className="flex h-full flex-col">
            <textarea
              className={cn(textareaCls, "flex-1 min-h-0")}
              style={{ padding: "9px 13px" }}
              value={draft?.system ?? ""}
              onChange={(e) => onUpdateField("system", e.target.value)}
              disabled={disabled}
              placeholder="System prompt instructions..."
            />
            <TokenCounter text={draft?.system ?? ""} />
          </div>
        )}

        {activeTab === "jailbreak" && (
          <div className="flex h-full flex-col gap-4 overflow-y-auto">
            <div className="flex flex-1 flex-col min-h-0">
              <label className={labelCls}>Post-History Instructions</label>
              <textarea
                className={cn(textareaCls, "flex-1 min-h-0")}
                style={{ padding: "9px 13px" }}
                value={draft?.jailbreak ?? ""}
                onChange={(e) => onUpdateField("jailbreak", e.target.value)}
                disabled={disabled}
                placeholder="[Post-history instructions...]"
              />
              <TokenCounter text={draft?.jailbreak ?? ""} />
            </div>
            <PrefillField
              prefill={draft?.prefill ?? ""}
              onUpdate={(value) => onUpdateField("prefill", value)}
              disabled={disabled}
              prefillSupported={prefillSupported}
            />
          </div>
        )}

        {activeTab === "authorsNote" && (
          <div className="flex h-full flex-col gap-4">
            <div className="flex flex-1 flex-col min-h-0">
              <label className={labelCls}>Author's Note</label>
              <textarea
                className={cn(textareaCls, "flex-1 min-h-0")}
                style={{ padding: "9px 13px" }}
                value={draft?.authorsNote ?? ""}
                onChange={(e) => onUpdateField("authorsNote", e.target.value)}
                disabled={disabled}
                placeholder="Instructions injected near the end of context..."
              />
              <TokenCounter text={draft?.authorsNote ?? ""} />
            </div>
            <div className="shrink-0">
              <label className={labelCls}>Insert Depth</label>
              <input
                className="h-[38px] w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent"
                style={{ padding: "0 13px" }}
                type="number"
                min={0}
                title="Messages from the end to insert the note"
                value={draft?.authorsNoteDepth ?? 4}
                onChange={(e) => onUpdateField("authorsNoteDepth", Number(e.target.value))}
                disabled={disabled}
              />
            </div>
          </div>
        )}

        {activeTab === "tools" && (
          <div className="flex h-full flex-col gap-4">
            <div className="flex flex-1 flex-col min-h-0">
              <label className={labelCls}>Summary</label>
              <textarea
                className={cn(textareaCls, "flex-1 min-h-0")}
                style={{ padding: "9px 13px" }}
                value={draft?.summary ?? ""}
                onChange={(e) => onUpdateField("summary", e.target.value)}
                disabled={disabled}
              />
              <TokenCounter text={draft?.summary ?? ""} />
            </div>
            <div className="flex flex-1 flex-col min-h-0">
              <label className={labelCls}>Tools</label>
              <textarea
                className={cn(textareaCls, "flex-1 min-h-0")}
                style={{ padding: "9px 13px" }}
                value={draft?.tools ?? ""}
                onChange={(e) => onUpdateField("tools", e.target.value)}
                disabled={disabled}
              />
              <TokenCounter text={draft?.tools ?? ""} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
