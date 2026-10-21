/**
 * Branch-sidechat confirm helpers (SC-21) — the single source behind BOTH
 * delete-branch confirm sites (`RichChatRow`, `SidebarFlyout`).
 *
 * The fork confirm needs no shared helper: all three fork call sites go
 * through `handleFork`, so its dialog is built in exactly one place there.
 * The delete confirm is opened from two components, so the best-effort
 * summary fetch and the warning-sentence derivation live here — one copy,
 * not two hand-written derivations.
 */
import type { TFunc } from "../i18n/locale-helpers.js";
import type { ConfirmDestroyDialog } from "../stores/character-store.js";
import { getBranchSidechatSummary } from "../api/agent-chat-api.js";

/**
 * Best-effort read of the branch-sidechat summary: true when the branch owns
 * ACTIVE (non-archived) chat-owned sidechat sessions. A failed or missing
 * summary NEVER blocks the primary action (SC-19b precedent: an events error
 * never drops the session) — callers fall back to `false`, i.e. today's
 * confirm without the warning sentence.
 */
export async function fetchBranchHasSidechat(
  chatId: string | null,
  branchId: string | null,
): Promise<boolean> {
  if (!chatId || !branchId) return false;
  try {
    return (await getBranchSidechatSummary(chatId, branchId)).hasSessions;
  } catch {
    return false;
  }
}

/**
 * Delete-branch confirm body: the base sentence, plus the sidechat warning
 * sentence when the branch owns sessions. Pure derivation — no fetch.
 */
export function deleteBranchConfirmBody(
  t: TFunc,
  baseBody: string,
  hasSessions: boolean,
): string {
  if (!hasSessions) return baseBody;
  return `${baseBody} ${t("sidebar_delete_branch_sidechat_warning")}`;
}

/**
 * Open the active-branch delete confirm through the shared shell slot,
 * appending the sidechat warning when the branch owns sessions. The summary
 * is fetched when the confirm opens; on any failure the confirm opens
 * without the append (the fork/delete NEVER waits on sidechat reads).
 */
export async function openDeleteBranchConfirm(opts: {
  t: TFunc;
  chatId: string | null;
  branchId: string | null;
  setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
  onConfirm: () => void;
}): Promise<void> {
  const hasSessions = await fetchBranchHasSidechat(opts.chatId, opts.branchId);
  opts.setConfirmDestroy({
    title: opts.t("sidebar_delete_branch"),
    body: deleteBranchConfirmBody(opts.t, opts.t("sidebar_delete_branch_body"), hasSessions),
    confirmLabel: opts.t("sidebar_delete_branch"),
    onConfirm: opts.onConfirm,
  });
}
