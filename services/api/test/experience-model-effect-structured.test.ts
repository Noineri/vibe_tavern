/**
 * Schema synthesis for native structured action choice (fix step 1c).
 *
 * Pure unit tests for `synthesizeActionChoiceSchema`: the flat shape when no
 * descriptor declares a payloadSchema, the discriminated oneOf shape when at
 * least one does, and the vocabulary guarantee (synthesized nodes use only
 * kernel-subset keywords + `oneOf`). The provider call itself is covered by the
 * service-level seam tests in experience-model-effect-service.test.ts.
 */
import { describe, expect, test } from "bun:test";

import type { ExperienceActionDescriptor } from "@vibe-tavern/domain";

import { synthesizeActionChoiceSchema } from "../src/domain/interactive/experience-model-effect-structured.js";

const BARE: ExperienceActionDescriptor[] = [
	{ type: "play", label: "Play" },
	{ type: "pass", label: "Pass" },
];

const WITH_SCHEMA: ExperienceActionDescriptor[] = [
	{ type: "go", label: "Go" },
	{
		type: "play",
		label: "Play",
		payloadSchema: {
			type: "object",
			properties: { card: { type: "integer" } },
			required: ["card"],
			additionalProperties: false,
		},
	},
];

describe("synthesizeActionChoiceSchema", () => {
	test("no payloadSchemas: one flat object, actionId enum of legal types, closed", () => {
		expect(synthesizeActionChoiceSchema(BARE)).toEqual({
			type: "object",
			properties: {
				actionId: { type: "string", enum: ["play", "pass"] },
			},
			required: ["actionId"],
			additionalProperties: false,
		});
	});

	test("payloadSchema present: discriminated oneOf binding actionId per variant", () => {
		expect(synthesizeActionChoiceSchema(WITH_SCHEMA)).toEqual({
			oneOf: [
				{
					type: "object",
					properties: { actionId: { type: "string", enum: ["go"] } },
					required: ["actionId"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: {
						actionId: { type: "string", enum: ["play"] },
						args: WITH_SCHEMA[1].payloadSchema,
					},
					required: ["actionId"],
					additionalProperties: false,
				},
			],
		});
	});

	test("empty legal set: still a valid (unsatisfiable) schema, never throws", () => {
		expect(synthesizeActionChoiceSchema([])).toEqual({
			type: "object",
			properties: { actionId: { type: "string", enum: [] } },
			required: ["actionId"],
			additionalProperties: false,
		});
	});
});
