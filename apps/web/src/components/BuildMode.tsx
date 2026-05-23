import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { buildCharacterDraftSchema, type BuildCharacterDraft } from "@rp-platform/api-contracts";
import type { AssemblePromptResponse, PromptTraceRecordDto } from "@rp-platform/domain";
import type { AppSnapshot } from "../app-client.js";
import { cn } from "../lib/cn.js";
import { CharacterForm } from "./editors/CharacterForm.js";
import { getGatewayBaseUrl } from "../gateway-client.js";
import { useT } from "../i18n/context.js";
import { useCharacterStore } from "../stores/character-store.js";
import { useActiveTrace } from "../stores/chat-selectors.js";
import { useCharacterController } from "../hooks/use-character-controller.js";
import { useBuildPanels } from "../hooks/use-build-panels.js";

import { useBootstrapStore } from "../stores/api-actions/bootstrap-actions.js";
import { useChatDataStore } from "../stores/chat-data-store.js";
import { useChatStore } from "../stores/index.js";

export type BuildTab = string;

export type { BuildCharacterDraft };

export function BuildMode() {
  const character = useCharacterController();
  const bootstrapData = useBootstrapStore((s) => s.data);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const chatMeta = useChatDataStore((s) => s.chatMeta);
  const promptTraceHistory = useChatDataStore((s) => s.promptTraceHistory);
  const charData = chatMeta?.character ?? null;
  const isSaving = useCharacterStore((s) => s.isSavingCharacter);
  const buildTab = useCharacterStore((s) => s.buildTab);

  const activeTrace = useActiveTrace(useChatStore((s) => s.selectedTraceId));
  const promptPayloadText = JSON.stringify(activeTrace?.finalPayload ?? {}, null, 2);
  const promptTraceCount = promptTraceHistory.length;

  if (!chatMeta || !charData) return null;

  return <BuildModeInner
    character={charData}
    isSaving={isSaving}
    buildTab={buildTab}
    activeTrace={activeTrace}
    promptPayloadText={promptPayloadText}
    promptTraceCount={promptTraceCount}
    onSave={character.handleSaveCharacter}
    onAvatarUpload={character.handleAvatarUpload}
    characterId={charData.id}
    activeChatId={chatMeta.activeChat?.id ?? null}
    personaId={chatMeta.persona?.id ?? null}
  />;
}

function characterDefaults(character: AppSnapshot["character"]): BuildCharacterDraft {
  return {
    name: character.name,
    description: character.description,
    firstMessage: character.firstMessage || "",
    mesExample: character.mesExample || "",
    mesExampleMode: (character.mesExampleMode as "always" | "once" | "depth") || "always",
    mesExampleDepth: character.mesExampleDepth ?? 4,
    scenario: character.scenario,
    personalitySummary: character.personalitySummary || "",
    systemPrompt: character.systemPrompt,
    alternateGreetings: character.alternateGreetings || [],
    postHistoryInstructions: character.postHistoryInstructions || "",
    creatorNotes: character.creatorNotes || "",
    depthPrompt: character.depthPrompt || "",
    depthPromptDepth: character.depthPromptDepth ?? 4,
    depthPromptRole: character.depthPromptRole || "system",
    tags: character.tags || [],
  };
}

interface BuildModeInnerProps {
  character: AppSnapshot["character"];
  isSaving: boolean;
  buildTab: BuildTab;
  activeTrace: PromptTraceRecordDto | AssemblePromptResponse | null;
  promptPayloadText: string;
  promptTraceCount: number;
  onSave: (draft: BuildCharacterDraft) => Promise<void> | void;
  onAvatarUpload: (file: File, originalFile?: File | null) => Promise<void> | void;
  characterId: string;
  activeChatId: string | null;
  personaId: string | null;
}

