import { useState, useEffect, type ReactNode } from "react";
import { toast } from "sonner";
import {
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTEXT_MODE,
  type ChatId,
  type DiceActorType,
  type ExperienceCapability,
  type ExperienceContextMode,
} from "@vibe-tavern/domain";
import { Ic } from "../../shared/icons.js";
import { Toggle } from "../../shared/Toggle.js";
import { EmptyState } from "../../shared/empty-state.js";
import { ObjectiveConfig } from "./ObjectiveConfig.js";
import { TrackerConfig } from "./TrackerConfig.js";
import { DiceAssignment } from "./DiceAssignment.js";
import { ExperienceAssignment } from "./ExperienceAssignment.js";
import { useT } from "../../../i18n/context.js";
import { useSnapshotStore, useActiveBranch } from "../../../stores/snapshot-store.js";
import { useExperienceConfig, useExperienceStore } from "../../../stores/experience-store.js";
import { updateExperienceConfig } from "../../../api/experience-api.js";
import { updateInsightsConfigAction } from "../../../stores/api-actions/chat-actions.js";
import type { ExperienceConfigUpdateRequest } from "../../../api/types.js";

/** Insights-config patch shape (Objective/Tracker/Dice) — the original INS-2
 *  contract, unchanged. Persisted through PATCH /api/chats/:chatId/insights-config. */
type InsightsConfigPatch = {
  objectiveEnabled?: boolean;
  trackerEnabled?: boolean;
  diceEnabled?: boolean;
  diceMode?: "normal" | "immersive";
  diceScriptIds?: string[] | null;
  diceActorBindings?: Record<string, DiceActorType[]> | null;
};

/** Pending mutation lock. The `which` field discriminates the two independent
 *  write paths: the original insights-config PATCH (objective/tracker/dice) and
 *  the Experience config PATCH (a separate endpoint, NOT insightsConfig). One
 *  mutation in flight locks ALL feature rows so rapid/concurrent responses
 *  cannot overwrite each other; feature rows never dim while the network is in
 *  flight. */
type Pending =
  | { chatId: ChatId; which: "objective" | "tracker" | "dice"; patch: InsightsConfigPatch }
  | { chatId: ChatId; branchId: string; which: "experience"; patch: ExperienceConfigUpdateRequest };

// Fail-closed normalization of the DB config row's broad string fields into the
// canonical Domain unions. The valid sets are derived from the Domain constants
// (Object.values), never a duplicate handwritten union or an unverified cast —
// a value survives the narrowing only when it is a verified member.
const VALID_CAPABILITY_VALUES: ReadonlySet<string> = new Set(Object.values(EXPERIENCE_CAPABILITY));
const VALID_CONTEXT_MODE_VALUES: ReadonlySet<string> = new Set(Object.values(EXPERIENCE_CONTEXT_MODE));

function normalizeCapabilityGrants(raw: string[] | undefined): ExperienceCapability[] {
  return (raw ?? []).filter((g): g is ExperienceCapability => VALID_CAPABILITY_VALUES.has(g));
}

function isExperienceContextMode(raw: string): raw is ExperienceContextMode {
  return VALID_CONTEXT_MODE_VALUES.has(raw);
}

function normalizeContextMode(raw: string | undefined): ExperienceContextMode {
  if (raw !== undefined && isExperienceContextMode(raw)) return raw;
  return EXPERIENCE_CONTEXT_MODE.none;
}

/**
 * Insights build panel (INSIGHTS_PLAN INS-2). Four opt-in per-chat feature
 * toggles — Objective Tracker, Scene Tracker, Dice, and Interactive Experience
 * — each persisted per-chat through its own config pipe.
 *
 * Objective / Tracker / Dice travel through the INS-1b config pipe
 * (`PATCH /api/chats/:chatId/insights-config`); both are OFF by default and
 * when all three are off (plus Experience) NO prompt layer is injected and the
 * header renders exactly as today. The per-feature config editors are layered in
 * by their own components; this panel is the stable home for them, gated on the
 * matching `*Enabled` flag.
 *
 * Interactive Experience is a FOURTH independent feature beside the other three
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 7 / IR-72B). It is NOT part of
 * `insightsConfig` and is NOT persisted through the insights-config PATCH — it
 * uses the dedicated Experience config endpoint and rehydrates the
 * server-authoritative Experience store. Its toggle is disabled until the active
 * branch and the confirmed config row are loaded, and an absent/temporary branch
 * never crashes or affects the other three features.
 *
 * The panel reads the live chat config from the snapshot store and writes each
 * toggle through its action, which round-trips the whole snapshot back. A local
 * pending patch flips the selected Toggle immediately, then yields to the
 * confirmed snapshot (or rolls back to store state on failure). The same pending
 * state invisibly locks every feature row so rapid/concurrent PATCH responses
 * cannot overwrite each other; feature rows never dim while the network is in
 * flight.
 */
