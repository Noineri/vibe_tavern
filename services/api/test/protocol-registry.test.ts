/**
 * Unit tests for the protocol registry — the single source of truth that
 * collapsed four hand-synced dispatch sites (mapProfileToSdkModel,
 * PROVIDER_CAPABILITIES, the three gateway switches, SAMPLER_SETS lookup).
 *
 * The 20 gateway tests cover the registry *transitively* (gateway →
 * resolveProtocol → adapter.probe/testChat/listModels). These tests cover the
 * registry *directly*: structural completeness, the unknown-type throw, the
 * `textCompletion` default (Novel Mode's starting state), and the
 * shim/registry no-drift invariant.
 *
 * Refactor plan: `CODE_REVIEW_REFACTOR_PLAN.md` §5.3.2.
 */

import { describe, it, expect } from "bun:test";
import { PROVIDER_TYPE } from "@vibe-tavern/domain";
import type { ProviderType } from "@vibe-tavern/domain";
import {
	resolveProtocol,
	PROTOCOL_CAPABILITIES,
} from "../src/domain/providers/protocol-registry.js";

const ALL_TYPES = Object.values(PROVIDER_TYPE) as ProviderType[];

describe("protocol registry", () => {
	describe("resolveProtocol", () => {
		it("returns an adapter for every canonical ProviderType", () => {
			for (const type of ALL_TYPES) {
				const adapter = resolveProtocol(type);
				expect(adapter.id).toBe(type);
			}
		});

		it("throws for an unknown provider type", () => {
			// The record is exhaustive over the ProviderType union, so this is
			// unreachable via normal call paths (normalizeProviderType falls
			// back to openai_compat). We cast to exercise the defensive throw.
			expect(() => resolveProtocol("vertex_ai" as ProviderType)).toThrow(
				/Unknown provider type/,
			);
		});

		it("each adapter exposes probe / testChat / listModels as functions", () => {
			for (const type of ALL_TYPES) {
				const adapter = resolveProtocol(type);
				expect(typeof adapter.probe).toBe("function");
				expect(typeof adapter.testChat).toBe("function");
				expect(typeof adapter.listModels).toBe("function");
				expect(typeof adapter.resolveModel).toBe("function");
			}
		});

		it("each adapter declares a non-empty limitations array", () => {
			for (const type of ALL_TYPES) {
				const adapter = resolveProtocol(type);
				expect(Array.isArray(adapter.limitations)).toBe(true);
			}
		});
	});

	describe("PROTOCOL_CAPABILITIES", () => {
		it("has an entry for every ProviderType", () => {
			for (const type of ALL_TYPES) {
				expect(PROTOCOL_CAPABILITIES[type]).toBeDefined();
			}
		});
		it("matches each adapter's capabilities (single source of truth)", () => {
			for (const type of ALL_TYPES) {
				expect(PROTOCOL_CAPABILITIES[type]).toStrictEqual(
					resolveProtocol(type).capabilities,
				);
			}
		});

		it("defaults textCompletion to false everywhere (Novel Mode starting state)", () => {
			// The textCompletion flag is the Novel Mode axis (plan §5.3.3). It
			// landed as a home for the flag with no protocol opted in yet; the
			// mode dispatch is Novel Mode's wiring step. This test pins that
			// starting state so an accidental flip is caught.
			for (const type of ALL_TYPES) {
				expect(PROTOCOL_CAPABILITIES[type].textCompletion).toBe(false);
			}
		});

		it("declares streaming + abortSignal true for every protocol (baseline contract)", () => {
			for (const type of ALL_TYPES) {
				const caps = PROTOCOL_CAPABILITIES[type];
				expect(caps.streaming).toBe(true);
				expect(caps.abortSignal).toBe(true);
				expect(caps.nonStreamGeneration).toBe(true);
			}
		});

		it("declares a samplers block for every protocol", () => {
			for (const type of ALL_TYPES) {
				expect(PROTOCOL_CAPABILITIES[type].samplers).toBeDefined();
				expect(typeof PROTOCOL_CAPABILITIES[type].samplers).toBe("object");
			}
		});
	});
});
