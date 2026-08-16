/**
 * Bounded JSON-schema-ish payload enforcement for action payloads
 * (INTERACTIVE_ENGINE_EXPANSION, fix step 1a).
 *
 * The kernel's {@link ./experience-kernel.ts} action descriptors carry an
 * optional `payloadSchema` ("a bounded JSON-schema-ish description the kernel
 * validates submitted payloads against"). Until now that field was bounded-JSON
 * only — nobody validated a submitted payload against it, and nobody rejected a
 * schema that used keywords the kernel could not honor. This module closes both
 * gaps with a deliberately small, honest subset.
 *
 * Supported keywords (anything else is an UNKNOWN KEYWORD, rejected loudly at
 * descriptor-validation time — never silently ignored):
 *   - `type`                 one of "string" | "number" | "integer" | "boolean"
 *                            | "object" | "array" | "null"
 *   - `enum`                 array of allowed values (deep JSON equality)
 *   - `properties`           object mapping property name → sub-schema
 *   - `required`             array of property names that must be present
 *   - `items`                sub-schema each array element must satisfy
 *   - `additionalProperties` boolean; `false` rejects keys outside `properties`
 *   - `minimum` / `maximum`  inclusive numeric bounds
 *   - `minLength` / `maxLength` inclusive string-length bounds
 *
 * Pure (no I/O, no Zod, no imports) so the synchronous kernel reuses it and the
 * model-effect path can reuse the exact same validator for model `args`.
 */

// ─── Subset vocabulary ───────────────────────────────────────────────────────

/** The single-string values `type` accepts in this subset. */
const PAYLOAD_SCHEMA_TYPES = [
	"string",
	"number",
	"integer",
	"boolean",
	"object",
	"array",
	"null",
] as const;

const ALLOWED_KEYWORDS = new Set([
	"type",
	"enum",
	"properties",
	"required",
	"items",
	"additionalProperties",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
]);

/** The subset schema shape (structural documentation; values arrive as `unknown`). */
export interface ExperiencePayloadSchema {
	type?: (typeof PAYLOAD_SCHEMA_TYPES)[number];
	enum?: readonly unknown[];
	properties?: Record<string, ExperiencePayloadSchema>;
	required?: readonly string[];
	items?: ExperiencePayloadSchema;
	additionalProperties?: boolean;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
}

// ─── Primitives ──────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Descriptor-time schema validation ───────────────────────────────────────

/**
 * Validate a declared `payloadSchema` against the supported subset, recursing
 * into `properties`/`items`. Returns the first problem (unknown keyword, or a
 * keyword with a value outside its supported shape), or `{ ok: true }`.
 */
export function validatePayloadSchemaDefinition(
	schema: unknown,
): { ok: true } | { ok: false; message: string } {
	const problem = checkSchemaNode(schema, "payloadSchema");
	if (problem !== null) return { ok: false, message: problem };
	return { ok: true };
}

function checkSchemaNode(node: unknown, path: string): string | null {
	if (!isPlainObject(node)) {
		return `${path}: schema must be an object`;
	}
	for (const [key, value] of Object.entries(node)) {
		if (!ALLOWED_KEYWORDS.has(key)) {
			return `${path}: unknown keyword "${key}"`;
		}
		switch (key) {
			case "type": {
				if (
					typeof value !== "string" ||
					!(PAYLOAD_SCHEMA_TYPES as readonly string[]).includes(value)
				) {
					return `${path}.type: must be one of ${PAYLOAD_SCHEMA_TYPES.join(", ")}`;
				}
				break;
			}
			case "enum": {
				if (!Array.isArray(value)) {
					return `${path}.enum: must be an array`;
				}
				break;
			}
			case "properties": {
				if (!isPlainObject(value)) {
					return `${path}.properties: must be an object`;
				}
				for (const [name, sub] of Object.entries(value)) {
					const subProblem = checkSchemaNode(sub, `${path}.properties.${name}`);
					if (subProblem !== null) return subProblem;
				}
				break;
			}
			case "required": {
				if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
					return `${path}.required: must be an array of strings`;
				}
				break;
			}
			case "items": {
				const subProblem = checkSchemaNode(value, `${path}.items`);
				if (subProblem !== null) return subProblem;
				break;
			}
			case "additionalProperties": {
				if (typeof value !== "boolean") {
					return `${path}.additionalProperties: must be a boolean`;
				}
				break;
			}
			case "minimum":
			case "maximum": {
				if (typeof value !== "number" || !Number.isFinite(value)) {
					return `${path}.${key}: must be a finite number`;
				}
				break;
			}
			case "minLength":
			case "maxLength": {
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
					return `${path}.${key}: must be a non-negative integer`;
				}
				break;
			}
			default:
				// Unreachable — every allowed keyword is handled above.
				break;
		}
	}
	return null;
}

