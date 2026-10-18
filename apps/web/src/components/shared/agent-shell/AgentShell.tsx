import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type {
  ExperienceCopilotContextLink,
  ExperienceCopilotContextTargetType,
  ExperienceCopilotMessageWire,
  ExperienceCopilotThreadWire,
} from "@vibe-tavern/api-contracts";
import type { AgentPlanOwner, AgentThreadOwner } from "@vibe-tavern/domain";
import type { CopilotTodoItem } from "@vibe-tavern/api-contracts";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../icons.js";
import { EmptyState } from "../empty-state.js";
import { useT } from "../../../i18n/context.js";
import { agentOwnerKey, agentThreadKey, getAgentHost, scriptOwnerId, type AgentHostBridge, type AgentHostContext, type AgentKind } from "../../../lib/agent-host-registry.js";
import { useAgentController, type AgentSendOptions } from "./use-agent-controller.js";
import { useAgentPlan } from "../../../hooks/use-agent-plan.js";
import { useCopilotContext } from "../../../hooks/use-copilot-context.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { useProviderModels } from "../../../hooks/use-provider-models.js";
import { useBootstrapStore, patchUiSettingsAction } from "../../../stores/api-actions/bootstrap-actions.js";
import { listPersonas } from "../../../api/persona-api.js";
import { listAllLorebooks } from "../../../api/lorebook-api.js";
import { listAllScripts } from "../../../api/script-api.js";
import { listCoauthorSkills } from "../../../api/skill-api.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import type { MentionAutocompleteItem } from "../mention-autocomplete-query.js";
import { AgentChatHeader } from "./AgentChatHeader.js";
import { AgentContextMeter } from "./AgentContextMeter.js";
import { AgentTodoSection } from "./AgentTodoSection.js";
import { AgentPlanSection } from "./AgentPlanSection.js";
import { AgentProfileModal } from "./AgentProfileModal.js";
import { AgentMessageList } from "./AgentMessageList.js";
import { AgentInputArea } from "./AgentInputArea.js";
import { AgentMobileInputArea } from "./AgentMobileInputArea.js";
import { AgentShellTabButton } from "./AgentShellTabButton.js";
import type { AgentContextPillItem } from "./AgentContextPills.js";

/**
 * AgentShell (AGENT_SHELL_PLAN AS-6b2) — the GENERIC two-pane agent surface
 * every host reuses: chat-left (sessions, context, meter, todo + plan, feed,
 * input) and host-right (the host descriptor's editor pane). Extracted from
 * `ExperienceCopilotShell` with the mini-app's behavior byte-identical; the
 * experience-specific editor pane lives in the `experience` host module
 * (experience-agent-host.tsx).
 *
 * HOST CONTRACT (lib/agent-host-registry.ts): the shell knows a host ONLY
 * through its descriptor — the i18n key table (loading/empty states, the
 * mobile back label), `renderEditorPane(ctx)` (absent = CHAT-ONLY host: the
 * chat pane takes the full width and the mobile tab row is not rendered at
 * all), and `buildSendOptions(ctx)` fed from the live bridge session. The
 * BRIDGE (AgentHostBridge) is the shell↔host live seam: the host's editor
 * pane registers a session handle (dangling-review capture before each send
 * + the per-turn send options), and host surfaces prefill the chat input.
 *
 * Responsive pattern mirrors `CoauthorMode`: on mobile BOTH panes stay
 * MOUNTED across tab switches (only `hidden` toggles) so the CodeMirror
 * editor and the chat scroll positions survive. The shell owns NO canonical
 * buffer text — buffers are host props; the shell holds only session state
 * (threadId / messages / loading / error), the provider/model selection, the
 * UI-only mobile tab selection, and the profile modal open flag.
 *
 * AS-6c SEAMS (remaining for later units): the turn/review stores keep their
 * `experience-copilot-*` names (AS-10 owns the call-site rename), and the
 * transport/wire types stay the experience client's (server keys stay bare
 * threadId — only the in-client store maps re-key through `agentThreadKey`).
 * AS-6c-ii landed here: the controller takes the host `kind` (required) and
 * every store read/write keys through the helper; the send path itself is
 * fully behind the descriptor's `transport` (AS-6c-i).
 */