export function InsightsPanel() {
  const { t } = useT();
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const activeBranch = useActiveBranch();
  const branchId = activeBranch?.id ?? null;
  const chatIdStr = activeChat?.id ?? null;
  const experienceConfig = useExperienceConfig(chatIdStr, branchId);
  const [pending, setPending] = useState<Pending | null>(null);

  // Hydrate the server-authoritative Experience store for the active
  // {chatId, branchId}. An absent/temporary branch is a no-op here and never
  // affects the Objective/Tracker/Dice rows below.
  useEffect(() => {
    if (!chatIdStr || !branchId) return;
    useExperienceStore.getState().setScope(chatIdStr, branchId);
  }, [chatIdStr, branchId]);

  if (!activeChat) {
    // Build Mode can be opened standalone (character editor, no active chat).
    // Insights are chat-level config, so there is nothing to configure until a
    // chat is open — surface that explicitly rather than rendering dead toggles.
    return (
      <div className="mx-auto max-w-4xl p-1">
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

  // Objective/Tracker/Dice optimistic overlay — unchanged. Only a non-experience
  // pending entry for THIS chat overlays the confirmed snapshot config.
  const pendingPatch: InsightsConfigPatch | null =
    pending !== null && pending.chatId === chatId && pending.which !== "experience"
      ? pending.patch
      : null;
  const objectiveEnabled = pendingPatch?.objectiveEnabled
    ?? activeChat.insightsConfig?.objectiveEnabled
    ?? false;
  const trackerEnabled = pendingPatch?.trackerEnabled
    ?? activeChat.insightsConfig?.trackerEnabled
    ?? false;
  const diceEnabled = pendingPatch?.diceEnabled
    ?? activeChat.insightsConfig?.diceEnabled
    ?? false;
  const diceMode = pendingPatch?.diceMode
    ?? activeChat.insightsConfig?.diceMode
    ?? "normal";
  // null/absent = inherit (resolver union); an array = explicit chat-local override.
  const diceScriptIds = pendingPatch?.diceScriptIds
    ?? activeChat.insightsConfig?.diceScriptIds
    ?? null;
  // null/absent = each check uses its declared actors; a record = explicit
  // per-script actor distribution (Rework R1). Only meaningful in override mode.
  const diceActorBindings = pendingPatch?.diceActorBindings
    ?? activeChat.insightsConfig?.diceActorBindings
    ?? null;

  // Experience config comes from the dedicated store (NOT insightsConfig). The
  // toggle overlays only a local pending Experience patch during a request; the
  // confirmed config is always the server-authoritative store value.
  const pendingExperiencePatch: ExperienceConfigUpdateRequest | null =
    pending !== null && pending.chatId === chatId && pending.which === "experience"
      ? pending.patch
      : null;
  const experienceEnabled =
    pendingExperiencePatch?.enabled !== undefined
      ? pendingExperiencePatch.enabled
      : (experienceConfig?.enabled ?? false);
  const experienceToggleDisabled =
    pending !== null || branchId === null || experienceConfig === null;
  // Controlled values for ExperienceAssignment: confirmed config (normalized
  // from DB strings) overlaid by the pending patch (already canonical).
  const assignScriptId =
    pendingExperiencePatch?.scriptId !== undefined
      ? pendingExperiencePatch.scriptId
      : (experienceConfig?.scriptId ?? null);
  const assignVisualId =
    pendingExperiencePatch?.visualId !== undefined
      ? pendingExperiencePatch.visualId
      : (experienceConfig?.visualId ?? null);
  const assignGrants =
    pendingExperiencePatch?.capabilityGrants !== undefined
      ? pendingExperiencePatch.capabilityGrants
      : normalizeCapabilityGrants(experienceConfig?.capabilityGrants);
  const assignContextMode =
    pendingExperiencePatch?.contextMode !== undefined
      ? pendingExperiencePatch.contextMode
      : normalizeContextMode(experienceConfig?.contextMode);
  const assignLauncherVisible =
    pendingExperiencePatch?.launcherVisible !== undefined
      ? pendingExperiencePatch.launcherVisible
      : (experienceConfig?.launcherVisible ?? false);

  async function persist(patch: InsightsConfigPatch, which: "objective" | "tracker" | "dice") {
    if (pending) return;
    setPending({ chatId, which, patch });
    try {
      await updateInsightsConfigAction(chatId, { insightsConfig: patch });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("insights_save_failed"));
    } finally {
      setPending((current) => current?.chatId === chatId && current.which === which ? null : current);
    }
  }

  async function persistExperience(patch: ExperienceConfigUpdateRequest) {
    if (pending || branchId === null) return;
    const originChat = chatId;
    const originBranch = branchId;
    setPending({ chatId: originChat, branchId: originBranch, which: "experience", patch });
    try {
      await updateExperienceConfig(originChat, patch);
      // Rehydrate the exact originating scope so the confirmed server config
      // wins before the pending overlay clears.
      await useExperienceStore.getState().rehydrate(originChat, originBranch);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("insights_experience_save_failed"));
      // Rollback is implicit: the confirmed store config was never mutated
      // locally, so clearing the pending overlay (finally) reverts the display
      // to the confirmed config.
    } finally {
      // Scope-safe: clear only the pending entry for THIS originating scope; a
      // mid-flight chat/branch switch leaves the new scope untouched.
      setPending((current) =>
        current !== null
          && current.which === "experience"
          && current.chatId === originChat
          && current.branchId === originBranch
          ? null
          : current,
      );
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-3 p-1">
      <FeatureToggleRow
        icon={<Ic.checkCircle />}
        title={t("insights_objective_title")}
        desc={t("insights_objective_desc")}
        checked={objectiveEnabled}
        disabled={pending !== null}
        onChange={(v) => void persist({ objectiveEnabled: v }, "objective")}
      />
      {objectiveEnabled && <ObjectiveConfig chatId={chatId} />}
      <FeatureToggleRow
        icon={<Ic.clipboard />}
        title={t("insights_tracker_title")}
        desc={t("insights_tracker_desc")}
        checked={trackerEnabled}
        disabled={pending !== null}
        onChange={(v) => void persist({ trackerEnabled: v }, "tracker")}
      />
      {trackerEnabled && <TrackerConfig chatId={chatId} />}
      <FeatureToggleRow
        icon={<Ic.dice />}
        title={t("insights_dice_title")}
        desc={t("insights_dice_desc")}
        checked={diceEnabled}
        disabled={pending !== null}
        onChange={(v) => void persist({ diceEnabled: v }, "dice")}
      />
      {diceEnabled && (
        <DiceAssignment
          chatId={chatId}
          diceMode={diceMode}
          diceScriptIds={diceScriptIds}
          diceActorBindings={diceActorBindings}
          onPatch={(p) => void persist(p, "dice")}
          pending={pending !== null}
        />
      )}
      <FeatureToggleRow
        icon={<Ic.sparkles />}
        title={t("insights_experience_title")}
        desc={t("insights_experience_desc")}
        checked={experienceEnabled}
        disabled={experienceToggleDisabled}
        onChange={(v) => void persistExperience({ enabled: v })}
      />
      {experienceEnabled && branchId !== null && experienceConfig !== null && (
        <ExperienceAssignment
          chatId={chatId}
          scriptId={assignScriptId}
          visualId={assignVisualId}
          capabilityGrants={assignGrants}
          contextMode={assignContextMode}
          sourceCharacterId={experienceConfig.contextSourceCharacterId}
          sourceChatId={experienceConfig.contextSourceChatId}
          launcherVisible={assignLauncherVisible}
          onPatch={(p) => void persistExperience(p)}
          pending={pending !== null}
        />
      )}
      {!objectiveEnabled && !trackerEnabled && !diceEnabled && !experienceEnabled && (
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
      className={`flex items-start gap-3 rounded-lg border border-border bg-s2 p-4 transition-colors hover:border-border2 ${disabled ? "cursor-default" : "cursor-pointer"}`}
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
