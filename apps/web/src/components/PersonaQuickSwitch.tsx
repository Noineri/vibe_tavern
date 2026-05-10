import { useState, useRef, useEffect } from "react";
import { Icons } from "./shared/icons.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/context.js";

interface Props {
  personas: Array<{ id: string; name: string; description: string }>;
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
      <div className="flex shrink-0 cursor-default items-center gap-1 whitespace-nowrap rounded-full bg-accent-dim text-xs font-medium text-accent-t" style={{ padding: '3px 9px' }}>
        <span>{t("no_persona")}</span>
      </div>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full bg-accent-dim text-xs font-medium text-accent-t"
        style={{padding:'3px 9px'}}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{activePersona.name.split(' ')[0]}</span>
        <Icons.Caret direction={isOpen ? "u" : "d"} />
      </button>
      {isOpen && (
        <div className="absolute bottom-[calc(100%+8px)] z-[220] left-0 w-[220px] rounded-lg border border-border2 bg-surface shadow-[0_12px_28px_rgba(0,0,0,0.45)]" style={{padding:'8px 0'}}>
          <div className="text-[calc(var(--ui-fs)-3px)] uppercase tracking-[0.08em] text-t3 font-medium border-b border-border mb-1" style={{padding:'4px 16px 8px'}}>{t("persona_selection")}</div>
          {personas.map(p => (
            <button
              key={p.id}
              className={cn("flex w-full cursor-pointer items-center gap-2 text-left text-[13px] text-t1 hover:bg-s2", p.id === activePersonaId && "bg-accent-dim")}
              style={{padding:'6px 16px'}}
              onClick={() => { onSelect(p.id); setIsOpen(false); }}
            >
              <div className="w-4 shrink-0 flex justify-center text-accent-t">{p.id === activePersonaId && <Icons.Check />}</div>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap">{p.name}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
