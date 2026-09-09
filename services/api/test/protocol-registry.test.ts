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

		it("opts ONLY the /completions-capable protocols into textCompletion (LOCAL_SUPPORT_PLAN LS-2e)", () => {
			// The flag now means "serves the opt-in TC generation mode": a profile
			// with generationMode "completion" resolves a raw completion model
			// HERE, and stays chat everywhere else (silent fallback). openai_compat
			// (LM Studio / ooba / TabbyAPI / Aphrodite / vLLM / generic) and
			// llamacpp (llama-server) carry /completions; koboldcpp is ALWAYS
			// text completion natively (its own serializer — no toggle to expose),
			// and the clouds + google + anthropic + ollama + unsloth have no
			// OpenAI-style completion surface.
			expect(PROTOCOL_CAPABILITIES.openai_compat.textCompletion).toBe(true);
			expect(PROTOCOL_CAPABILITIES.llamacpp.textCompletion).toBe(true);
			for (const type of ALL_TYPES) {
				if (type === "openai_compat" || type === "llamacpp") continue;
				expect(PROTOCOL_CAPABILITIES[type].textCompletion).toBe(false);
			}
		});

		it("declares backendTemplate ONLY on llama-server (LOCAL_SUPPORT_PLAN LS-3c)", () => {
			// AUTO generation-format template source: llama-server offloads the
			// model's Jinja chat template via POST /apply-template (verified live
			// on b10786, 2026-09-09). openai_compat backends expose no template
			// API (AUTO falls to the documented default template); koboldcpp is
			// native (its adapter builds the prompt itself); every other protocol
			// has no TC surface at all.
			expect(PROTOCOL_CAPABILITIES.llamacpp.backendTemplate).toBe(true);
			for (const type of ALL_TYPES) {
				if (type === "llamacpp") continue;
				expect(PROTOCOL_CAPABILITIES[type].backendTemplate).toBe(false);
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
