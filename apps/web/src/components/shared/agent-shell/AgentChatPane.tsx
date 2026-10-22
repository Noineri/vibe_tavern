import type { Dispatch, ReactNode, SetStateAction } from "react";
import { toast } from "sonner";
import type {
  AgentThreadEventWire,
  ExperienceCopilotMessageWire,
  ExperienceCopilotThreadWire,
} from "@vibe-tavern/api-contracts";
import type { AgentPlanOwner } from "@vibe-tavern/domain";
import { Icons } from "../icons.js";
import { EmptyState } from "../empty-state.js";
import { useT } from "../../../i18n/context.js";
import type {
  AgentHostContext,
  AgentHostDescriptor,
  AgentKind,
  AgentSendOptions,
} from "../../../lib/agent-host-registry.js";
import type { AgentController } from "./use-agent-controller.js";
import type { CopilotContextController } from "../../../hooks/use-copilot-context.js";
import type { MentionAutocompleteItem } from "../mention-autocomplete-query.js";
import { AgentChatHeader } from "./AgentChatHeader.js";
import { AgentContextMeter } from "./AgentContextMeter.js";
import { AgentTodoSection } from "./AgentTodoSection.js";
import { AgentPlanSection } from "./AgentPlanSection.js";
import { AgentMessageList } from "./AgentMessageList.js";
import { AgentInputArea } from "./AgentInputArea.js";
import { AgentMobileInputArea } from "./AgentMobileInputArea.js";
import type { AgentContextPillItem } from "./AgentContextPills.js";

/**
 * AgentChatPane (AGENT_SHELL_POLISH AP-3b) — the agent shell's chat pane,
 * extracted VERBATIM from `AgentShell.tsx` (which sits at the arch-gate line
 * cap): loading / error / empty states, header, context meter, todo + plan
 * sections, message list, and both composers (mobile / desktop). A pure
 * move — this JSX is byte-identical to the pre-split `chatPane` block; the
 * shell builds ONE `<AgentChatPane … />` element and renders it from every
 * layout branch (mobile tabbed, mobile chat-only, desktop chat-only,
 * desktop two-pane), exactly as it rendered the old variable. Later
 * shell-polish units (AP-5/6/11/13/14/16/18) grow THIS file, not the
 * capped shell.
 *
 * PROP SURFACE = exactly what the block read in the shell: the session
 * lifecycle state (loading / error / threadId + the retry `loadSession`),
 * the host descriptor + host context (toolbar slot, meter labels, i18n
 * keys), the session switcher data + handlers, the stream controller
 * (send / answer / cancel + pending mirrors), the copilot context
 * controller (metrics / compaction), the mention catalog + pinned-context
 * pills + their handlers, the per-kind model binding, the send-options
 * dispatcher, and the composer top slot. The pane owns NO state and NO
 * logic of its own; `t` comes from the same i18n context the shell uses.
 */

export interface AgentChatPaneProps {
  kind: AgentKind;
  isMobile: boolean;
  host: AgentHostDescriptor;
  hostCtx: AgentHostContext;
  sessionLoading: boolean;
  sessionError: string | null;
  threadId: string | null;
  loadSession: () => Promise<void>;
  sessions: ExperienceCopilotThreadWire[];
  messages: ExperienceCopilotMessageWire[];
  events: AgentThreadEventWire[];
  handleActivate: (targetThreadId: string) => Promise<void>;
  handleNewSession: () => Promise<void>;
  handleRenameSession: (targetThreadId: string, title: string) => Promise<void>;
  setProfileModalOpen: Dispatch<SetStateAction<boolean>>;
  copilotContext: CopilotContextController;
  ctrl: AgentController;
  sendWithOptions: (dispatch: (opts?: AgentSendOptions) => void) => void;
  planOwner: AgentPlanOwner | undefined;
  inputPrefill: { text: string } | null;
  providerProfileId: string | null;
  model: string | undefined;
  handleProviderChange: (profileId: string, nextModel?: string) => void;
  catalog: MentionAutocompleteItem[];
  pinnedContext: AgentContextPillItem[];
  handlePinContext: (item: MentionAutocompleteItem) => void;
  handleUnpinContext: (targetType: string, targetId: string) => void;
  composerTopSlot: ReactNode;
}

