import { z } from "zod";
import { PROXY_MODE } from "@vibe-tavern/domain";

export const providerProxyModeSchema = z.enum([PROXY_MODE.inherit, PROXY_MODE.direct, PROXY_MODE.proxy]);

/** Core fields for creating/updating a named proxy. `password` is write-only:
 *  omitted or empty string preserves an existing stored password, a non-empty
 *  string replaces it, and explicit `null` clears it (mirrors provider apiKey). */
export const proxyCoreSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  username: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
});

export const saveProxySchema = proxyCoreSchema;

export const updateProxySchema = proxyCoreSchema.partial();

export const reorderProxiesSchema = z.object({
  updates: z.array(z.object({
    id: z.string(),
    sortOrder: z.number(),
  })),
});

export const setDefaultProxySchema = z.object({
  /** Null clears the global default (providers inherit → direct). */
  defaultProxyId: z.string().nullable(),
});
