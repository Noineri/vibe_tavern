/**
 * TanStack Query key factories.
 * Each domain gets its own key namespace for type-safe invalidation.
 */

export const providerKeys = {
  all: () => ["providers"] as const,
  list: () => ["providers", "list"] as const,
  detail: (id: string) => ["providers", "detail", id] as const,
  models: (id: string) => ["providers", "models", id] as const,
  favorites: (id: string) => ["providers", "favorites", id] as const,
};

// Placeholder factories — filled in TQ2-TQ4
export const chatKeys = {
  all: () => ["chat"] as const,
};

export const characterKeys = {
  all: () => ["character"] as const,
};

export const personaKeys = {
  all: () => ["persona"] as const,
};

export const bootstrapKeys = {
  all: () => ["bootstrap"] as const,
};
