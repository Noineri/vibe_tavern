/**
 * @module ai/provider-capabilities
 *
 * Compatibility shim over the protocol registry
 * (`providers/protocol-registry.ts`). The capability map lived here
 * historically; the registry is now the source of truth. This file preserves
 * the public names (`PROVIDER_CAPABILITIES`, `getProviderCapabilities`,
 * `ProviderCapabilityFlags`, `ProviderCapabilityMap`) so existing importers
 * keep working.
 *
 * Refactor plan: `CODE_REVIEW_REFACTOR_PLAN.md` §5.3.2.
 */

import type { ProviderType } from "@vibe-tavern/domain";
import {
	PROTOCOL_CAPABILITIES,
	resolveProtocol,
	type ProviderCapabilityFlags,
} from "../../domain/providers/protocol-registry.js";

export type { ProviderCapabilityFlags };

export type ProviderCapabilityMap = Record<ProviderType, ProviderCapabilityFlags>;

/**
 * Capability declarations for all provider kinds. Derived from the protocol
 * registry (source of truth) and re-exported under the legacy name.
 */
export const PROVIDER_CAPABILITIES: ProviderCapabilityMap = PROTOCOL_CAPABILITIES;

/** Look up capabilities for a given provider type. */
export function getProviderCapabilities(
	type: ProviderType,
): ProviderCapabilityFlags {
	return resolveProtocol(type).capabilities;
}
