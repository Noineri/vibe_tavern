import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { buildCharacterDraftSchema, type BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import type { AssemblePromptResponse, PromptTraceRecordDto } from "@vibe-tavern/domain";
import type { AppCharacter } from "../../app-client.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { CharacterForm } from "./editors/CharacterForm.js";
import { formatTraceTimestamp } from "../layout/app-shell-helpers.js";
import { getGatewayBaseUrl } from "../../gateway-client.js";
import { useT } from "../../i18n/context.js";
import { useCharacterStore } from "../../stores/character-store.js";
import { useActiveTrace } from "../../stores/chat-selectors.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useBuildPanels } from "../../hooks/use-build-panels.js";

import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useChatMeta } from "../../stores/chat-selectors.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useChatStore } from "../../stores/index.js";
import { useIsMobile } from "../../hooks/use-mobile.js";

export type BuildTab = string;

/** Narrow view of an OpenAI-style final payload stored on a prompt trace. */
interface TraceFinalPayload {
  messages?: Array<{ role?: string; content?: Array<{ type?: string }> }>;
}

export type { BuildCharacterDraft };

export function BuildMode() {
  const character = useCharacterController();
  const bootstrapData = useBootstrapStore((s) => s.data);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const chatMeta = useChatMeta();
  const promptTraceHistory = useSnapshotStore((s) => s.promptTraceHistory);
  const charData = chatMeta?.character ?? null;
  const isSaving = useCharacterStore((s) => s.isSavingCharacter);
  const buildTab = useCharacterStore((s) => s.buildTab);
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);
  const { t } = useT();

  const activeTrace = useActiveTrace(useChatStore((s) => s.selectedTraceId));
  const setSelectedTraceId = useChatStore((s) => s.setSelectedTraceId);
  const promptPayloadText = JSON.stringify(activeTrace?.finalPayload ?? {}, null, 2);
  const promptTraceCount = promptTraceHistory.length;
  const currentTraceIndex = activeTrace && 'id' in activeTrace ? promptTraceHistory.findIndex((t) => t.id === (activeTrace as PromptTraceRecordDto).id) : -1;

  let imageAttachmentsCount = 0;
  if (activeTrace?.finalPayload && typeof activeTrace.finalPayload === 'object') {
    const payload = activeTrace.finalPayload as TraceFinalPayload;
    const messages = payload.messages;
    if (Array.isArray(messages)) {
      messages.forEach(msg => {
        if (Array.isArray(msg.content)) {
          msg.content.forEach((part) => {
            if (part && (part.type === "image_url" || part.type === "image")) {
              imageAttachmentsCount++;
            }
          });
        }
      });
    } else {
      imageAttachmentsCount = (promptPayloadText.match(/"type":\s*"(image_url|image)"/g) || []).length;
    }
  }

  if (!chatMeta || !charData) return null;

  return <BuildModeInner
    character={charData}
    isSaving={isSaving}
    buildTab={buildTab}
    activeTrace={activeTrace}
    promptPayloadText={promptPayloadText}
    promptTraceCount={promptTraceCount}
    currentTraceIndex={currentTraceIndex}
    imageAttachmentsCount={imageAttachmentsCount}
    setSelectedTraceId={setSelectedTraceId}
    promptTraceHistory={promptTraceHistory}
    onSave={character.handleSaveCharacter}
    onAvatarUpload={character.handleAvatarUpload}
    characterId={charData.id}
    activeChatId={chatMeta.activeChat?.id ?? null}
    personaId={chatMeta.persona?.id ?? null}
    onExportJson={() => { void character.handleExportCharacter(charData.id); }}
    onExportPng={() => { void character.handleExportPng(charData.id); }}
    onDuplicate={() => { void character.handleDuplicateCharacter(charData.id); }}
    onCreateChat={() => character.handleCreateChat(charData.id)}
    onDelete={() => {
      setConfirmDestroy({
        title: t("char_delete"),
        body: <>{t("char_delete_confirm").replace("{name}", charData.name)}</>,
        confirmLabel: t("delete"),
        onConfirm: () => { void character.handleDeleteCharacter(charData.id); },
      });
    }}
    hasAvatar={!!(charData.avatarFullAssetId || charData.avatarAssetId)}
  />;
}