export function AgentChatPane({
  kind,
  isMobile,
  host,
  hostCtx,
  sessionLoading,
  sessionError,
  threadId,
  loadSession,
  sessions,
  messages,
  events,
  handleActivate,
  handleNewSession,
  handleRenameSession,
  setProfileModalOpen,
  copilotContext,
  ctrl,
  sendWithOptions,
  planOwner,
  inputPrefill,
  providerProfileId,
  model,
  handleProviderChange,
  catalog,
  pinnedContext,
  handlePinContext,
  handleUnpinContext,
  composerTopSlot,
}: AgentChatPaneProps) {
  const { t } = useT();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      {sessionLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Icons.Sparkles className="h-6 w-6 animate-pulse text-t3" />}
            title={t(host.i18n.loading)}
          />
        </div>
      ) : sessionError ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Icons.Close className="h-6 w-6 text-danger-text" />}
            title={t("agent_load_error")}
            sub={sessionError}
            cta={<span>{t("agent_retry")}</span>}
            onCta={() => void loadSession()}
          />
        </div>
      ) : threadId ? (
        <>
          <AgentChatHeader
            leading={host.toolbarSlot?.(hostCtx)}
            sessions={sessions}
            activeThreadId={threadId}
            disabled={ctrl.isSending}
            onActivate={handleActivate}
            onNew={handleNewSession}
            onRename={handleRenameSession}
            onOpenProfile={() => setProfileModalOpen(true)}
          />
          <AgentContextMeter
            metrics={copilotContext.metrics}
            segmentLabels={host.meterSegmentLabels}
            autoCompact={copilotContext.autoCompact}
            isCompacting={copilotContext.isCompacting}
            isSending={ctrl.isSending}
            onCompact={() =>
              void copilotContext.compact().catch((err: unknown) => {
                // Surface the server's reason (typed 400s carry a meaningful
                // message, e.g. "Nothing to compact…") instead of a generic label.
                const message = err instanceof Error && err.message ? err.message : "";
                toast.error(message || t("copilot_context_compact_error"));
              })
            }
            onToggleAutoCompact={(enabled) =>
              void copilotContext.setAutoCompact(enabled).catch(() => {
                toast.error(t("copilot_context_auto_toggle_error"));
              })
            }
          />
          {/* TAG-8 (restored PM-7): the pinned session-checklist section sits
              DIRECTLY below the meter and DIRECTLY ABOVE the plan section
              (never scrolls with the feed); hidden until the model's first
              `todo` call; read-only — the model owns the checklist. */}
          <AgentTodoSection kind={kind} threadId={threadId} />
          {/* PM-6: the owner-scoped agent plan sits DIRECTLY below the todo
              section; hidden while the plan is empty; its editor locks while a
              turn streams. PM-7: todo (the thread's session) ABOVE plan (the
              owner's durable document) — each hides itself when empty.
              SC-0i: unmounted entirely when the host defines no plan owner. */}
          {planOwner !== undefined && <AgentPlanSection owner={planOwner} locked={ctrl.isSending} />}
          <AgentMessageList
            kind={kind}
            threadId={threadId}
            messages={messages}
            events={events}
            pendingText={ctrl.pendingText}
            pendingReasoning={ctrl.pendingReasoning}
            pendingUserContent={ctrl.pendingUserContent}
            isSending={ctrl.isSending}
            pendingAskAnswer={ctrl.pendingAskAnswer}
            pendingPermissionAnswer={ctrl.pendingPermissionAnswer}
            emptyTitle={t(host.i18n.emptyTitle)}
            emptySub={host.i18n.emptySub !== undefined ? t(host.i18n.emptySub) : undefined}
            onAnswer={(askToolCallId, answer) => {
              sendWithOptions((options) => void ctrl.handleAnswer(askToolCallId, answer, options));
            }}
          />
          {isMobile ? (
            <AgentMobileInputArea
              isSending={ctrl.isSending}
              prefill={inputPrefill ?? undefined}
              onSend={(content) => {
                sendWithOptions((options) => void ctrl.handleSend(content, options));
              }}
              onCancel={ctrl.handleCancel}
              providerProfileId={providerProfileId}
              model={model}
              onProviderChange={handleProviderChange}
              mentionCatalog={catalog}
              pinnedContext={pinnedContext}
              onPinContext={handlePinContext}
              onUnpinContext={handleUnpinContext}
              topSlot={composerTopSlot}
            />
          ) : (
            <AgentInputArea
              isSending={ctrl.isSending}
              prefill={inputPrefill ?? undefined}
              onSend={(content) => {
                sendWithOptions((options) => void ctrl.handleSend(content, options));
              }}
              onCancel={ctrl.handleCancel}
              providerProfileId={providerProfileId}
              model={model}
              onProviderChange={handleProviderChange}
              mentionCatalog={catalog}
              pinnedContext={pinnedContext}
              onPinContext={handlePinContext}
              onUnpinContext={handleUnpinContext}
              topSlot={composerTopSlot}
            />
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Icons.Sparkles className="h-6 w-6 text-t3" />}
            title={t(host.i18n.title)}
            sub={host.i18n.subtitle !== undefined ? t(host.i18n.subtitle) : undefined}
          />
        </div>
      )}
    </div>
  );
}
