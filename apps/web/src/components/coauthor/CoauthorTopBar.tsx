import { Icons } from "../shared/icons.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { useNavigationStore, useProviderStore, useModalStore } from "../../stores/index.js";
import { useChatMeta } from "../../stores/chat-selectors.js";
import { useProviderProfiles } from "../../hooks/use-provider-profiles.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { MemBadge } from "../settings/popovers/MemBadge.js";

/**
 * Co-Author chrome — the dedicated top bar for `mode === "coauthor"`, selected
 * by AppShell in place of the shared {@link TopBar}. Co-author is a first-class
 * navigation mode (CA-8b), so it owns its surface chrome rather than reusing the
 * RP bar. This keeps the co-author surface honest about what it is: not a chat
 * variant with a hidden preset switcher, but a distinct authoring environment.
 *
 * Layout (CS-20 — full bar):
 *   desktop — avatar/name · memory badge · provider-settings pill · [spacer] ·
 *             back-to-editor · interface-settings
 *   mobile  — avatar/name · back-to-editor  (compact, like TopBar mobile — the
 *             provider/memory affordances are desktop-only there too)
 *
 * The defining difference from TopBar: **no prompt-preset switcher** (presets
 * move to the InputArea pill in Wave 4). The provider-settings pill currently
 * opens the shared ProviderModal; CS-21 repoints it to a tool-filtered
 * CoauthorProviderModal (co-author turns require function-calling, so the model
 * list must hide non-tool models — see useToolCapableModels). Until that swap
 * the pill is still functional, just not yet tool-filtered.
 *
 * The shared TopBar continues to serve play/build unchanged — AppShell picks one
 * or the other by `mode`, never both.
 */
export function CoauthorTopBar({ railHidden, onShowRail }: { railHidden?: boolean; onShowRail?: () => void }) {
  const { t } = useT();
  const isMobile = useIsMobile();

  const setMode = useNavigationStore((s) => s.setMode);
  const tweaksOpen = useModalStore((s) => s.tweaksOpen);
  const chatMeta = useChatMeta();
  const provider = useProviderProfiles();
  const connection = useProviderStore((s) => s.connection);

  const characterName = chatMeta?.character.name ?? "";
  const characterAvatar = chatMeta?.character
    ? resolveEntityAvatarUrl({ kind: "characters", id: chatMeta.character.id, avatarExt: chatMeta.character.avatarExt, avatarAssetId: chatMeta.character.avatarAssetId, updatedAt: chatMeta.character.updatedAt }) ?? undefined
    : undefined;

  // Provider pill — same derivation as TopBar. Opens the shared ProviderModal
  // for now (CS-21 repoints to the tool-filtered CoauthorProviderModal).
  const providerConnected = connection.status === "connected";
  const providerLabel = provider.activeProviderProfile?.name || t("no_provider");
  const providerModelId = provider.activeProviderProfile?.defaultModel || connection.model || null;
  const providerModelLabel = (providerModelId && connection.models.find((m) => m.id === providerModelId)?.label) || providerModelId || t("no_model_selected");

  // "Back to editor" leaves the co-author conversation and drops into BuildMode
  // for the same character (the RP editor). Mirrors TopBar's coauthor toggle,
  // which resolves to setMode('build') when mode === 'coauthor'.
  const goBackToEditor = () => setMode("build");

  // ── Mobile: compact bar ──
  if (isMobile) {
    return (
      <div className="sticky top-0 z-50 flex h-[48px] shrink-0 items-center gap-2.5 border-b border-border bg-surface px-3">
        {railHidden && (
          <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-t3 transition-colors active:bg-s3"
               onClick={onShowRail}>
            <Icons.Menu />
          </div>
        )}
        <div
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-[1.5px] border-transparent bg-s3 font-body text-[calc(var(--ui-fs)-2px)] italic text-t2 transition-opacity duration-150 hover:border-accent hover:opacity-85 [&_img]:h-full [&_img]:w-full [&_img]:object-cover"
          onClick={() => useModalStore.getState().setAvatarOpen(true)}
        >
          {characterAvatar
            ? <img src={characterAvatar} alt={characterName} className="h-full w-full object-cover" />
            : <>{initials(characterName)}</>}
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--ui-fs)] font-medium leading-[1.2] text-t1">{characterName}</div>
        </div>
        <div
          className="cursor-pointer rounded-full bg-accent-dim px-3 py-1 text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.02em] text-accent-t transition-colors duration-150 hover:bg-accent-hover"
          onClick={goBackToEditor}
        >
          <span className="flex items-center gap-1">
            <span className="text-[calc(var(--ui-fs)-3px)]"><Icons.Caret direction="l" /></span>
            {t("topbar_back_to_editor")}
          </span>
        </div>
      </div>
    );
  }

  // ── Desktop ──
  return (
    <div className="sticky top-0 z-50 flex h-[60px] shrink-0 items-center gap-3.5 border-b border-border bg-surface px-[22px]">
      <div className="flex min-w-[90px] max-w-[220px] flex-none items-center gap-2.5">
        <div
          className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-[1.5px] border-transparent bg-s3 font-body text-[calc(var(--ui-fs)+1px)] italic text-t2 transition-opacity duration-150 hover:border-accent hover:opacity-85 [&_img]:h-full [&_img]:w-full [&_img]:object-cover"
          onClick={() => useModalStore.getState().setAvatarOpen(true)}
        >
          {characterAvatar
            ? <img src={characterAvatar} alt={characterName} className="h-full w-full object-cover" />
            : <>{initials(characterName)}</>}
        </div>
        <div className="min-w-0">
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--ui-fs)] font-medium leading-[1.2] text-t1">{characterName}</div>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-[5px] overflow-visible">
        <MemBadge label={t("topbar_memory")} onClick={() => useModalStore.getState().setContextMemoryOpen(true)} />

        <CustomTooltip content={t("provider_settings_title")}>
          <div
            className="flex min-h-8 min-w-0 max-w-[min(520px,60vw)] flex-[0_1_auto] cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded border border-transparent bg-transparent px-2 py-[3px] font-ui text-[calc(var(--ui-fs)-4px)] leading-tight text-t2 transition-colors duration-150 hover:border-border hover:bg-s2 hover:text-t1"
            onClick={() => useModalStore.getState().setIsProviderModalOpen(true)}
          >
            <div className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300",
              connection.status === "error" ? "bg-danger" : providerConnected ? "bg-success" : "bg-t4",
            )} />
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-t1">{providerLabel}</span>
            <span className="text-t3">·</span>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t2">{providerModelLabel || "—"}</span>
          </div>
        </CustomTooltip>

        <div className="min-w-2 flex-1" />

        <div
          className="cursor-pointer rounded-full bg-accent-dim px-3 py-1 text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.02em] text-accent-t transition-colors duration-150 hover:bg-accent-hover"
          tabIndex={0}
          onClick={goBackToEditor}
        >
          <span className="flex items-center gap-1">
            <span className="text-[calc(var(--ui-fs)-3px)]"><Icons.Caret direction="l" /></span>
            {t("topbar_back_to_editor")}
          </span>
        </div>

        <CustomTooltip content={t("topbar_interface_settings")}>
          <div
            className={cn("flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1", tweaksOpen && "bg-accent-dim text-accent-t")}
            tabIndex={0}
            onClick={() => useModalStore.getState().setTweaksOpen(!tweaksOpen)}
          >
            <Icons.sliders />
          </div>
        </CustomTooltip>
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