function characterDefaults(character: AppCharacter): BuildCharacterDraft {
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
  character: AppCharacter;
  isSaving: boolean;
  buildTab: BuildTab;
  activeTrace: PromptTraceRecordDto | AssemblePromptResponse | null;
  promptPayloadText: string;
  promptTraceCount: number;
  currentTraceIndex: number;
  imageAttachmentsCount: number;
  setSelectedTraceId: (id: string | null) => void;
  promptTraceHistory: PromptTraceRecordDto[];
  onSave: (draft: BuildCharacterDraft) => Promise<void> | void;
  onAvatarUpload: (file: File, originalFile?: File | null) => Promise<void> | void;
  characterId: string;
  activeChatId: string | null;
  personaId: string | null;
  onExportJson: () => void;
  onExportPng: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onCreateChat: () => Promise<void>;
  hasAvatar: boolean;
}

function BuildModeInner({ character, isSaving, buildTab, activeTrace, promptPayloadText, promptTraceCount, currentTraceIndex, imageAttachmentsCount, setSelectedTraceId, promptTraceHistory, onSave, onAvatarUpload, characterId, activeChatId, personaId, onExportJson, onExportPng, onDuplicate, onDelete, onCreateChat, hasAvatar }: BuildModeInnerProps) {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const panels = useBuildPanels();
  const setBuildTab = useCharacterStore((s) => s.setBuildTab);

  const form = useForm<BuildCharacterDraft>({
    resolver: zodResolver(buildCharacterDraftSchema),
    defaultValues: characterDefaults(character),
  });

  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [traceSearch, setTraceSearch] = useState("");
  const [expandedTraceLayerIds, setExpandedTraceLayerIds] = useState<Set<string>>(() => new Set());

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

  async function handleSave(): Promise<void> {
    await form.handleSubmit(async (data) => {
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

  function formatTokenCount(count: number): string {
    const formatted = count.toLocaleString(locale);
    if (locale === "ru") {
      const mod10 = count % 10;
      const mod100 = count % 100;
      const label = mod10 === 1 && mod100 !== 11
        ? "токен"
        : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
          ? "токена"
          : "токенов";
      return `${formatted} ${label}`;
    }
    return `${formatted} ${count === 1 ? "token" : "tokens"}`;
  }

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
            onExportJson={onExportJson}
            onExportPng={onExportPng}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            onAfterImport={async () => { await handleSave(); void onCreateChat(); }}
            hasAvatar={hasAvatar}
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
    const visionDescriptions = trace?.sentConfig?.visionDescriptions ?? [];
    const downloadPayload = () => {
      const blob = new Blob([promptPayloadText], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `prompt-payload-${activeTrace && 'id' in activeTrace ? (activeTrace as { id: string }).id : 'trace'}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    if (isMobile) {
      const q = traceSearch.trim().toLowerCase();
      const visibleLayers = trace?.layers.filter((layer) => {
        if (!q) return true;
        return [layer.sourceName, layer.sourceType, layer.sourceId, layer.text]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q));
      }) ?? [];
      const toggleLayer = (layerId: string) => {
        setExpandedTraceLayerIds((prev) => {
          const next = new Set(prev);
          if (next.has(layerId)) next.delete(layerId);
          else next.add(layerId);
          return next;
        });
      };
      return (
        <div className="pb-4">
          <h1 className="mb-4 font-body text-[22px] font-semibold leading-tight text-t1">{t("build_prompt_trace")}</h1>

          <label className="mb-3 flex h-8 items-center gap-2 rounded-md border border-border bg-s2 px-2.5 font-ui text-[13px] text-t3">
            <span className="text-t4">⌕</span>
            <input
              type="search"
              value={traceSearch}
              onChange={(e) => setTraceSearch(e.target.value)}
              placeholder={t("trace_search_placeholder")}
              className="min-w-0 flex-1 bg-transparent text-t1 outline-none placeholder:text-t4"
            />
          </label>

          <p className="mb-5 font-ui text-[14px] leading-[1.55] text-t3">{t("trace_mobile_hint")}</p>

          {trace && 'id' in trace ? (
            <div className="mb-3 grid grid-cols-[40px_minmax(0,1fr)_40px] items-center gap-2">
              <button type="button"
                className="flex h-10 w-10 items-center justify-center rounded-md bg-s2 font-ui text-lg text-t3 active:bg-s3 disabled:opacity-35"
                disabled={currentTraceIndex >= promptTraceHistory.length - 1}
                onClick={() => {
                  const prev = promptTraceHistory[currentTraceIndex + 1];
                  if (prev) setSelectedTraceId(prev.id);
                }}
              >‹</button>
              <DropdownSelect
                value={(trace as PromptTraceRecordDto).id}
                onChange={setSelectedTraceId}
                searchable={false}
                className="h-10 min-w-0 rounded-md bg-s2 px-3 py-0 text-[13px]"
                options={promptTraceHistory.map((item, index) => {
                  const itemTotal = item.tokenAccounting?.total ?? item.layers.reduce((sum, layer) => sum + layer.tokenCount, 0);
                  return {
                    id: item.id,
                    label: t("trace_turn").replace("{n}", String(promptTraceHistory.length - index)),
                    detail: formatTokenCount(itemTotal),
                  };
                })}
              />
              <button type="button"
                className="flex h-10 w-10 items-center justify-center rounded-md bg-s2 font-ui text-lg text-t3 active:bg-s3 disabled:opacity-35"
                disabled={currentTraceIndex <= 0}
                onClick={() => {
                  const next = promptTraceHistory[currentTraceIndex - 1];
                  if (next) setSelectedTraceId(next.id);
                }}
              >›</button>
            </div>
          ) : null}

          {trace ? (
            <div className="flex flex-col gap-2">
              {visibleLayers.map((layer, index) => {
                const isPreset = layer.sourceType === "prompt_preset";
                const isRetrieval = layer.sourceType.includes("memory") || layer.sourceType === "lore_entry";
                const expanded = expandedTraceLayerIds.has(layer.id);
                return (
                  <div key={layer.id} className={cn(
                    "overflow-hidden rounded-md border border-border bg-s2 font-ui",
                    isPreset && "border-l-2 border-l-info",
                    isRetrieval && "border-l-2 border-l-success",
                    !isPreset && !isRetrieval && "border-l-2 border-l-danger",
                  )}>
                    <button
                      type="button"
                      className="flex w-full cursor-pointer flex-col px-3.5 py-3 text-left active:bg-s3"
                      onClick={() => toggleLayer(layer.id)}
                      aria-expanded={expanded}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0 flex-1 font-semibold text-t2">{index + 1}. {layer.sourceName ?? layer.sourceType}</div>
                        <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>▶</span>
                      </div>
                      <div className="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-t3">
                        <span className="min-w-0 flex-1 truncate">{layer.sourceId || layer.sourceType}</span>
                        <span className="shrink-0 tabular-nums">{formatTokenCount(layer.tokenCount)}</span>
                      </div>
                    </button>
                    {expanded && (
                      <div className="border-t border-border bg-bg p-3 whitespace-pre-wrap font-mono text-[11px] leading-[1.55] text-t1">
                        {layer.text}
                      </div>
                    )}
                  </div>
                );
              })}
              {visibleLayers.length === 0 && (
                <div className="rounded-md border border-dashed border-border2 bg-s2 px-3 py-6 text-center font-ui text-[13px] text-t3">{t("trace_no_active")}</div>
              )}

              <div className="mt-4 flex flex-col gap-3">
                {imageAttachmentsCount > 0 && (
                  <div className="flex items-center gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2.5 font-ui text-[12px] text-info">
                    <span className="text-[14px]">🖼️</span>
                    {t("trace_sent_with_attachments").replace("{n}", String(imageAttachmentsCount))}
                  </div>
                )}
                <button type="button" className="h-9 rounded-md bg-s2 px-4 font-ui text-[12px] font-medium text-t2 active:bg-s3" onClick={downloadPayload}>
                  {t("trace_json_payload")}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-5 flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border2 bg-s2 font-body text-[13px] italic text-t3">
              {t("trace_no_traces_yet")}
            </div>
          )}
        </div>
      );
    }

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
              {t("trace_total_tokens").replace("{n}", formatTokenCount(totalTokens))}
            </div>
          )}
        </div>
        <div className="mb-4 font-ui text-[calc(var(--ui-fs)-1px)] leading-[1.55]">
          {trace && 'id' in trace ? (
            <div className="flex flex-col gap-2">
              {/* Trace navigator */}
              <div className="flex items-center gap-2">
                <button type="button"
                  className="cursor-pointer rounded-md border border-border bg-s2 px-2.5 py-1 text-xs text-t2 transition-colors hover:bg-border2 hover:text-t1 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-s2 disabled:hover:text-t2"
                  disabled={currentTraceIndex >= promptTraceHistory.length - 1}
                  onClick={() => {
                    const prev = promptTraceHistory[currentTraceIndex + 1];
                    if (prev) setSelectedTraceId(prev.id);
                  }}
                >
                  ← {t("trace_prev")}
                </button>
                <span className="text-xs text-t2">
                  {t("trace_turn").replace("{n}", String(promptTraceHistory.length - currentTraceIndex))}
                </span>
                <button type="button"
                  className="cursor-pointer rounded-md border border-border bg-s2 px-2.5 py-1 text-xs text-t2 transition-colors hover:bg-border2 hover:text-t1 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-s2 disabled:hover:text-t2"
                  disabled={currentTraceIndex <= 0}
                  onClick={() => {
                    const next = promptTraceHistory[currentTraceIndex - 1];
                    if (next) setSelectedTraceId(next.id);
                  }}
                >
                  {t("trace_next")} →
                </button>
              </div>
              {/* Trace metadata */}
              <div className="text-t3">
                {formatTraceTimestamp(trace.createdAt)} · {trace.model} · {trace.latencyMs}ms
                {" · "}{t("trace_recorded_count").replace("{n}", String(promptTraceCount))}
                {imageAttachmentsCount > 0 && (
                  <>
                    {" · "}
                    <span className="inline-flex items-center gap-1 rounded bg-info/10 px-1.5 py-0.5 text-xs text-info">
                      <span className="text-[12px]">🖼️</span>
                      {t("trace_sent_with_attachments").replace("{n}", String(imageAttachmentsCount))}
                    </span>
                  </>
                )}
              </div>
            </div>
          ) : (
            <span className="text-t3">
              {t("trace_no_active")}{" "}
              {promptTraceCount > 0 && t("trace_recorded_count").replace("{n}", String(promptTraceCount))}
            </span>
          )}
          {trace?.compactionSummary && (
            <div
              className="mt-1.5 rounded-[6px] border border-warning/50 bg-warning-dim px-2.5 py-1.5 font-body text-xs text-warning-text"
            >
              <strong>{t("trace_compaction_label")}</strong>{" "}
              <span className="whitespace-pre-wrap">{trace.compactionSummary}</span>
            </div>
          )}
          {trace?.prefill && (
            <div
              className="mt-1.5 rounded-[6px] border border-border2 bg-s2 px-2.5 py-1.5 font-body text-xs"
            >
              <strong className="text-t2">{t("trace_prefill_label")}</strong>{" "}
              <span className="whitespace-pre-wrap text-t3">{trace.prefill}</span>
            </div>
          )}
          {visionDescriptions.length > 0 && (
            <div className="mt-1.5 rounded-[6px] border border-info/30 bg-info/10 px-2.5 py-1.5 font-body text-xs text-info">
              <strong>{t("trace_sent_with_attachments").replace("{n}", String(visionDescriptions.length))}</strong>
              <div className="mt-1 space-y-1 whitespace-pre-wrap text-info-text">
                {visionDescriptions.map((item) => (
                  <div key={item.attachmentId}>
                    <span className="font-medium">{item.name}</span>{" "}
                    <span className="text-info/80">({item.type})</span>
                    {": "}{item.description}
                  </div>
                ))}
              </div>
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
                      {index + 1}. {layer.sourceName ?? layer.sourceType}
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
              <button type="button"
                className="inline-flex cursor-pointer items-center rounded-md border-0 bg-s3 px-4 py-2 font-ui text-xs font-medium text-t2 transition-colors hover:bg-border2 hover:text-t1"
                onClick={() => {
                  const blob = new Blob([promptPayloadText], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `prompt-payload-${activeTrace && 'id' in activeTrace ? (activeTrace as { id: string }).id : 'trace'}.json`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }}
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

  // ── Mobile: fullscreen editor (navigation via Rail) ──
  if (isMobile) {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", !isFullBleed && "p-4")}>
        <div className={cn("flex-1 min-h-0", !isFullBleed && "overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden")}>
          {renderPanelContent()}
        </div>
      </div>
    );
  }

  // ── Desktop ──
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