export interface AgentShellProps {
  /** The registered host kind driving this shell (`getAgentHost(kind)`). */
  kind: AgentKind;
  /** The typed thread owner — both script hosts pass
   *  `{ kind: "script", scriptId }` (the unsaved mini-app draft passes its
   *  local draft id here, exactly as it passed it as `ownerId` before). */
  owner: AgentThreadOwner;
  isMobile: boolean;
  /** E6: mobile back-navigation affordance (a ← chevron folded into the
   *  tab-bar row). Desktop never passes it. Requires the host's
   *  `mobileBackLabelKey` to render. */
  onBack?: () => void;
  /** E6: the edit tab needs saving (dirty or save failed) — badge dot on the
   *  Edit tab while the user is on Chat, one-shot pulse on the clean→dirty
   *  edge. Mobile-only by design. */
  editTabDirty?: boolean;
  /** E6: management cluster rendered at the top of the mobile Edit tab.
   *  Desktop never passes it. */
  editTabHeader?: ReactNode;
  /** The agent profile assigned to this owner (`scripts.copilotProfileId`),
   *  or null (built-in seed). Drives the gear button's profile modal. */
  assignedProfileId?: string | null;
  /** Host-specific props, opaque to the shell — forwarded through
   *  `AgentHostContext.hostProps` to renderEditorPane/buildSendOptions. */
  hostProps?: unknown;
}

type MobileTab = "chat" | "edit";

/** E6: how long the Edit-tab pulse plays after the clean→dirty edge.
 *  Matches the CSS animation total (~2 × 1.1s), same as DOC_PULSE_MS in
 *  CoauthorMode. */
const EDIT_TAB_PULSE_MS = 2200;