// ─── Value validation ────────────────────────────────────────────────────────

/**
 * Validate a payload value against a (pre-validated) subset schema. `path` is
 * the human-facing JSON path prefix (the kernel passes `"payload"`). Returns the
 * first violation with a path-qualified message, or `{ ok: true }`.
 *
 * A malformed schema (one that never went through
 * {@link validatePayloadSchemaDefinition}) is tolerated as a no-op rather than
 * a crash — enforcement responsibility lives at descriptor time; this function
 * only needs to be safe against a hand-built descriptor list.
 */
export function validatePayloadValue(
	payload: unknown,
	schema: unknown,
	path: string,
): { ok: true } | { ok: false; message: string } {
	if (!isPlainObject(schema)) {
		return { ok: true };
	}
	const fail = (message: string): { ok: false; message: string } => ({ ok: false, message: `${path}: ${message}` });

	// type
	if (typeof schema.type === "string" && !typeMatches(payload, schema.type)) {
		return fail(`expected ${schema.type}`);
	}

	// enum (deep JSON equality)
	if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => jsonEqual(allowed, payload))) {
		return fail("value is not one of the allowed enum values");
	}

	// object keywords (only apply when the payload is an object)
	if (isPlainObject(payload)) {
		const required = Array.isArray(schema.required) ? schema.required : [];
		for (const name of required) {
			if (typeof name !== "string") continue;
			if (!(name in payload)) {
				return fail(`missing required property "${name}"`);
			}
		}
		const additionalAllowed = schema.additionalProperties !== false;
		for (const [key, value] of Object.entries(payload)) {
			if (isPlainObject(schema.properties) && key in schema.properties) {
				const result = validatePayloadValue(value, schema.properties[key], `${path}.${key}`);
				if (!result.ok) return result;
			} else if (!additionalAllowed) {
				return fail(`property "${key}" is not allowed`);
			}
		}
	}

	// array keyword (only applies when the payload is an array)
	if (Array.isArray(payload) && schema.items !== undefined) {
		for (let i = 0; i < payload.length; i += 1) {
			const result = validatePayloadValue(payload[i], schema.items, `${path}[${i}]`);
			if (!result.ok) return result;
		}
	}

	// numeric bounds (only apply to numbers)
	if (typeof payload === "number") {
		if (typeof schema.minimum === "number" && payload < schema.minimum) {
			return fail(`must be >= ${schema.minimum}`);
		}
		if (typeof schema.maximum === "number" && payload > schema.maximum) {
			return fail(`must be <= ${schema.maximum}`);
		}
	}

	// string-length bounds (only apply to strings)
	if (typeof payload === "string") {
		if (typeof schema.minLength === "number" && payload.length < schema.minLength) {
			return fail(`length must be >= ${schema.minLength}`);
		}
		if (typeof schema.maxLength === "number" && payload.length > schema.maxLength) {
			return fail(`length must be <= ${schema.maxLength}`);
		}
	}

	return { ok: true };
}

function typeMatches(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return isPlainObject(value);
		case "array":
			return Array.isArray(value);
		case "null":
			return value === null;
		default:
			// Unknown type string — schema pre-validated; tolerate rather than crash.
			return true;
	}
}
