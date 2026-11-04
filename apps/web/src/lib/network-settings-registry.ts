import type { ReactNode } from "react";

/** Public extension slots: the catalog registers itself later, with no placeholder. */
export const NETWORK_SETTINGS_ORDER = { proxies: 0, modelCatalog: 100, mobileAccess: 200 } as const;

export interface NetworkSettingsBlock {
  id: string;
  order: number;
  render: () => ReactNode;
  platform?: "desktop" | "mobile";
}

let blocks: readonly NetworkSettingsBlock[] = Object.freeze([]);
const listeners = new Set<() => void>();
function publish(next: NetworkSettingsBlock[]) {
  blocks = Object.freeze(next.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)));
  for (const listener of listeners) listener();
}
export function registerNetworkSettingsBlock(block: NetworkSettingsBlock): () => void {
  publish([...blocks.filter((current) => current.id !== block.id), block]);
  return () => { if (blocks.includes(block)) publish(blocks.filter((current) => current !== block)); };
}
export function getNetworkSettingsBlocks(): readonly NetworkSettingsBlock[] { return blocks; }
export function subscribeNetworkSettingsBlocks(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