export function AgentShell({
  kind,
  owner,
  isMobile,
  onBack,
  editTabDirty = false,
  editTabHeader,
  assignedProfileId = null,
  hostProps,
}: AgentShellProps) {
  const host = getAgentHost(kind);
  // AS-6c-i: the transport seam — every send/observe API call below goes
  // through the descriptor, so this shell imports no kind-specific client.
  const transport = host.transport;
  const { t } = useT();

  // ── Session lifecycle state ──────────────────────────────────────────────
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ExperienceCopilotMessageWire[]>([]);
  const [sessions, setSessions] = useState<ExperienceCopilotThreadWire[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // ── Pinned context (CX-6) ───────────────────────────────────────────────
  // The thread's contextLinks (from every thread wire that arrives) + the
  // merged mention catalog. Pins are optimistically PATCHed (full-replace).
  const [contextLinks, setContextLinks] = useState<ExperienceCopilotContextLink[]>([]);
  const [mentionCatalog, setMentionCatalog] = useState<MentionAutocompleteItem[]>([]);
  // ── Session checklist todo (TAG-8, restored PM-7) ──────────────────────
  // The thread wire's `todo` — the session checklist living BESIDE the plan.
  // Held ONLY to seed the turn store's `todoByThread` via the controller
  // (TAG-7 effect); the live truth is the store (`todo` tool updates it).
  const [threadTodo, setThreadTodo] = useState<CopilotTodoItem[] | undefined>(undefined);
  // ── Script-owned agent plan (PM-6, EXPERIENCE_COPILOT_PLAN_MODE_PLAN) ────
  // ONE plan per script (the `agent_plans` row), the durable document that
  // survives sessions: the model maintains it through the `plan`/`read_plan`
  // tools, the user through the editor modal. useAgentPlan is the single
  // web-side cache; the controller feeds `plan` tool results into the SAME
  // cache (applyPlanToolResult), and AgentPlanSection renders the panel +
  // modal from it. Session switching/archiving never touches it (it is not
  // thread state).
  // SC-0c: the owner carries the script id for script-owned hosts (both
  // wrappers pass it); the plan owner comes from the host starting SC-0i.
  const scriptId = scriptOwnerId(owner);
  // The session effects key on the owner's logical identity, never on the
  // object identity — a fresh-but-equal owner literal must not refetch.
  const ownerKey = agentOwnerKey(owner);
  // The transport calls read the owner through a ref: wrappers pass inline
  // literals (a new object every render), so depending on the object would
  // refetch the session on every parent re-render (ScriptEditor pins this:
  // no second `active` GET across the mobile breakpoint). The KEY carries
  // the identity (effect deps), the ref carries the value (call args) — a
  // changed key still refetches with the current owner.
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const planOwner = useMemo<AgentPlanOwner>(() => ({ kind: "script", scriptId }), [scriptId]);
  const agentPlan = useAgentPlan(planOwner);

  // Characters come from the live snapshot store (already app-wide); the other
  // four catalog sources are fetched ONCE per shell mount (best-effort — a
  // transient failure simply leaves that type out of the picker, mirroring the
  // fetchSessions swallow-with-comment style).
  const allCharacters = useSnapshotStore((s) => s.allCharacters);
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([listPersonas(), listAllLorebooks(), listAllScripts(), listCoauthorSkills()]).then(
      ([personas, lorebooks, scripts, skills]) => {
        if (cancelled) return;
        const next: MentionAutocompleteItem[] = [];
        if (personas.status === "fulfilled") {
          for (const p of personas.value) next.push({ targetType: "persona", id: p.id, label: p.name, hint: p.description || undefined });
        }
        if (lorebooks.status === "fulfilled") {
          for (const l of lorebooks.value) {
            if (!l.enabled) continue; // a disabled lorebook contributes nothing when pinned
            next.push({ targetType: "lorebook", id: l.id, label: l.name, hint: l.description || undefined });
          }
        }
        if (scripts.status === "fulfilled") {
          for (const s of scripts.value) {
            if (!s.enabled) continue; // a disabled script contributes nothing when pinned
            next.push({ targetType: "script", id: s.id, label: s.name, hint: s.description || undefined });
          }
        }
        if (skills.status === "fulfilled") {
          for (const e of skills.value.entries) next.push({ targetType: "skill", id: e.id, label: e.name, hint: e.description || undefined });
        }
        setMentionCatalog(next);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // The live character list is folded in reactively (it changes as the user
  // edits/creates characters elsewhere). Fixed order: characters, personas,
  // lorebooks, scripts, skills.
  const catalog = useMemo<MentionAutocompleteItem[]>(() => {
    const characters: MentionAutocompleteItem[] = allCharacters.map((c) => ({
      targetType: "character",
      id: c.id,
      label: c.name,
      hint: c.subtitle || undefined,
    }));
    return [...characters, ...mentionCatalog];
  }, [allCharacters, mentionCatalog]);

  // Pills: resolve each link's display label from the catalog; a dangling
  // target (deleted entity) falls back to the raw id.
  const pinnedContext = useMemo<AgentContextPillItem[]>(
    () =>
      contextLinks.map((l) => ({
        targetType: l.targetType,
        targetId: l.targetId,
        label: catalog.find((c) => c.targetType === l.targetType && c.id === l.targetId)?.label ?? l.targetId,
      })),
    [contextLinks, catalog],
  );

  // Optimistic full-replace PATCH: the pills update immediately; on failure
  // they revert to the previous set and a toast surfaces (the next turn would
  // otherwise run with server-state ≠ UI).
  const handleSetContextLinks = useCallback(
    (next: ExperienceCopilotContextLink[]) => {
      if (!threadId) return;
      const prev = contextLinks;
      setContextLinks(next);
      void transport.setContextLinks(threadId, next).catch(() => {
        setContextLinks(prev);
        toast.error(t("copilot_context_pin_error"));
      });
    },
    [threadId, contextLinks, transport, t],
  );

  const handlePinContext = useCallback(
    (item: MentionAutocompleteItem) => {
      if (contextLinks.length >= 64) return; // schema max — the PATCH would 400
      if (contextLinks.some((l) => l.targetType === item.targetType && l.targetId === item.id)) return; // already pinned
      // Narrow cast: the catalog is built in this shell from the five fixed
      // target types only (see the catalog effect), so the generic
      // MentionAutocompleteItem.targetType is always a valid link type here.
      handleSetContextLinks([
        ...contextLinks,
        { targetType: item.targetType as ExperienceCopilotContextTargetType, targetId: item.id },
      ]);
    },
    [contextLinks, handleSetContextLinks],
  );

  const handleUnpinContext = useCallback(
    (targetType: string, targetId: string) => {
      handleSetContextLinks(
        contextLinks.filter((l) => !(l.targetType === targetType && l.targetId === targetId)),
      );
    },
    [contextLinks, handleSetContextLinks],
  );

  // ── Provider / model selection (persisted binding, then controlled) ───────
  // The selection lives in server-side uiSettings (copilotProviderId /
  // copilotModelName — the Co-Author binding pattern) so it survives leaving
  // the editor and reloads. A dangling id (deleted profile) is ignored → the
  // first-available default takes over (resolveCoauthorBinding semantics).
  const savedCopilotBinding = useBootstrapStore((s) => s.data?.uiSettings);
  const profiles = useProviderDataStore((s) => s.profiles);
  const [providerProfileId, setProviderProfileId] = useState<string | null>(null);
  const [model, setModel] = useState<string | undefined>(undefined);
  const { models } = useProviderModels(providerProfileId);

  // ── UI-only tab state ────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<MobileTab>("chat");

  // ── Toolbar modal open state (profile) ──────────────────────────────────
  const [profileModalOpen, setProfileModalOpen] = useState(false);

  // UX 2026-08-16 remark 6 — prefill handed to the chat input by a HOST
  // surface (the experience "send to copilot" flow) through the bridge.
  // Object identity is the trigger.
  const [inputPrefill, setInputPrefill] = useState<{ text: string } | null>(null);

  // ── AS-6b2: the shell↔host bridge ────────────────────────────────────────
  // One stable object per shell; the host's editor pane assigns `session`
  // during its render, host surfaces call `setInputPrefill`. Created lazily
  // (setInputPrefill is a stable setState fn, so the object never needs to
  // be rebuilt).
  const bridgeRef = useRef<AgentHostBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = { session: null, setInputPrefill };
  }
  const bridge = bridgeRef.current;

  // Resolve the provider ONCE per pass: the saved binding wins when it still
  // exists; a dangling/absent saved id falls back to the first available
  // profile. (One effect — a separate "default" effect would race the restore
  // in the same commit and the last setState would win, clobbering the saved
  // binding — exactly the bug this persistence fixes.)
  const savedProviderId = savedCopilotBinding?.copilotProviderId ?? null;
  useEffect(() => {
    if (providerProfileId !== null) return;
    if (savedProviderId && profiles.some((p) => p.id === savedProviderId)) {
      setProviderProfileId(savedProviderId);
      return;
    }
    const first = profiles[0];
    if (first) setProviderProfileId(first.id);
  }, [profiles, providerProfileId, savedProviderId]);

  // Same one-shot resolution for the model: the saved model when it is still
  // offered by the (restored) profile, else the first available model. A
  // dangling model id (deleted/renamed upstream) falls through to the default.
  const savedModelName = savedCopilotBinding?.copilotModelName ?? null;
  useEffect(() => {
    if (model !== undefined) return;
    if (savedModelName && models.some((m) => m.id === savedModelName)) {
      setModel(savedModelName);
      return;
    }
    const first = models[0];
    if (first) setModel(first.id);
  }, [models, model, savedModelName]);

  const handleProviderChange = useCallback((profileId: string, nextModel?: string) => {
    setProviderProfileId(profileId);
    setModel(nextModel);
    // Persist the explicit selection (fire-and-forget; a failure only means the
    // next entry defaults again — surfaced via toast for transparency).
    void patchUiSettingsAction({
      ...(profileId ? { copilotProviderId: profileId } : { copilotProviderId: null }),
      ...(nextModel ? { copilotModelName: nextModel } : { copilotModelName: null }),
    }).catch(() => {
      toast.error(t("agent_binding_save_error"));
    });
  }, [t]);

  // ── Session load (mount + retry) ─────────────────────────────────────────
  const loadSession = useCallback(async () => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      const active = await transport.getActiveThread(ownerRef.current);
      if (active) {
        setThreadId(active.id);
        setContextLinks(active.contextLinks ?? []); // CX-6: seed the pinned pills
        setThreadTodo(active.todo); // TAG-8 (restored PM-7): seed the checklist panel
        const msgs = await transport.listMessages(active.id);
        setMessages(msgs);
      } else {
        const thread = await transport.startSession(ownerRef.current);
        setThreadId(thread.id);
        setContextLinks(thread.contextLinks ?? []); // CX-6: a fresh thread has no pins
        setThreadTodo(thread.todo); // TAG-8 (restored PM-7): a fresh thread has no checklist
        setMessages([]);
      }
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t("agent_load_session_error"));
    } finally {
      setSessionLoading(false);
    }
  }, [ownerKey, transport]);

  // Session list (active + archived) for the switcher. Fetched in parallel with
  // `loadSession` on mount, then refetched after every switch/new so the active
  // indicator and archived set stay current.
  const fetchSessions = useCallback(async () => {
    try {
      const list = await transport.listSessions(ownerRef.current);
      setSessions(list);
    } catch {
      // Best-effort session-list fetch — a transient list failure leaves the
      // switcher with its last-known sessions rather than surfacing an error.
    }
  }, [ownerKey, transport]);

  // (The experience host's draft rehydration — rehydrateExperienceCopilotDrafts
  // — runs in the HOST pane's mount effect: child effects run before this one,
  // so the stores are seeded before loadSession's threadId lands, exactly as
  // the pre-split shell's single ordered effect guaranteed.)
  useEffect(() => {
    void loadSession();
    void fetchSessions();
  }, [loadSession, fetchSessions]);

  // ── Stream controller ────────────────────────────────────────────────────
  // Refetch persisted messages after each turn settles: the live `pendingText`
  // is cleared and the persisted assistant message takes over.
  const handleTurnSettled = useCallback(() => {
    if (!threadId) return;
    transport.listMessages(threadId)
      .then(setMessages)
      .catch(() => {
        // Best-effort refetch — swallow so a transient list failure leaves the
        // last-known messages on screen rather than surfacing a spurious error.
      });
  }, [threadId, transport]);

  // CM-8: context meter state per thread (metrics / auto-compact / compact).
  // `onCompacted` refetches messages so the newly appended digest message
  // renders as a card at its anchor boundary.
  const copilotContext = useCopilotContext({
    threadId,
    onCompacted: handleTurnSettled,
    compactProvider: {
      ...(providerProfileId ? { providerProfileId } : {}),
      ...(model ? { model } : {}),
    },
  });

  const ctrl = useAgentController({
    kind,
    transport,
    threadId,
    providerProfileId,
    model,
    onTurnSettled: handleTurnSettled,
    onMetrics: copilotContext.applyMetrics,
    applyPlanToolResult: agentPlan.applyToolResult, // PM-6: `plan` tool results → the plan cache
    threadTodo, // TAG-7 (restored PM-7): seeds the session-scoped todo panel state (mount/switch)
  });

  // ── AS-6b2: the dispatch seam (host's dangling-review capture + options) ─
  // Reads the bridge AT CALL TIME (the host pane assigned the latest-render
  // handle); the descriptor's buildSendOptions forwards to that session.
  // AS-6c-ii: the options type lives in the host registry, so the descriptor
  // returns it directly — no narrowing cast (lib importing components is
  // banned, which is what forced the old `as AgentSendOptions`).
  const hostCtx: AgentHostContext = {
    owner,
    scriptId,
    threadId,
    isSending: ctrl.isSending,
    hostProps,
    bridge,
  };
  const sendWithOptions = (dispatch: (opts?: AgentSendOptions) => void) => {
    bridge.session?.onBeforeSend();
    dispatch(host.buildSendOptions(hostCtx));
  };

  // ── Session switch / new (ER-12b) ────────────────────────────────────────
  // Both are NO-OP while a turn is streaming (the switcher is also visually
  // disabled via `disabled={ctrl.isSending}`): switching `threadId` mid-stream
  // would race the in-flight stream's settle-closure. On failure, `threadId` /
  // `messages` are left UNCHANGED (no half-switch) and an error toast surfaces.
  const handleActivate = useCallback(
    async (targetThreadId: string) => {
      if (ctrl.isSending) return;
      try {
        const activated = await transport.activateSession(targetThreadId);
        if (!activated) {
          toast.error(t("agent_switch_error"));
          return;
        }
        setThreadId(targetThreadId);
        setContextLinks(activated.contextLinks ?? []); // CX-6: switch → that thread's pins
        setThreadTodo(activated.todo); // TAG-8 (restored PM-7): switch → that thread's checklist
        const msgs = await transport.listMessages(targetThreadId);
        setMessages(msgs);
        await fetchSessions();
      } catch {
        // Best-effort — leave threadId/messages unchanged and surface the error.
        toast.error(t("agent_switch_error"));
      }
    },
    [ctrl.isSending, fetchSessions, transport, t],
  );

  const handleNewSession = useCallback(async () => {
    if (ctrl.isSending) return;
    try {
      const thread = await transport.startSession(ownerRef.current);
      setThreadId(thread.id);
      setContextLinks(thread.contextLinks ?? []); // CX-6: new session → no pins
      setThreadTodo(thread.todo); // TAG-8 (restored PM-7): new session → no checklist
      setMessages([]);
      await fetchSessions();
    } catch {
      // Best-effort — leave threadId/messages unchanged and surface the error.
      toast.error(t("agent_new_session_error"));
    }
  }, [ctrl.isSending, ownerKey, transport, fetchSessions, t]);

  // ── Session rename (2026-08-17) ──────────────────────────────────────────
  // Fire-and-refresh: the switcher exits rename mode immediately and the shell
  // re-fetches the session list so the new title lands. Unlike switch/new,
  // renaming is SAFE mid-stream (it touches only the title), so there is no
  // isSending guard here. On failure, refresh anyway so the label reverts.
  const handleRenameSession = useCallback(
    async (targetThreadId: string, title: string) => {
      try {
        await transport.renameSession(targetThreadId, title);
      } catch {
        toast.error(t("agent_rename_error"));
      } finally {
        await fetchSessions();
      }
    },
    [fetchSessions, transport, t],
  );

  // ── Mobile auto-switch on proposal ───────────────────────────────────────
  // A proposal becomes reviewable in the Chat pane (activity cards + Apply),
  // so when one lands on mobile the surface jumps there. Ref-guarded edge
  // mirroring CoauthorMode's `useCoauthorMobileTab`.
  const hasProposal = useAgentTurnStore((s) => {
    if (!threadId) return false;
    const activities = s.turnsByThread[agentThreadKey(kind, threadId)] ?? [];
    return activities.some(
      (a) => a.status === "done" && a.target !== undefined && a.proposed !== undefined,
    );
  });
  const prevHasProposal = useRef(hasProposal);
  useEffect(() => {
    const was = prevHasProposal.current;
    prevHasProposal.current = hasProposal;
    if (!was && hasProposal && isMobile) {
      setActiveTab("chat");
    }
  }, [hasProposal, isMobile]);

  // ── E6: Edit-tab dirty badge + one-shot pulse ───────────────────────
  // Ref-guarded clean→dirty edge (proposal edge above, CA-14): the dot shows
  // while dirty and on Chat; the pulse plays once per edge. NO auto-switch —
  // a user-chosen Apply doesn't yank them off the chat tab.
  const [editTabPulse, setEditTabPulse] = useState(false);
  const prevEditTabDirty = useRef(editTabDirty);
  useEffect(() => {
    const was = prevEditTabDirty.current;
    prevEditTabDirty.current = editTabDirty;
    if (!was && editTabDirty) setEditTabPulse(true);
  }, [editTabDirty]);
  // Clear the highlight once the pulse animation has played
  // (coauthor-tab-pulse ≈ 2 × 1.1s, same as DOC_PULSE_MS in CoauthorMode).
  useEffect(() => {
    if (!editTabPulse) return;
    const id = setTimeout(() => setEditTabPulse(false), EDIT_TAB_PULSE_MS);
    return () => clearTimeout(id);
  }, [editTabPulse]);

  // ── Pane content (shared between desktop/mobile, mounted by branch) ──────
  const chatPane = (
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
          {/* PM-6: the script-owned agent plan sits DIRECTLY below the todo
              section; hidden while the plan is empty; its editor locks while a
              turn streams. PM-7: todo (the thread's session) ABOVE plan (the
              script's durable document) — each hides itself when empty. */}
          <AgentPlanSection owner={planOwner} locked={ctrl.isSending} />
          <AgentMessageList
            kind={kind}
            threadId={threadId}
            messages={messages}
            pendingText={ctrl.pendingText}
            pendingReasoning={ctrl.pendingReasoning}
            pendingUserContent={ctrl.pendingUserContent}
            isSending={ctrl.isSending}
            pendingAskAnswer={ctrl.pendingAskAnswer}
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

  // The host's editor pane (absent descriptor = chat-only host: no pane, no
  // mobile tab row — see the layout branches below). Captured in a local so
  // the `!== undefined` guard narrows the CALL below (TS cannot narrow through
  // the intermediate `hasEditorPane` boolean).
  const renderEditorPane = host.renderEditorPane;
  const hasEditorPane = renderEditorPane !== undefined;
  const editorPane = hasEditorPane ? renderEditorPane(hostCtx) : null;

  // ── Toolbar modals (profile only) ────────────────────────────────────────
  // XU-5/XU-6: the preview moved OUT of a modal into the editor's default tab
  // (the inline `ExperienceFrame`), the sandbox became the inline Try tab in
  // BOTH modes (quote 10), and the rules tester was absorbed into the
  // sandbox's diagnostics (XU-4) — so no sandbox modal remains.
  const modals = (
    <>
      <AgentProfileModal
        scriptId={scriptId}
        agentKind={kind}
        assignedProfileId={assignedProfileId}
        isOpen={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
      />
    </>
  );

  if (isMobile) {
    /* 4a mobile fix: every flex item down this chain carries min-w-0 —
       without it a content-driven min-content width inside the chat pane
       (e.g. a wide tool-result card) inflates the whole column and pushes
       the Chat/Edit tablist off-screen (844px blow-out). The desktop branch
       below already pins widths (w-[440px] / min-w-0). */
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {hasEditorPane ? (
          <>
            {/* E6: back chevron folded into the tab-bar row (zero added height);
                the tablist proper keeps its role — the chevron is a plain row
                sibling, not a tab. Rendered only when the host provides a
                label key (the shell owns no back wording of its own). */}
            <div className="flex min-w-0 shrink-0 items-stretch border-b border-border bg-surface">
              {onBack && host.i18n.mobileBackLabelKey !== undefined && (
                <button
                  type="button"
                  aria-label={t(host.i18n.mobileBackLabelKey)}
                  data-testid="copilot-mobile-back"
                  onClick={onBack}
                  className="flex w-11 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-colors hover:bg-s2 hover:text-t1"
                >
                  <Icons.Caret direction="l" />
                </button>
              )}
              <div
                className="flex min-w-0 flex-1"
                role="tablist"
                aria-label={t("agent_editor_aria")}
              >
                <AgentShellTabButton label={t("agent_tab_chat")} active={activeTab === "chat"} onClick={() => setActiveTab("chat")} />
                <AgentShellTabButton
                  label={t("agent_tab_edit")}
                  active={activeTab === "edit"}
                  onClick={() => setActiveTab("edit")}
                  badge={editTabDirty && activeTab !== "edit"}
                  pulse={editTabPulse}
                />
              </div>
            </div>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", activeTab !== "chat" && "hidden")} data-testid="copilot-pane-chat">
                {chatPane}
              </div>
              <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", activeTab !== "edit" && "hidden")} data-testid="copilot-pane-edit">
                {/* E6: the management cluster that moved out of the desktop-only
                    top bar renders at the top of the mobile Edit tab. */}
                {editTabHeader && (
                  <div className="flex shrink-0 flex-col border-b border-border bg-surface" data-testid="copilot-edit-tab-header">
                    {editTabHeader}
                  </div>
                )}
                {editorPane}
              </div>
            </div>
          </>
        ) : (
          /* Chat-only host (no editor pane): the chat pane takes the full
             width and the mobile tab row is not rendered at all — there is
             nothing to switch to, and the back chevron is folded into the
             tab-bar row that no longer exists (a host needing mobile back
             navigation supplies its own header control). */
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="copilot-pane-chat">
            {chatPane}
          </div>
        )}
        {modals}
      </div>
    );
  }

  if (!hasEditorPane) {
    return (
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{chatPane}</div>
        {modals}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 w-[440px] shrink-0 flex-col border-r border-border">{chatPane}</div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{editorPane}</div>
      {modals}
    </div>
  );
}
