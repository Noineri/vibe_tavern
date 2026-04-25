import { useState, useRef, useEffect } from "react";
import { Icons } from "./shared/icons.js";

interface Props {
  personas: Array<{ id: string; name: string; description: string }>;
  activePersonaId: string | null;
  onSelect: (personaId: string) => void;
}

export function PersonaQuickSwitch({ personas, activePersonaId, onSelect }: Props) {
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
      <div className="char-pill">
        <span>No Persona</span>
      </div>
    );
  }

  return (
    <div className="char-pill" style={{ position: "relative", padding: 0, overflow: "visible" }} ref={containerRef}>
      <button
        className="pill-btn"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{activePersona.name}</span>
        <Icons.Caret direction={isOpen ? "u" : "d"} />
      </button>
      {isOpen && (
        <div
          style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 8, width: 240, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 8, padding: "8px", zIndex: 200, boxShadow: "0 12px 32px rgba(0,0,0,.4)", display: "flex", flexDirection: "column", gap: 4 }}
        >
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--t3)", marginBottom: 4, fontWeight: 500, padding: "0 4px" }}>Switch Persona</div>
          {personas.map((p) => (
            <button
              key={p.id}
              onClick={() => { onSelect(p.id); setIsOpen(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px", background: p.id === activePersonaId ? "var(--accent-dim)" : "transparent", border: p.id === activePersonaId ? "1px solid var(--accent)" : "1px solid transparent", color: p.id === activePersonaId ? "var(--accent-t)" : "var(--t2)", cursor: "pointer", borderRadius: 6, transition: "background 0.15s" }}
              onMouseEnter={(e) => { if (p.id !== activePersonaId) e.currentTarget.style.background = "var(--s2)"; }}
              onMouseLeave={(e) => { if (p.id !== activePersonaId) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ fontWeight: 500, fontSize: 13, color: p.id === activePersonaId ? "var(--t1)" : "inherit" }}>{p.name}</div>
              <div style={{ fontSize: 11, color: "var(--t3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{p.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
