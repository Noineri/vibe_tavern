import type { ReactNode } from "react";
import type { TFunc } from "../i18n/context.js";

/** Declaration order is the navigation order, including sections registered later. */
export const SETTINGS_SECTION = {
  interface: "interface",
  sound: "sound",
  data: "data",
  network: "network",
  about: "about",
} as const;

export type SettingsSectionId = typeof SETTINGS_SECTION[keyof typeof SETTINGS_SECTION];

export interface SettingsSectionDescriptor {
  id: SettingsSectionId;
  icon: ReactNode;
  labelKey: Parameters<TFunc>[0];
  render: () => ReactNode;
  /** Layout gate, matching useIsMobile (not the server host's OS). */
  platform?: "desktop" | "mobile";
}

const sectionOrder = Object.values(SETTINGS_SECTION);
let sections: readonly SettingsSectionDescriptor[] = Object.freeze([]);
const listeners = new Set<() => void>();

function publish(next: SettingsSectionDescriptor[]) {
  // React's external-store snapshot must change on writes, never on reads.
  sections = Object.freeze(next.sort((a, b) => sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id)));
  for (const listener of listeners) listener();
}

export function registerSettingsSection(section: SettingsSectionDescriptor): () => void {
  publish([...sections.filter((current) => current.id !== section.id), section]);
  return () => {
    if (sections.includes(section)) publish(sections.filter((current) => current !== section));
  };
}

export function getSettingsSections(): readonly SettingsSectionDescriptor[] {
  return sections;
}

export function subscribeSettingsSections(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
