import type { ReactNode } from "react";

export interface BuildPanelDescriptor {
  /** Unique tab id — used as BuildTab value and i18n key prefix */
  id: string;
  /** Icon component (24-32px) */
  icon: ReactNode;
  /** i18n key for sidebar label (expanded mode) */
  labelKey: string;
  /** Whether this tab uses full-bleed layout (no padding, no max-width) */
  fullBleed?: boolean;
  /** Render the panel content. Receives context from BuildMode. */
  render: (ctx: BuildPanelContext) => ReactNode;
}

export interface BuildPanelContext {
  characterId: string;
  chatId: string | null;
  personaId: string | null;
}

type Listener = () => void;

const panels: BuildPanelDescriptor[] = [];
const listeners: Set<Listener> = new Set();

function notify() {
  for (const fn of listeners) fn();
}

export function registerBuildPanel(panel: BuildPanelDescriptor): () => void {
  const idx = panels.findIndex((p) => p.id === panel.id);
  if (idx !== -1) panels[idx] = panel;
  else panels.push(panel);
  notify();
  return () => {
    const i = panels.indexOf(panel);
    if (i !== -1) panels.splice(i, 1);
    notify();
  };
}

export function getBuildPanels(): readonly BuildPanelDescriptor[] {
  return panels;
}

export function subscribeBuildPanels(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
