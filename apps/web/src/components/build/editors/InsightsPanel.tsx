import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { ChatId } from "@vibe-tavern/domain";
import { Ic } from "../../shared/icons.js";
import { Toggle } from "../../shared/Toggle.js";
import { EmptyState } from "../../shared/empty-state.js";
import { ObjectiveConfig } from "./ObjectiveConfig.js";
import { useT } from "../../../i18n/context.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { updateInsightsConfigAction } from "../../../stores/api-actions/chat-actions.js";

/**
 * Insights build panel (INSIGHTS_PLAN INS-2). Two opt-in feature toggles —
 * Objective Tracker and Scene Tracker — persisted per-chat through the INS-1b
 * config pipe (`PATCH /api/chats/:chatId/insights-config`). Both are OFF by
 * default; when both are off, NO prompt layer is injected and the assistant
 * message header renders exactly as today (zero added DOM — wired in INS-6 /
 * INS-11), so turning both off is a perfect no-op.
 *
 * INS-2 ships ONLY the toggles. The per-feature config editors (generate tasks,
 * edit the scene schema, custom prompts, model pick) are layered in by INS-5
 * (Objective) and INS-10 (Tracker); this panel is the stable home for them,
 * gated on `objectiveEnabled` / `trackerEnabled`.
 *
 * The panel reads the live chat config from the snapshot store and writes each
 * toggle through the action, which round-trips the whole snapshot back
 * (optimistic via the store + confirmed by the server response). A `saving`
 * guard disables both toggles during the in-flight PATCH so a rapid double-flip
 * can't desync the merge (the adapter merges partial config — see INS-1b).
 */
export function InsightsPanel() {
  const { t } = useT();
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const [saving, setSaving] = useState<"objective" | "tracker" | null>(null);

  if (!activeChat) {
    // Build Mode can be opened standalone (character editor, no active chat).
    // Insights are chat-level config, so there is nothing to configure until a
    // chat is open — surface that explicitly rather than rendering dead toggles.
    return (
      <div className="mx-auto max-w-2xl p-1">
        <EmptyState
          icon={<Ic.target />}
          title={t("insights_no_chat_title")}
          sub={t("insights_no_chat_sub")}
        />
      </div>
    );
  }

  // After the guard `activeChat` is non-null. Capture its id as a definite
  // `ChatId` so the `persist` closure (defined below) sees a non-null id — TS
  // does not carry the early-return narrowing into nested function closures,
  // so reading `activeChat.id` into a `const` here is what gives the closure a
  // sound `ChatId` rather than `ChatId | null`.
  const chatId: ChatId = activeChat.id;
  const objectiveEnabled = activeChat.insightsConfig?.objectiveEnabled ?? false;
  const trackerEnabled = activeChat.insightsConfig?.trackerEnabled ?? false;

  async function persist(patch: { objectiveEnabled?: boolean; trackerEnabled?: boolean }, which: "objective" | "tracker") {
    setSaving(which);
    try {
      await updateInsightsConfigAction(chatId, { insightsConfig: patch });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("insights_save_failed"));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-1">
      <FeatureToggleRow
        icon={<Ic.checkCircle />}
        title={t("insights_objective_title")}
        desc={t("insights_objective_desc")}
        checked={objectiveEnabled}
        disabled={saving !== null}
        onChange={(v) => void persist({ objectiveEnabled: v }, "objective")}
      />
      {objectiveEnabled && <ObjectiveConfig chatId={chatId} />}
      <FeatureToggleRow
        icon={<Ic.clipboard />}
        title={t("insights_tracker_title")}
        desc={t("insights_tracker_desc")}
        checked={trackerEnabled}
        disabled={saving !== null}
        onChange={(v) => void persist({ trackerEnabled: v }, "tracker")}
      />
      {!objectiveEnabled && !trackerEnabled && (
        <p className="px-1 pt-1 font-ui text-[11px] leading-relaxed text-t4">
          {t("insights_coming_soon_hint")}
        </p>
      )}
    </div>
  );
}

/**
 * A single feature toggle row: icon badge + title/description on the left, the
 * Toggle on the right. The whole row is clickable (larger hit target) EXCEPT
 * the Toggle itself, whose click is isolated via stopPropagation so flipping it
 * doesn't double-fire (row onClick + Toggle onChange would toggle back).
 */
function FeatureToggleRow({ icon, title, desc, checked, disabled, onChange }: {
  icon: ReactNode;
  title: string;
  desc: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border border-border bg-s2 p-4 transition-colors hover:border-border2 ${disabled ? "cursor-default opacity-60" : "cursor-pointer"}`}
      onClick={disabled ? undefined : () => onChange(!checked)}
    >
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-dim text-accent">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-ui text-[13px] font-semibold text-t1">{title}</div>
        <div className="mt-0.5 font-ui text-[12px] leading-relaxed text-t3">{desc}</div>
      </div>
      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
        <Toggle checked={checked} onChange={onChange} disabled={disabled} />
      </div>
    </div>
  );
}
