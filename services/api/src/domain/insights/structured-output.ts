import type { ZodType } from "zod";

/**
 * Extract and validate one structured JSON value from an LLM response.
 *
 * Models occasionally wrap otherwise-correct JSON in a markdown fence or a
 * short prose prefix/suffix. This helper tolerates those transport wrappers,
 * but never tolerates a schema mismatch: callers provide the exact Zod schema
 * for the machine-output contract. Scene Tracker reuses this boundary for its
 * generated data.
 */
export function parseStructuredOutput<T>(text: string, schema: ZodType<T>): T {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    throw new Error("Model output did not contain a valid JSON object.");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Model output did not contain a valid JSON object.${detail}`);
  }

  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Model output failed structured validation: ${detail}`);
  }
  return result.data;
}

function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) return fence[1].trim() || null;

  const start = findJsonStart(trimmed);
  if (start < 0) return null;
  return extractBalancedValue(trimmed, start);
}

function findJsonStart(text: string): number {
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  if (objectStart < 0) return arrayStart;
  if (arrayStart < 0) return objectStart;
  return Math.min(objectStart, arrayStart);
}

function extractBalancedValue(text: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;

    const expectedOpen = char === "}" ? "{" : "[";
    if (stack.pop() !== expectedOpen) return null;
    if (stack.length === 0) return text.slice(start, index + 1);
  }

  return null;
}