function BuildModeInner({ character, isSaving, buildTab, activeTrace, promptPayloadText, promptTraceCount, onSave, onAvatarUpload, characterId, activeChatId, personaId }: BuildModeInnerProps) {
  const { t } = useT();
  const panels = useBuildPanels();

  const form = useForm<BuildCharacterDraft>({
    resolver: zodResolver(buildCharacterDraftSchema),
    defaultValues: characterDefaults(character),
  });

  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  const prevCharIdRef = useRef(character.id);
  useEffect(() => {
    if (prevCharIdRef.current !== character.id) {
      prevCharIdRef.current = character.id;
      form.reset(characterDefaults(character));
      setAvatarPreview(null);
    }
  }, [character.id]);

  // Track avatar-preview dirtiness separately
  const isDirty = form.formState.isDirty || !!avatarPreview;

  function handleSave(): void {
    void form.handleSubmit(async (data) => {
      await onSave(data);
      form.reset(data);
      setAvatarPreview(null);
    })();
  }

  function resetDraft(): void {
    form.reset(characterDefaults(character));
    setAvatarPreview(null);
  }

  function handleAvatarUpload(file: File, originalFile?: File | null): void {
    void Promise.resolve(onAvatarUpload(file, originalFile)).then(() => setAvatarPreview(null));
  }

  const avatarUrl = character.avatarFullAssetId
    ? `${getGatewayBaseUrl()}/api/assets/${character.avatarFullAssetId}`
    : character.avatarAssetId
      ? `${getGatewayBaseUrl()}/api/assets/${character.avatarAssetId}`
      : undefined;

  const ctx = { characterId, chatId: activeChatId, personaId };

  const activePanel = panels.find((p) => p.id === buildTab);
  const isFullBleed = activePanel?.fullBleed === true;

  function renderPanelContent(): ReactNode {
    // Character panel is special — owns form + save logic in BuildMode
    if (buildTab === "character") {
      return (
        <div className="mx-auto max-w-4xl">
          <CharacterForm
            form={form}
            avatarPreview={avatarPreview}
            setAvatarPreview={setAvatarPreview}
            isDirty={isDirty}
            isSaving={isSaving}
            avatarUrl={avatarUrl}
            onSave={handleSave}
            onReset={resetDraft}
            onAvatarUpload={handleAvatarUpload}
          />
        </div>
      );
    }

    // Trace panel is special — owns trace-specific rendering
    if (buildTab === "trace") {
      return (
        <div className="mx-auto max-w-4xl">
          {renderTraceContent()}
        </div>
      );
    }

    // Generic registered panel
    if (activePanel?.render) {
      return activePanel.render(ctx);
    }

    return null;
  }

  function renderTraceContent(): ReactNode {
    const trace = activeTrace;
    const totalTokens = trace ? (trace.tokenAccounting?.total ?? trace.layers.reduce((sum, l) => sum + l.tokenCount, 0)) : 0;
    return (
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="mb-1.5 font-body text-[22px] font-medium text-t1">
            {t("build_prompt_trace")}
          </div>
          {trace && (
            <div
              className="rounded-full bg-s2 px-2.5 py-1 font-ui text-[13px] text-t2"
            >
              {t("trace_total_tokens").replace("{n}", String(totalTokens))}
            </div>
          )}
        </div>
        <div className="mb-7 font-ui text-[calc(var(--ui-fs)-1px)] text-t3 leading-[1.55]">
          {trace && 'id' in trace ? (
            <>
              {t("trace_showing").replace("{n}", String(trace.id))}{" "}
              <span className="text-t2">{trace.id}</span> · {trace.createdAt} · model:{" "}
              {trace.model} · {trace.latencyMs}ms
            </>
          ) : (
            t("trace_no_active")
          )}{" "}
          · {t("trace_recorded_count").replace("{n}", String(promptTraceCount))}.
          {trace?.prefill && (
            <div
              className="mt-1.5 rounded-[6px] border border-border2 bg-s2 px-2.5 py-1.5 font-body text-xs"
            >
              <strong className="text-t2">{t("trace_prefill_label")}</strong>{" "}
              <span className="whitespace-pre-wrap text-t3">{trace.prefill}</span>
            </div>
          )}
        </div>

        {trace ? (
          <div className="flex flex-col gap-2">
            {trace.layers.map((layer, index) => (
              <div key={layer.id} className="overflow-hidden rounded-md border border-border bg-s2">
                <div
                  className={cn(
                    "flex cursor-pointer items-center justify-between bg-surface px-3.5 py-2.5 font-ui text-xs text-t2 transition-colors hover:bg-s2 hover:text-t1",
                    layer.sourceType === "prompt_preset" && "border-l-2 border-l-info",
                    (layer.sourceType.includes("memory") || layer.sourceType === "lore_entry") && "border-l-2 border-l-success",
                    !layer.sourceType.includes("memory") && layer.sourceType !== "lore_entry" && layer.sourceType !== "prompt_preset" && "border-l-2 border-l-danger",
                  )}
                  onClick={(e) => {
                    const next = e.currentTarget.nextElementSibling as HTMLElement;
                    if (next) next.style.display = next.style.display === "none" ? "block" : "none";
                  }}
                >
                  <div>
                    <strong>
                      {index + 1}. {layer.sourceType}
                    </strong>
                    <span className="ml-1.5 text-t3">{layer.sourceId}</span>
                  </div>
                  <div className="flex gap-2 text-t3">
                    <span className="text-xs text-t2">{layer.tokenCount} {t("tokens_label")}</span>
                  </div>
                </div>
                {/* DYNAMIC: display toggled by JS click handler above */}
                <div
                  className="border-t border-border bg-bg p-3 whitespace-pre-wrap font-mono text-[11px] text-t1"
                  style={{ display: "none" }}
                >
                  {layer.text}
                </div>
              </div>
            ))}

            <div className="mt-5">
              <button
                className="inline-flex cursor-pointer items-center rounded-md border-0 bg-s3 px-4 py-2 font-ui text-xs font-medium text-t2 transition-colors hover:bg-border2 hover:text-t1"
                onClick={() => alert(promptPayloadText)}
              >
                {t("view_raw_json")}
              </button>
            </div>
          </div>
        ) : (
          <div
            className="mt-5 flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border2 bg-s2 font-body text-[13px] italic text-t3"
          >
          {t("trace_no_traces_yet")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex-1 overflow-y-auto",
        isFullBleed && "flex overflow-hidden p-0",
      )}
      style={!isFullBleed ? { padding: "32px 40px" } : undefined}
    >
      {renderPanelContent()}
    </div>
  );
}
