/**
 * Bounded-JSON guard — the server-authoritative JSON-safety + depth + size
 * enforcement behind the Interactive Runtime wire schemas (IR-11), the
 * synchronous experience kernel (IR-12), and the web frame's kernel mirror.
 *
 * Extracted from interactive-schema.ts when that file hit the architecture
 * size ratchet (re-exported there, so the public surface is unchanged).
 * Pure: no I/O, no domain imports; only Zod for the `boundedJsonValue`
 * schema factory — `jsonBoundsError` itself is standalone so the kernel
 * reuses the exact same enforcement without coupling to Zod.
 */

import { z } from "zod";

import { isRecord } from "@vibe-tavern/domain";

/**
 * Validate that `value` is JSON-safe, nests no deeper than `maxDepth`, and
 * serializes to no more than `maxBytes`. Returns a stable error reason string,
 * or `null` when valid. Pure (no I/O, no Zod) so the synchronous kernel (IR-12)
 * reuses the exact same enforcement as the wire schema. Rejects `undefined`,
 * functions, symbols, bigints, non-finite numbers, and true ancestor cycles —
 * shared references are allowed (they duplicate on serialization); only a
 * value that is its own ancestor cannot round-trip through
 * `JSON.parse(JSON.stringify(…))`.
 */
export function jsonBoundsError(
  value: unknown,
  opts: { maxDepth: number; maxBytes: number },
): string | null {
  const { maxDepth, maxBytes } = opts;
  // Iterative DFS with explicit enter/exit frames. `onPath` holds only the
  // objects on the CURRENT recursion path (entered, not yet exited), so the
  // same object reachable via two paths — a shared reference / DAG — is walked
  // once per path and allowed; only an object among its own ancestors rejects
  // as a true cycle. Walk cost stays bounded by the serialized output (every
  // duplicated path materializes in JSON.stringify), which maxBytes caps.
  type Frame = { kind: "enter"; v: unknown; d: number } | { kind: "exit"; v: unknown };
  const stack: Frame[] = [{ kind: "enter", v: value, d: 0 }];
  const onPath = new Set<unknown>();
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "exit") {
      onPath.delete(frame.v);
      continue;
    }
    const { v, d } = frame;
    const t = typeof v;
    if (v === null || t === "boolean") continue;
    if (t === "number") {
      if (!Number.isFinite(v)) return "non-finite number is not JSON-safe";
      continue;
    }
    if (t === "string") continue;
    if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
      return `value of type ${t} is not JSON-safe`;
    }
    // Object or array: enforce depth + ancestor-cycle guard before descending.
    if (d + 1 > maxDepth) {
      return `json nesting depth exceeds ${maxDepth}`;
    }
    if (onPath.has(v)) {
      return "cyclic structure is not JSON-safe";
    }
    onPath.add(v);
    stack.push({ kind: "exit", v });
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        stack.push({ kind: "enter", v: v[i], d: d + 1 });
      }
    } else if (isRecord(v)) {
      for (const child of Object.values(v)) {
        stack.push({ kind: "enter", v: child, d: d + 1 });
      }
    } else {
      return "value is not JSON-safe";
    }
  }
  // Size guard via serialization (also catches anything the walk could miss).
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "value is not JSON-serializable";
  }
  if (serialized.length > maxBytes) {
    return `json size ${serialized.length} exceeds ${maxBytes} bytes`;
  }
  return null;
}

/**
 * A `z.unknown()` refined by {@link jsonBoundsError}. Use for authoritative
 * state, projected state, action payloads, event details, and effect requests —
 * anywhere untrusted/sandbox-produced JSON must be bounded before persistence or
 * visual delivery.
 */
export function boundedJsonValue(opts: { maxDepth: number; maxBytes: number }) {
  return z.unknown().superRefine((value, ctx) => {
    const err = jsonBoundsError(value, opts);
    if (err !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    }
  });
}
