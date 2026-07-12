import type { PromptAssemblyContext } from "../types.js";
import { createAdvancedResolver } from "./advanced-resolver.js";
import { createSimpleResolver } from "./simple-resolver.js";
import type { PositionResolver, ResolverPromptOrderEntry } from "./position-resolver.js";

export const RESOLVER_ID = { simple: "simple", advanced: "advanced" } as const;
export type ResolverId = (typeof RESOLVER_ID)[keyof typeof RESOLVER_ID];

export const RESOLVERS = {
  [RESOLVER_ID.simple]: () => createSimpleResolver(),
  [RESOLVER_ID.advanced]: (preset: NonNullable<PromptAssemblyContext["preset"]>) =>
    createAdvancedResolver((preset.promptOrder ?? []) as ResolverPromptOrderEntry[]),
} as const;

export function getResolverId(preset: PromptAssemblyContext["preset"]): ResolverId {
  return preset?.advancedMode ? RESOLVER_ID.advanced : RESOLVER_ID.simple;
}

export function createRegisteredResolver(preset: PromptAssemblyContext["preset"]): PositionResolver {
  return getResolverId(preset) === RESOLVER_ID.advanced
    ? RESOLVERS.advanced(preset!)
    : RESOLVERS.simple();
}
