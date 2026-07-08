import { useState } from "react";
import { Icons } from "../shared/icons.js";
import { QuickSwitchPopover } from "../shared/QuickSwitchPopover.js";
import { useT } from "../../i18n/context.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { useModalStore } from "../../stores/modal-store.js";

function PersonaAvatar({ src, size }: { src: string | null; size: number }) {
  if (!src) {
    return (
      <div
        className="shrink-0 rounded-full bg-s3 flex items-center justify-center text-t3"
        style={{ width: size, height: size }}
      >
        <Icons.User />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  );
}

interface Props {
  personas: Array<{ id: string; name: string; description: string; avatarAssetId: string | null; avatarExt: string | null; updatedAt: string }>;
  activePersonaId: string | null;
  onSelect: (personaId: string) => void;
}

/**
 * Desktop persona quick-switch, built on the shared `QuickSwitchPopover`.
 *
 * `QuickSwitchPopover` is Popover-based (not Radix Select), so it holds no
 * <body> pointer-events lock — the footer ("manage personas") can dismiss
 * the popover and open `PersonaModal` in the same handler without the UI
 * freeze that Select's hardcoded `DismissableLayer` + Presence exit-animation
 * caused here. Exit animation is retained (Popover is safe to animate out).
 * Controlled open is used purely so the footer can close the popover before
 * launching the modal — no longer a leak workaround.
 */
export function PersonaQuickSwitch({ personas, activePersonaId, onSelect }: Props) {
  const { t } = useT();

  const activePersona = personas.find((p) => p.id === activePersonaId) || personas[0];

  const [open, setOpen] = useState(false);

  if (!activePersona) {
    return (
      <div className="flex shrink-0 cursor-default items-center gap-1 whitespace-nowrap rounded-full bg-accent-dim px-[9px] py-[3px] text-xs font-medium text-accent-t">
        <span>{t("no_persona")}</span>
      </div>
    );
  }

  return (
    <QuickSwitchPopover
      open={open}
      onOpenChange={setOpen}
      title={t("persona_selection")}
      align="start"
      contentWidth={220}
      items={personas.map((p) => ({
        value: p.id,
        label: p.name,
        leading: <PersonaAvatar src={resolveEntityAvatarUrl({ kind: "personas", id: p.id, avatarExt: p.avatarExt, avatarAssetId: p.avatarAssetId, updatedAt: p.updatedAt })} size={22} />,
      }))}
      value={activePersonaId}
      onSelect={onSelect}
      footer={
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-1.5 rounded p-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
          onClick={() => {
            setOpen(false);
            useModalStore.getState().setIsPersonaModalOpen(true);
          }}
        >
          <Icons.Edit className="h-3.5 w-3.5" /> {t("manage_personas")}
        </button>
      }
      trigger={
        <button
          type="button"
          className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full bg-accent-dim px-[9px] py-[3px] text-xs font-medium text-accent-t"
        >
          <PersonaAvatar src={resolveEntityAvatarUrl({ kind: "personas", id: activePersona.id, avatarExt: activePersona.avatarExt, avatarAssetId: activePersona.avatarAssetId, updatedAt: activePersona.updatedAt })} size={18} />
          <span>{activePersona.name.split(' ')[0]}</span>
          <Icons.Caret direction="d" className="text-t3" />
        </button>
      }
    />
  );
}
