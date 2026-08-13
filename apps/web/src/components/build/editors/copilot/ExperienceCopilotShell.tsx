import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { ExperienceCopilotMessageWire, ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import { cn } from "../../../../lib/cn.js";
import { Icons } from "../../../shared/icons.js";
import { EmptyState } from "../../../shared/empty-state.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { Modal } from "../../../shared/Modal.js";
import { CodeEditor } from "../../../shared/CodeEditor.js";
import { InteractiveTester } from "../InteractiveTester.js";
import { ExperiencePlayground } from "../ExperiencePlayground.js";
import { ExperienceFrame } from "../../../experience/ExperienceFrame.js";
import { useIsMobile } from "../../../../hooks/use-mobile.js";
import { useT } from "../../../../i18n/context.js";
import { useExperienceCopilotController } from "../../../../hooks/use-experience-copilot-controller.js";
import { useProviderDataStore } from "../../../../stores/provider-data-store.js";
import { useToolCapableModels } from "../../../coauthor/useToolCapableModels.js";
import { useExperienceCopilotTurnStore } from "../../../../stores/experience-copilot-turn-store.js";
import { rehydrateExperienceCopilotDrafts } from "../../../../lib/experience-copilot-draft.js";
import type { ExperienceCopilotApplyPatch } from "../../../../lib/experience-copilot-apply.js";
import {
  getExperienceCopilotActive,
  listExperienceCopilotMessages,
  startExperienceCopilotSession,
  listExperienceCopilotSessions,
  activateExperienceCopilotSession,
} from "../../../../api/experience-copilot-api.js";
import { ExperienceSessionSwitcher } from "./ExperienceSessionSwitcher.js";
import { ExperienceCopilotMessageList } from "./ExperienceCopilotMessageList.js";
import { ExperienceCopilotInputArea } from "./ExperienceCopilotInputArea.js";
import { ExperienceCopilotMobileInputArea } from "./ExperienceCopilotMobileInputArea.js";

/**
 * ExperienceCopilotShell (ER-11d / ER-13b′) — the visible 2-pane copilot
 * editor surface: chat-left (propose rules/visual edits → review activity
 * cards → Apply) and editor-right (manually edit the two canonical buffers via
 * CodeEditor). The tester / preview / sandbox surfaces are NO LONGER a bottom
 * panel (ER-13b): they are top-of-editor toolbar buttons that open modals
 * (Tester → InteractiveTester, Preview → ExperienceFrame, Sandbox →
 * ExperiencePlayground). On mobile it collapses to a 2-tab `[Chat][Edit]` bar.
 *
 * CONTROLLED. This component owns NO canonical buffer text — `rulesCode` /
 * `visualSource` are props from the parent (ER-13 wires this into
 * `ExperienceEditor`), and every edit routes back through `onRulesChange` /
 * `onVisualChange`. The only buffers the shell holds are session state
 * (threadId / messages / loading / error), the provider/model selection, the
 * UI-only tab selection, and the toolbar modal open flags.
 *
 * Responsive pattern mirrors `CoauthorMode`: both panes stay MOUNTED across
 * mobile tab switches (only `hidden` toggles) so the CodeMirror editor and the
 * chat scroll positions survive. The editor pane reuses the same components on
 * desktop and mobile; only the chat InputArea forks (desktop →
 * `ExperienceCopilotInputArea`, mobile → `ExperienceCopilotMobileInputArea`),
 * chosen via the shared `useIsMobile` hook.
 */

export interface ExperienceCopilotShellProps {
  scriptId: string;
  /** Canonical rules buffer (the active script's code). Controlled. */
  rulesCode: string;
  onRulesChange: (code: string) => void;
  /** Canonical visual buffer (the active visual's source). Controlled. */
  visualSource: string;
  onVisualChange: (source: string) => void;
  /** Copilot Apply: parent writes the proposed buffers to the draft stores. */
  onApply: (patch: ExperienceCopilotApplyPatch) => void;
}

type MobileTab = "chat" | "edit";
type EditorBuffer = "rules" | "visual";

const BUFFER_OPTIONS = [
  { value: "rules", label: "Rules" },
  { value: "visual", label: "Visual" },
];

export function ExperienceCopilotShell({
  scriptId,
  rulesCode,
  onRulesChange,
  visualSource,
  onVisualChange,
  onApply,
}: ExperienceCopilotShellProps) {
  const isMobile = useIsMobile();
  const { t } = useT();

  // ── Session lifecycle state ──────────────────────────────────────────────
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ExperienceCopilotMessageWire[]>([]);
  const [sessions, setSessions] = useState<ExperienceCopilotThreadWire[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // ── Provider / model selection (defaulted, then controlled) ──────────────
  const profiles = useProviderDataStore((s) => s.profiles);
  const [providerProfileId, setProviderProfileId] = useState<string | null>(null);
  const [model, setModel] = useState<string | undefined>(undefined);
  const { models } = useToolCapableModels(providerProfileId);

  // ── UI-only tab state ────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<MobileTab>("chat");
  const [editorBuffer, setEditorBuffer] = useState<EditorBuffer>("rules");

  // ── Toolbar modal open state (tester / preview / sandbox) ────────────────
  const [testerOpen, setTesterOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sandboxOpen, setSandboxOpen] = useState(false);

  // Default the provider to the first available profile once known.
  useEffect(() => {
    if (providerProfileId !== null) return;
    const first = profiles[0];
    if (!first) return;
    setProviderProfileId(first.id);
  }, [profiles, providerProfileId]);

  // Default the model to the first tool-capable model once known.
  useEffect(() => {
    if (model !== undefined) return;
    const first = models[0];
    if (!first) return;
    setModel(first.id);
  }, [models, model]);

  const handleProviderChange = useCallback((profileId: string, nextModel?: string) => {
    setProviderProfileId(profileId);
    setModel(nextModel);
  }, []);

  // ── Session load (mount + retry) ─────────────────────────────────────────
  const loadSession = useCallback(async () => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      const active = await getExperienceCopilotActive(scriptId);
      if (active) {
        setThreadId(active.id);
        const msgs = await listExperienceCopilotMessages(active.id);
        setMessages(msgs);
      } else {
        const thread = await startExperienceCopilotSession(scriptId);
        setThreadId(thread.id);
        setMessages([]);
      }
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Failed to load copilot session");
    } finally {
      setSessionLoading(false);
    }
  }, [scriptId]);

  // Session list (active + archived) for the switcher. Fetched in parallel with
  // `loadSession` on mount, then refetched after every switch/new so the active
  // indicator and archived set stay current.
  const fetchSessions = useCallback(async () => {
    try {
      const list = await listExperienceCopilotSessions(scriptId);
      setSessions(list);
    } catch {
      // Best-effort session-list fetch — a transient list failure leaves the
      // switcher with its last-known sessions rather than surfacing an error.
    }
  }, [scriptId]);

  useEffect(() => {
    rehydrateExperienceCopilotDrafts();
    void loadSession();
    void fetchSessions();
  }, [loadSession, fetchSessions]);

  // ── Stream controller ────────────────────────────────────────────────────
  // Refetch persisted messages after each turn settles: the live `pendingText`
  // is cleared and the persisted assistant message takes over.
  const handleTurnSettled = useCallback(() => {
    if (!threadId) return;
    listExperienceCopilotMessages(threadId)
      .then(setMessages)
      .catch(() => {
        // Best-effort refetch — swallow so a transient list failure leaves the
        // last-known messages on screen rather than surfacing a spurious error.
      });
  }, [threadId]);

  const ctrl = useExperienceCopilotController({
    threadId,
    providerProfileId,
    model,
    onTurnSettled: handleTurnSettled,
  });

  // ── Session switch / new (ER-12b) ────────────────────────────────────────
  // Both are NO-OP while a turn is streaming (the switcher is also visually
  // disabled via `disabled={ctrl.isSending}`): switching `threadId` mid-stream
  // would race the in-flight stream's settle-closure. On failure, `threadId` /
  // `messages` are left UNCHANGED (no half-switch) and an error toast surfaces.
  const handleActivate = useCallback(
    async (targetThreadId: string) => {
      if (ctrl.isSending) return;
      try {
        const activated = await activateExperienceCopilotSession(targetThreadId);
        if (!activated) {
          toast.error(t("experience_copilot_switch_error"));
          return;
        }
        setThreadId(targetThreadId);
        const msgs = await listExperienceCopilotMessages(targetThreadId);
        setMessages(msgs);
        await fetchSessions();
      } catch {
        // Best-effort — leave threadId/messages unchanged and surface the error.
        toast.error(t("experience_copilot_switch_error"));
      }
    },
    [ctrl.isSending, fetchSessions, t],
  );

  const handleNewSession = useCallback(async () => {
    if (ctrl.isSending) return;
    try {
      const thread = await startExperienceCopilotSession(scriptId);
      setThreadId(thread.id);
      setMessages([]);
      await fetchSessions();
    } catch {
      // Best-effort — leave threadId/messages unchanged and surface the error.
      toast.error(t("experience_copilot_new_session_error"));
    }
  }, [ctrl.isSending, scriptId, fetchSessions, t]);

  // ── Mobile auto-switch on proposal ───────────────────────────────────────
  // A proposal becomes reviewable in the Chat pane (activity cards + Apply), so
  // when one lands on mobile the surface jumps there. Ref-guarded edge mirroring
  // CoauthorMode's `useCoauthorMobileTab`, without the pulse polish.
  const hasProposal = useExperienceCopilotTurnStore((s) => {
    if (!threadId) return false;
    const activities = s.turnsByThread[threadId] ?? [];
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

  // ── Pane content (shared between desktop/mobile, mounted by branch) ──────
  const chatPane = (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {sessionLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Icons.Sparkles className="h-6 w-6 animate-pulse text-t3" />}
            title="Loading copilot…"
          />
        </div>
      ) : sessionError ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Icons.Close className="h-6 w-6 text-danger-text" />}
            title="Couldn't load the copilot"
            sub={sessionError}
            cta={<span>Retry</span>}
            onCta={() => void loadSession()}
          />
        </div>
      ) : threadId ? (
        <>
          <div className="flex shrink-0 items-center border-b border-border bg-surface px-2 py-1.5">
            <ExperienceSessionSwitcher
              sessions={sessions}
              activeThreadId={threadId}
              disabled={ctrl.isSending}
              onActivate={handleActivate}
              onNew={handleNewSession}
            />
          </div>
          <ExperienceCopilotMessageList
            threadId={threadId}
            messages={messages}
            pendingText={ctrl.pendingText}
            baseRules={rulesCode}
            baseVisual={visualSource}
            onApply={onApply}
          />
          {isMobile ? (
            <ExperienceCopilotMobileInputArea
              isSending={ctrl.isSending}
              onSend={(content) => void ctrl.handleSend(content)}
              onCancel={ctrl.handleCancel}
              providerProfileId={providerProfileId}
              model={model}
              onProviderChange={handleProviderChange}
            />
          ) : (
            <ExperienceCopilotInputArea
              isSending={ctrl.isSending}
              onSend={(content) => void ctrl.handleSend(content)}
              onCancel={ctrl.handleCancel}
              providerProfileId={providerProfileId}
              model={model}
              onProviderChange={handleProviderChange}
            />
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Icons.Sparkles className="h-6 w-6 text-t3" />}
            title="Copilot"
            sub="Ask the copilot to propose rules or visual edits."
          />
        </div>
      )}
    </div>
  );

  const editorPane = (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
        <SegmentedControl
          value={editorBuffer}
          options={BUFFER_OPTIONS}
          onChange={(value) => setEditorBuffer(value === "visual" ? "visual" : "rules")}
          compact
        />
        <div className="flex items-center gap-1.5">
          <ToolbarButton
            label={t("experience_copilot_tester")}
            icon={<Icons.Terminal />}
            onClick={() => setTesterOpen(true)}
            testId="copilot-toolbar-tester"
          />
          <ToolbarButton
            label={t("experience_copilot_preview")}
            icon={<Icons.Eye />}
            onClick={() => setPreviewOpen(true)}
            testId="copilot-toolbar-preview"
          />
          <ToolbarButton
            label={t("experience_copilot_sandbox")}
            icon={<Icons.Dice />}
            onClick={() => setSandboxOpen(true)}
            testId="copilot-toolbar-sandbox"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="relative rounded-md border border-border bg-bg">
          <CodeEditor
            value={editorBuffer === "rules" ? rulesCode : visualSource}
            onChange={editorBuffer === "rules" ? onRulesChange : onVisualChange}
            minHeight="300px"
            scrollMode="inner"
          />
        </div>
      </div>
    </div>
  );

  // ── Toolbar modals (tester / preview / sandbox) ──────────────────────────
  // The tester/preview/sandbox surfaces moved OUT of a bottom panel (ER-13b)
  // into top-of-editor toolbar buttons that open these modals. Exactly one
  // ExperiencePlayground is mounted here (the sandbox modal) — the IR-90A
  // single-instance invariant holds. Exactly one ExperienceFrame is mounted
  // (the preview modal); the sandbox's own frame is nested inside
  // ExperiencePlayground, not rendered directly by this shell.
  const modals = (
    <>
      <ShellModal
        open={testerOpen}
        onClose={() => setTesterOpen(false)}
        title={t("experience_copilot_tester_title")}
        testId="copilot-tester-modal"
      >
        <InteractiveTester code={rulesCode} />
      </ShellModal>

      <ShellModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t("experience_copilot_preview_title")}
        testId="copilot-preview-modal"
      >
        {visualSource.trim() !== "" ? (
          // Disconnected visual render: no session, no state push — just the
          // visual's own HTML/CSS/JS as authored. Actions/errors are no-ops.
          <ExperienceFrame
            visualSource={visualSource}
            sessionId="preview"
            initialRevision={0}
            onAction={() => {}}
            onError={() => {}}
          />
        ) : (
          <EmptyState
            icon={<Icons.Eye />}
            title={t("experience_playground_no_visual")}
          />
        )}
      </ShellModal>

      <ShellModal
        open={sandboxOpen}
        onClose={() => setSandboxOpen(false)}
        title={t("experience_copilot_sandbox_title")}
        testId="copilot-sandbox-modal"
      >
        <ExperiencePlayground code={rulesCode} visualSource={visualSource || null} />
      </ShellModal>
    </>
  );

  if (isMobile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="flex shrink-0 border-b border-border bg-surface"
          role="tablist"
          aria-label="Copilot editor"
        >
          <TabButton label="Chat" active={activeTab === "chat"} onClick={() => setActiveTab("chat")} />
          <TabButton label="Edit" active={activeTab === "edit"} onClick={() => setActiveTab("edit")} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className={cn("flex min-h-0 flex-1 flex-col", activeTab !== "chat" && "hidden")} data-testid="copilot-pane-chat">
            {chatPane}
          </div>
          <div className={cn("flex min-h-0 flex-1 flex-col", activeTab !== "edit" && "hidden")} data-testid="copilot-pane-edit">
            {editorPane}
          </div>
        </div>
        {modals}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[380px] shrink-0 flex-col border-r border-border">{chatPane}</div>
      <div className="flex min-w-0 flex-1 flex-col">{editorPane}</div>
      {modals}
    </div>
  );
}

