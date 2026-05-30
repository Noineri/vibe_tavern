import { useEffect, useMemo, useRef, useState } from "react";
import { PersonaQuickSwitch } from "../modals/PersonaQuickSwitch.js";
import { Icons } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { avatarUrl } from "../../lib/avatar.js";
import { useTokenCount } from "../../hooks/use-token-count.js";
import { useT } from "../../i18n/context.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useProviderProfiles } from "../../hooks/use-provider-profiles.js";
import { useIsMobile } from "../../hooks/use-mobile.js";

import { useChatStore, useProviderStore, useIsSending } from "../../stores/index.js";
import { useActiveTrace, useChatMeta } from "../../stores/chat-selectors.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useModalStore } from "../../stores/modal-store.js";
import type { PromptLayerDto } from "@vibe-tavern/domain";

export function InputArea() {
  const { t } = useT();
  const [tokenPopOpen, setTokenPopOpen] = useState(false);
  const [modelDropOpen, setModelDropOpen] = useState(false);
  const tokenPopRef = useRef<HTMLDivElement>(null);
  const modelDropRef = useRef<HTMLDivElement>(null);
  const [mobilePersonaOpen, setMobilePersonaOpen] = useState(false);
  const mobilePersonaRef = useRef<HTMLDivElement>(null);

  // --- Sub-hooks ---
  const chat = useChatController();
  const character = useCharacterController();
  const provider = useProviderProfiles();
  const bootstrapData = useBootstrapStore((s) => s.data);

  // --- Store subscriptions ---
  const draft = useChatStore((s) => s.draft);
  const isSending = useIsSending();
  const activeChatId = useChatStore((s) => s.activeChatId);
  const chatMeta = useChatMeta();
  const connection = useProviderStore((s) => s.connection);

  const personas = useBootstrapStore((s) => s.personas) ?? [];
  const activePromptTrace = useActiveTrace(useChatStore((s) => s.selectedTraceId));
  const canUseLiveApi = connection.status === "connected" && Boolean(connection.model);

  const activePersonaId = chatMeta?.persona?.id ?? null;
  const contextSize = provider.activeProviderProfile?.contextBudget ?? 0;
  const maxTokens = provider.activeProviderProfile?.maxTokens ?? 0;
  const favoriteModels = provider.activeProviderProfile ? (provider.favoriteModelsByProfile[provider.activeProviderProfile.id] ?? []) : [];
  const activeModelId = provider.activeProviderProfile?.defaultModel ?? connection.model ?? null;
  const canSend = Boolean(draft.trim()) && !isSending && canUseLiveApi;
  const setDraft = useChatStore((s) => s.setDraft);

  // Render helpers
  function renderSendLabel(): string {
    if (isSending) return t("sending");
    if (canUseLiveApi && draft.trim()) return t("send_message");
    if (!canUseLiveApi) return t("send_unavailable");
    return t("type_a_message");
  }
  const sendLabel = renderSendLabel();

  // --- Token counting from backend prompt trace layers ---
  const TEMPORARY_TYPES = new Set(["chat_history", "compaction"]);

  const buckets = useMemo(() => {
    const layers: PromptLayerDto[] = activePromptTrace?.layers ?? [];
    let system = 0, character = 0, persona = 0, lore = 0, memory = 0, tools = 0, history = 0;
    for (const layer of layers) {
      if (!layer.enabled || layer.position === "hidden_system") continue;
      const tokens = layer.tokenCount;
      if (TEMPORARY_TYPES.has(layer.sourceType)) {
        history += tokens;
      } else {
        switch (layer.sourceType) {
          case "prompt_preset":          system += tokens; break;
          case "character_system_prompt": system += tokens; break;
          case "character":             character += tokens; break;
          case "persona":               persona += tokens; break;
          case "lore_entry":            lore += tokens; break;
          case "summary_memory":        memory += tokens; break;
          case "retrieval_memory":      memory += tokens; break;
          case "tool_profile":          tools += tokens; break;
          default:                      system += tokens; break;
        }
      }
    }
    return { system, character, persona, lore, memory, tools, history };
  }, [activePromptTrace?.layers]);

  const inputTokens = useTokenCount(draft);
  const permanent = buckets.system + buckets.character + buckets.persona + buckets.lore + buckets.memory + buckets.tools;
  const totalUsed = permanent + buckets.history + inputTokens;
  const availableBudget = Math.max(0, contextSize - maxTokens);
  const usageRatio = availableBudget > 0 ? totalUsed / availableBudget : 0;
  const tokenState = usageRatio > 0.95 ? "warn" : usageRatio > 0.75 ? "mid" : "ok";
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!mobilePersonaOpen && !tokenPopOpen && !modelDropOpen) return;
    function handleClick(e: MouseEvent) {
      if (mobilePersonaRef.current && !mobilePersonaRef.current.contains(e.target as Node)) {
        setMobilePersonaOpen(false);
      }
      if (tokenPopRef.current && !tokenPopRef.current.contains(e.target as Node)) {
        setTokenPopOpen(false);
      }
      if (modelDropRef.current && !modelDropRef.current.contains(e.target as Node)) {
        setModelDropOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [mobilePersonaOpen, tokenPopOpen, modelDropOpen]);

  const sendButtonText = canSend || !draft.trim() ? t("send") : sendLabel || t("send_unavailable");

  // ── Auto-expand textarea (mobile) ──
  const mobileTextareaRef = useRef<HTMLTextAreaElement>(null);
  const adjustTextareaHeight = () => {
    const ta = mobileTextareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
    }
  };
  // Shrink textarea back when draft is cleared (after send)
  useEffect(() => {
    if (isMobile && !draft) adjustTextareaHeight();
  }, [draft, isMobile]);

  // ── Mobile: compact two-row input ──
  if (isMobile) {
    return (
      <div className={cn(
        "relative z-10 shrink-0 border-t border-border bg-surface px-1.5 pb-[calc(env(safe-area-inset-bottom,0px)+8px)] pt-2",
        activeChatId ? '' : 'pointer-events-none opacity-45'
      )}>
        <div className="flex flex-col gap-1.5 rounded-xl bg-s2 p-1.5">
          {/* Toolbar row: persona + starred models */}
          <div className="flex items-center justify-between gap-2">
            <div className="relative" ref={mobilePersonaRef}>
              <button type="button" onClick={() => setMobilePersonaOpen(o => !o)} className="flex h-9 items-center gap-1.5 rounded-md bg-s3 px-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 active:bg-s2">
                {activePersonaId ? (
                  <PersonaAvatar assetId={personas.find(p => p.id === activePersonaId)?.avatarAssetId ?? null} size={20} />
                ) : (
                  <Icons.User />
                )}
                <span className="max-w-[120px] min-w-0 truncate">{activePersonaId ? (personas.find(p => p.id === activePersonaId)?.name ?? t("no_persona")) : t("no_persona")}</span>
                <Icons.Caret direction="d" />
              </button>
              {mobilePersonaOpen && (
                <div className="absolute bottom-[calc(100%+4px)] left-0 z-[220] w-[240px] rounded-lg border border-border2 bg-surface py-2 shadow-theme-md">
                  <div className="px-4 pb-2 text-[calc(var(--ui-fs)-3px)] uppercase tracking-[0.08em] text-t3 font-medium border-b border-border mb-1">{t("persona_selection")}</div>
                  {personas.map(p => (
                    <button type="button" key={p.id} className="flex w-full min-h-[44px] cursor-pointer items-center gap-2 px-4 text-[calc(var(--ui-fs)-1px)] text-t1 active:bg-s2" onClick={() => { void character.handleSetChatPersona(p.id); setMobilePersonaOpen(false); }}>
                      <div className="w-4 shrink-0 flex justify-center text-accent-t">{activePersonaId === p.id && <Icons.Check/>}</div>
                      <PersonaAvatar assetId={p.avatarAssetId} size={22} />
                      <div className="min-w-0 truncate">{p.name}</div>
                    </button>
                  ))}
                  <div className="pt-1 px-2 mt-1 border-t border-border">
                    <button type="button" className="flex w-full min-h-[44px] cursor-pointer items-center gap-1.5 rounded-md px-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 active:bg-s2" onClick={() => { setMobilePersonaOpen(false); useModalStore.getState().setIsPersonaModalOpen(true); }}><Icons.Edit/> {t("manage_personas")}</button>
                  </div>
                </div>
              )}
            </div>
            <div className="relative" ref={modelDropRef}>
              <button type="button" onClick={() => setModelDropOpen(o => !o)} className="flex h-9 w-9 items-center justify-center rounded-md bg-s3 text-warning-text active:bg-s2">
                <Icons.StarFilled />
              </button>
              {modelDropOpen && (
                <div className="absolute bottom-[calc(100%+4px)] right-0 z-[220] w-[240px] rounded-lg border border-border2 bg-surface py-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                  <div className="px-4 pb-2 text-[calc(var(--ui-fs)-3px)] uppercase tracking-[0.08em] text-t3 font-medium border-b border-border mb-1">{t("starred_models")}</div>
                  {favoriteModels.length > 0 ? (
                    favoriteModels.map(model => (
                      <div key={model.modelId} className="flex min-h-[44px] cursor-pointer items-center gap-2 px-4 text-[calc(var(--ui-fs)-1px)] text-t1 active:bg-s2" onClick={() => {
                        if (provider.activeProviderProfile) void provider.handleSelectFavoriteProviderModel(provider.activeProviderProfile.id, model.modelId);
                        setModelDropOpen(false);
                      }}>
                        <div className="w-4 shrink-0 flex justify-center text-accent-t">{activeModelId === model.modelId && <Icons.Check/>}</div>
                        <div className="min-w-0 truncate">{model.label || model.modelId}</div>
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-3 text-[calc(var(--ui-fs)-2px)] text-t3">{t("no_starred_models")}</div>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Input row */}
          <div className="flex items-end gap-2">
            <textarea
              ref={mobileTextareaRef}
              className="max-h-[40vh] min-h-[44px] flex-1 resize-none border-0 bg-transparent py-2 pr-1 font-body text-[15px] leading-[1.4] text-t1 outline-none placeholder:text-t4 overflow-y-auto"
              placeholder={t("placeholder")}
              value={draft}
              onChange={(event) => { setDraft(event.target.value); adjustTextareaHeight(); }}
              rows={1}
            />
            <div className="flex shrink-0 items-center">
              {isSending ? (
                <button type="button" className="flex h-9 w-9 items-center justify-center rounded-lg border border-danger text-danger-text active:bg-danger/10" onClick={chat.handleCancelGeneration}>
                  <span className="text-[11px] font-bold">✕</span>
                </button>
              ) : (
                <button type="button" className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-on-accent disabled:opacity-45 active:scale-95" disabled={!canSend} onClick={() => void chat.handleSend()}>
                  <Icons.Caret direction="r" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Desktop ──
  return (
    <div
        className="relative z-10 shrink-0 border-t border-border bg-surface px-4 pt-2.5 pb-3.5 transition-opacity duration-200"
      >
        <div className="rounded-lg border border-border bg-bg transition-colors duration-150 focus-within:border-border2">
          <textarea
            className="max-h-40 min-h-[55px] w-full resize-none border-0 bg-transparent px-4 pt-[13px] pb-2 font-body text-[16.5px] leading-[1.65] text-t1 outline-none placeholder:text-t4"
            placeholder={t("placeholder")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (canSend) void chat.handleSend();
              }
            }}
            rows={2}
          />

          <div className="relative flex items-center gap-[7px] pt-1.5 pb-[9px] pl-3 pr-[135px]">
            <CustomTooltip content={t("multi_persona_tooltip")}>
              <div className="speaker-row multi-persona">
                <span className="text-[calc(var(--ui-fs)-3px)] uppercase tracking-[0.06em] text-t3">{t("speak_as")}</span>
              </div>
            </CustomTooltip>
            <PersonaQuickSwitch personas={personas} activePersonaId={activePersonaId} onSelect={character.handleSetChatPersona} />
            <div className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />

            <div className="relative" ref={tokenPopRef}>
              <span
                className={cn(
                  "cursor-pointer whitespace-nowrap text-[calc(var(--ui-fs)-3px)] tabular-nums transition-colors duration-150 hover:text-t1",
                  tokenState === "warn" ? "text-danger-text" : tokenState === "mid" ? "text-warning-text" : "text-t3",
                )}
                onClick={() => setTokenPopOpen((open) => !open)}
              >
                {permanent.toLocaleString()}<span className="text-t4">+</span>{(buckets.history + inputTokens).toLocaleString()} / {contextSize > 0 ? contextSize.toLocaleString() : "∞"}
              </span>
              {tokenPopOpen && (
                <div
                  className="absolute bottom-[calc(100%+8px)] left-1/2 z-[220] w-[240px] -translate-x-1/2 rounded-lg border border-border2 bg-surface px-3.5 py-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.45)]"
                >
                  <div className="mb-1.5 border-b border-border pb-1.5 text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("context_breakdown")}</div>
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-t4">{t("context_permanent")}</div>
                  <div className="mb-1 flex justify-between text-xs text-t2"><span>{t("context_system")}</span><span className="tabular-nums text-t1">{buckets.system.toLocaleString()}</span></div>
                  <div className="mb-1 flex justify-between text-xs text-t2"><span>{t("context_character")}</span><span className="tabular-nums text-t1">{buckets.character.toLocaleString()}</span></div>
                  <div className="mb-1 flex justify-between text-xs text-t2"><span>{t("context_persona")}</span><span className="tabular-nums text-t1">{buckets.persona.toLocaleString()}</span></div>
                  <div className="mb-1 flex justify-between text-xs text-t2"><span>{t("context_lore")}</span><span className="tabular-nums text-t1">{buckets.lore.toLocaleString()}</span></div>
                  <div className="mb-1 flex justify-between text-xs text-t2"><span>{t("context_memory")}</span><span className="tabular-nums text-t1">{buckets.memory.toLocaleString()}</span></div>
                  <div className="mb-1.5 flex justify-between text-xs text-t2"><span>{t("context_tools")}</span><span className="tabular-nums text-t1">{buckets.tools.toLocaleString()}</span></div>
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-t4">{t("context_temporary")}</div>
                  <div className="mb-1 flex justify-between text-xs text-t2"><span>{t("context_history")}</span><span className="tabular-nums text-t1">{buckets.history.toLocaleString()}</span></div>
                  <div className="mb-1.5 flex justify-between text-xs text-t2"><span>{t("context_current_input")}</span><span className="tabular-nums text-t1">{inputTokens.toLocaleString()}</span></div>
                  <div className="mb-1 flex justify-between border-t border-border pt-1.5 text-xs text-t2"><span>{t("context_response_budget")}</span><span className="tabular-nums text-t1">{maxTokens === -1 ? '∞' : `-${maxTokens.toLocaleString()}`}</span></div>
                  <div className="mt-0.5 flex justify-between text-xs font-medium text-t1"><span>{t("context_total_available")}</span><span className="tabular-nums">{maxTokens === -1 ? '∞' : availableBudget.toLocaleString()}</span></div>
                  {availableBudget > 0 && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-s3">
                      <div className="flex h-full">
                        <CustomTooltip content={`${t("context_permanent")}: ${permanent.toLocaleString()}`}>
                        <div className="bg-accent" style={{ width: `${Math.min(100, permanent / availableBudget * 100)}%` }} />
                        </CustomTooltip>
                        <CustomTooltip content={`${t("context_history")}: ${buckets.history.toLocaleString()}`}>
                        <div className="bg-t3" style={{ width: `${Math.min(100, buckets.history / availableBudget * 100)}%` }} />
                        </CustomTooltip>
                        <CustomTooltip content={`${t("context_current_input")}: ${inputTokens.toLocaleString()}`}>
                        <div className="bg-accent-t" style={{ width: `${Math.min(100, inputTokens / availableBudget * 100)}%` }} />
                        </CustomTooltip>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="absolute right-3 bottom-[9px] flex items-center gap-[9px]">
              {!isSending && (
                <div className="relative flex items-center" ref={modelDropRef}>
                  <CustomTooltip content={t("starred_models")}>
                    <button type="button"
                      className={cn(
                        "flex h-8 items-center justify-center rounded-[5px] bg-s2 px-2.5 text-warning-text transition-colors hover:bg-s3 hover:brightness-110",
                        modelDropOpen ? "brightness-110" : "",
                      )}
                      onClick={() => setModelDropOpen((open) => !open)}
                    >
                      <Icons.StarFilled />
                    </button>
                  </CustomTooltip>
                  {modelDropOpen && (
                    <div className="absolute bottom-[calc(100%+8px)] right-0 z-[220] w-[260px] rounded-lg border border-border2 bg-surface py-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                      <div className="mb-1 border-b border-border px-4 pb-2 pt-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("starred_models")}</div>
                      {favoriteModels.length > 0 ? (
                        favoriteModels.map((model) => (
                          <div
                            key={model.modelId}
                            className="flex cursor-pointer items-center gap-2 px-4 py-1.5 font-ui text-[13px] text-t1 hover:bg-s2"
                            onClick={() => {
                              if (provider.activeProviderProfile) void provider.handleSelectFavoriteProviderModel(provider.activeProviderProfile.id, model.modelId);
                              setModelDropOpen(false);
                            }}
                          >
                            <div className="flex w-4 shrink-0 justify-center text-accent-t">{activeModelId === model.modelId && <Icons.Check />}</div>
                            <div className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{model.label || model.modelId}</div>
                          </div>
                        ))
                      ) : (
                        <div className="px-4 py-2 font-ui text-[12px] text-t3">{t("no_starred_models")}</div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {isSending ? (
                <button type="button"
                  className="flex h-7 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-[5px] border border-danger bg-surface px-3.5 font-ui text-[12.5px] font-medium text-danger-text transition-colors duration-150 hover:bg-danger-dim disabled:cursor-default disabled:opacity-60"
                  onClick={chat.handleCancelGeneration}
                >
                  {t("cancel")}
                </button>
              ) : (
                <CustomTooltip content={sendLabel}>
                  <button type="button"
                    className="flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-accent px-4 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all duration-150 hover:brightness-110 disabled:cursor-default disabled:opacity-45 disabled:filter-none"
                    disabled={!canSend}
                    onClick={() => void chat.handleSend()}
                    aria-label={sendLabel}
                  >
                    {sendButtonText}
                  </button>
                </CustomTooltip>
              )}
            </div>
          </div>
        </div>
      </div>
    );
}

function PersonaAvatar({ assetId, size }: { assetId: string | null; size: number }) {
  if (!assetId) {
    return (
      <div className="shrink-0 rounded-full bg-s3 flex items-center justify-center text-[calc(var(--ui-fs)-3px)] text-t2 font-ui" style={{ width: size, height: size }}>
        <Icons.User />
      </div>
    );
  }
  return (
    <img src={avatarUrl(assetId)} alt="" className="shrink-0 rounded-full object-cover object-top" style={{ width: size, height: size }} />
  );
}
