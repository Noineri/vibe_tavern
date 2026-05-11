/**
 * TanStack Query key factories.
 * Each domain gets its own key namespace for type-safe invalidation.
 */
import type { ChatId } from "@rp-platform/domain";

export const providerKeys = {
  all: () => ["providers"] as const,
  list: () => ["providers", "list"] as const,
  detail: (id: string) => ["providers", "detail", id] as const,
  models: (id: string) => ["providers", "models", id] as const,
  favorites: (id: string) => ["providers", "favorites", id] as const,
};

// Chat key factory — TQ3
export const chatKeys = {
  all: () => ["chat"] as const,
  none: () => ["chat", "snapshot", "none"] as const,
  snapshot: (chatId: ChatId) => ["chat", "snapshot", chatId] as const,
  branches: (chatId: ChatId) => ["chat", "branches", chatId] as const,
};

export const characterKeys = {
  all: () => ["characters"] as const,
};

export const personaKeys = {
  all: () => ["personas"] as const,
  list: () => ["personas", "list"] as const,
};

export const bootstrapKeys = {
  all: () => ["bootstrap"] as const,
  snapshot: () => ["bootstrap", "snapshot"] as const,
};
