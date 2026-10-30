import { useEffect, useRef, useState } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import { toast } from "sonner";
import { getManualSummaryRun, stopManualSummaryRun } from "../../api/chat-api.js";
import type { ChatSummaryRecord } from "../../api/types.js";
import { RpcError } from "../../api/unwrap.js";
import { useT } from "../../i18n/context.js";
import { subscribeChatSummaryEvents } from "../../lib/chat-summary-events.js";
import { generateChatSummaryAction, listChatSummariesAction } from "../../stores/api-actions/chat-actions.js";

interface SummaryRunView {
  chatId: ChatId;
  scope: string;
  listRevision: number;
  runRevision: number;
  generation?: symbol;
  lastCompletion?: string;
}

/** Server-owned manual generation; closing/changing the view only detaches it.
 * Archive reads and run reads have separate revisions: a late mount read cannot
 * undo an SSE completion, a local start, or a newer list selection. */
export function useSummaryRun({ isOpen, chatId, branchId, onLoaded, onGenerated }: {
  isOpen: boolean;
  chatId: ChatId | null;
  branchId: string | null;
  onLoaded: (rows: ChatSummaryRecord[], preferredId?: string) => void;
  onGenerated: (summary: ChatSummaryRecord) => void;
}) {
  const { t } = useT();
  const latest = useRef({ onLoaded, onGenerated, t });
  latest.current = { onLoaded, onGenerated, t };
  const view = useRef<SummaryRunView | null>(null);
  const scope = `${chatId ?? ""}|${branchId ?? ""}`;
  const [state, setState] = useState({ scope, generating: false, loading: false, checking: false });
  const current = (target: SummaryRunView) => view.current === target;
  const report = (error: unknown, fallback: "summary_save_failed" | "summarization_failed") =>
    toast.error(error instanceof Error ? error.message : latest.current.t(fallback));

  function patch(target: SummaryRunView, values: Partial<Omit<typeof state, "scope">>) {
    if (current(target)) setState((previous) => ({ ...previous, scope: target.scope, ...values }));
  }

  async function loadSummaries(target: SummaryRunView, preferredId?: string) {
    const revision = ++target.listRevision;
    patch(target, { loading: true });
    try {
      const rows = await listChatSummariesAction(target.chatId);
      if (current(target) && target.listRevision === revision) latest.current.onLoaded(rows, preferredId);
    } catch (error) {
      if (current(target) && target.listRevision === revision) report(error, "summary_save_failed");
    } finally {
      if (target.listRevision === revision) patch(target, { loading: false });
    }
  }

  async function recover(target: SummaryRunView) {
    const revision = ++target.runRevision;
    try {
      const running = await getManualSummaryRun(target.chatId);
      if (target.runRevision === revision) patch(target, { generating: running !== null });
    } catch (error) {
      if (current(target) && target.runRevision === revision) report(error, "summarization_failed");
    } finally {
      if (target.runRevision === revision) patch(target, { checking: false });
    }
  }

  useEffect(() => {
    if (!isOpen || !chatId) return;
    const target: SummaryRunView = { chatId, scope, listRevision: 0, runRevision: 0 };
    view.current = target;
    setState({ scope, generating: false, loading: true, checking: true });
    const unsubscribe = subscribeChatSummaryEvents((event) => {
      if (event.chatId !== chatId || !current(target)) return;
      if ("source" in event && event.source === "manual") {
        ++target.runRevision;
        patch(target, { generating: event.kind === "summary.started", checking: false });
      }
      if (event.kind === "summary.generated") {
        target.lastCompletion = event.summaryId;
        void loadSummaries(target, event.summaryId);
      }
    });
    void loadSummaries(target);
    void recover(target);
    return () => {
      unsubscribe();
      if (current(target)) view.current = null;
    };
  }, [isOpen, chatId, scope]);

  async function generate(input: Parameters<typeof generateChatSummaryAction>[1]) {
    const target = view.current;
    if (!target || target.scope !== scope || !isOpen) return;
    const generation = Symbol();
    target.generation = generation;
    target.lastCompletion = undefined;
    ++target.runRevision;
    patch(target, { generating: true, checking: false });
    try {
      // No request AbortController: only the explicit stop endpoint owns cancellation.
      const summary = await generateChatSummaryAction(target.chatId, input);
      if (current(target) && target.generation === generation && (!target.lastCompletion || target.lastCompletion === summary.id)) {
        ++target.listRevision;
        patch(target, { loading: false });
        latest.current.onGenerated(summary);
      }
    } catch (error) {
      if (!current(target) || target.generation !== generation) return;
      if (error instanceof RpcError && error.status === 409) return;
      if (!(error instanceof RpcError && error.status === 499)) report(error, "summarization_failed");
    } finally {
      if (current(target) && target.generation === generation) {
        // Reconcile even a disconnected/409 POST: its server job may still be running.
        await recover(target);
      }
    }
  }

  async function stop() {
    const target = view.current;
    if (!target || target.scope !== scope || !isOpen) return;
    try {
      const { stopped } = await stopManualSummaryRun(target.chatId);
      // Cooperative cancellation is not complete until its lifecycle event.
      if (!stopped && current(target)) await recover(target);
    } catch (error) {
      if (current(target)) report(error, "summarization_failed");
    }
  }

  const visible = isOpen && state.scope === scope;
  return {
    loading: visible && state.loading,
    generating: visible && state.generating,
    checking: visible && state.checking,
    generate,
    stop,
  };
}
