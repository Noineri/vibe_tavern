import { useState, useRef, useEffect } from "react";
import { Icons } from "./shared/icons.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/context.js";
import { avatarUrl } from "../lib/avatar.js";
import { useModalStore } from "../stores/modal-store.js";

function PersonaAvatar({ assetId, size }: { assetId: string | null; size: number }) {
  if (!assetId) {
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
      src={avatarUrl(assetId)}
      alt=""
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  );
}

interface Props {
  personas: Array<{ id: string; name: string; description: string; avatarAssetId: string | null }>;
  activePersonaId: string | null;
  onSelect: (personaId: string) => void;
}

export function PersonaQuickSwitch({ personas, activePersonaId, onSelect }: Props) {
  const { t } = useT();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activePersona = personas.find((p) => p.id === activePersonaId) || personas[0];

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  if (!activePersona) {
    return (
      <div className="flex shrink-0 cursor-default items-center gap-1 whitespace-nowrap rounded-full bg-accent-dim px-[9px] py-[3px] text-xs font-medium text-accent-t">
        <span>{t("no_persona")}</span>
      </div>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full bg-accent-dim px-[9px] py-[3px] text-xs font-medium text-accent-t"
        onClick={() => setIsOpen(!isOpen)}
      >
        <PersonaAvatar assetId={activePersona.avatarAssetId} size={18} />
        <span>{activePersona.name.split(' ')[0]}</span>
        <Icons.Caret direction={isOpen ? "u" : "d"} />
      </button>
      {isOpen && (
        <div className="absolute bottom-[calc(100%+8px)] z-[220] left-0 w-[220px] rounded-lg border border-border2 bg-surface py-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
          <div className="mb-1 border-b border-border px-4 pt-1 pb-2 text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("persona_selection")}</div>
          {personas.map(p => (
            <button
              key={p.id}
              className={cn("flex w-full cursor-pointer items-center gap-2 text-left text-[13px] text-t1 hover:bg-s2 px-4 py-1.5", p.id === activePersonaId && "bg-accent-dim")}
              onClick={() => { onSelect(p.id); setIsOpen(false); }}
            >
              <div className="w-4 shrink-0 flex justify-center text-accent-t">{p.id === activePersonaId && <Icons.Check />}</div>
              <PersonaAvatar assetId={p.avatarAssetId} size={22} />
              <div className="overflow-hidden text-ellipsis whitespace-nowrap">{p.name}</div>
            </button>
          ))}
          <div className="mt-1 border-t border-border px-4 pt-2 pb-0">
            <button
              className="flex cursor-pointer items-center gap-1 rounded p-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
              onClick={() => { setIsOpen(false); useModalStore.getState().setIsPersonaModalOpen(true); }}
            >
              <Icons.Edit /> {t("manage_personas")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