interface TabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function TabButton({ label, active, onClick }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative flex flex-1 items-center justify-center gap-1.5 py-2.5 font-ui text-[0.9rem] font-medium transition-colors",
        active ? "border-b-2 border-accent text-t1" : "border-b-2 border-transparent text-t3",
      )}
    >
      {label}
    </button>
  );
}

interface ToolbarButtonProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  testId: string;
}

function ToolbarButton({ label, icon, onClick, testId }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 py-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:bg-s2 hover:text-t1"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

interface ShellModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  testId: string;
  children: ReactNode;
}

/** Shared modal chrome for the three toolbar surfaces (tester / preview /
 *  sandbox). Reuses the app's shared {@link Modal} shell; the panel mirrors the
 *  ExperienceSetupModal header/body pattern (title + close header, scrollable
 *  body). Full-screen on mobile via the shared Modal. */
function ShellModal({ open, onClose, title, testId, children }: ShellModalProps) {
  const isMobile = useIsMobile();
  const { t } = useT();
  return (
    <Modal open={open} onClose={onClose} title={title} description={title}>
      <div
        className={cn(
          isMobile
            ? "flex h-full w-full flex-col bg-surface"
            : "flex max-h-[88vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl",
        )}
        data-testid={testId}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <h2 className="min-w-0 flex-1 truncate font-ui text-sm font-semibold text-t1">{title}</h2>
          <button
            type="button"
            className="rounded p-1 text-t4 hover:bg-s3 hover:text-t2"
            onClick={onClose}
            aria-label={t("experience_setup_close")}
          >
            <Icons.Close />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </Modal>
  );
}
