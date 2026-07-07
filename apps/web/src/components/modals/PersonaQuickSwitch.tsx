import { useState } from "react";
import { Icons } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { useModalStore } from "../../stores/modal-store.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import * as Select from "@radix-ui/react-select";

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

export function PersonaQuickSwitch({ personas, activePersonaId, onSelect }: Props) {
  const { t } = useT();

  const activePersona = personas.find((p) => p.id === activePersonaId) || personas[0];

  // Controlled open state so the "manage personas" footer can dismiss the
  // Select BEFORE opening the modal. Leaving the Select open while a Dialog
  // mounts on top freezes the UI: Radix Select keeps its FocusScope / Portal
  // content alive (it has no idea the user navigated away), so after the
  // modal closes the orphaned Select content still traps input. The mobile
  // path avoids this by calling setMobilePersonaOpen(false) first; this mirrors
  // it. (Pre-existing bug from the step-3 Select migration, surfaced now.)
  const [open, setOpen] = useState(false);

  if (!activePersona) {
    return (
      <div className="flex shrink-0 cursor-default items-center gap-1 whitespace-nowrap rounded-full bg-accent-dim px-[9px] py-[3px] text-xs font-medium text-accent-t">
        <span>{t("no_persona")}</span>
      </div>
    );
  }

  return (
    <Select.Root
      open={open}
      onOpenChange={setOpen}
      value={activePersonaId ?? undefined}
      onValueChange={(id) => onSelect(id)}
    >
      <Select.Trigger asChild>
        <button type="button"
          className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full bg-accent-dim px-[9px] py-[3px] text-xs font-medium text-accent-t"
        >
          <PersonaAvatar src={resolveEntityAvatarUrl({ kind: "personas", id: activePersona.id, avatarExt: activePersona.avatarExt, avatarAssetId: activePersona.avatarAssetId, updatedAt: activePersona.updatedAt })} size={18} />
          <span>{activePersona.name.split(' ')[0]}</span>
          <Select.Icon className="text-t3">
            <Icons.Caret direction="d" />
          </Select.Icon>
        </button>
      </Select.Trigger>
      <Select.Portal container={getModalPortal() ?? undefined}>
        <Select.Content
          position="popper"
          side="top"
          sideOffset={8}
          align="start"
          className="glass-blur z-[220] w-[220px] overflow-hidden rounded-lg border border-border2 bg-glass-bg py-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)]"
        >
          <div className="mb-1 border-b border-border px-4 pt-1 pb-2 text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("persona_selection")}</div>
          <Select.Viewport className="max-h-[204px] overflow-y-auto">
            {personas.map(p => (
              <Select.Item
                key={p.id}
                value={p.id}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-none text-left text-[13px] text-t1 outline-none transition-colors data-[highlighted]:bg-s2 px-4 py-1.5 data-[state=checked]:bg-accent-dim",
                )}
              >
                <span className="w-4 shrink-0 flex justify-center text-accent-t">
                  <Select.ItemIndicator><Icons.Check /></Select.ItemIndicator>
                </span>
                <PersonaAvatar src={resolveEntityAvatarUrl({ kind: "personas", id: p.id, avatarExt: p.avatarExt, avatarAssetId: p.avatarAssetId, updatedAt: p.updatedAt })} size={22} />
                <Select.ItemText asChild>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">{p.name}</span>
                </Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
          <div className="mt-1 border-t border-border px-4 pt-2 pb-0">
            <button type="button"
              className="flex cursor-pointer items-center gap-1 rounded p-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
              onClick={() => {
                setOpen(false);
                useModalStore.getState().setIsPersonaModalOpen(true);
              }}
            >
              <Icons.Edit /> {t("manage_personas")}
            </button>
          </div>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
