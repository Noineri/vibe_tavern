/**
 * Schema-aware Scene state renderer — shared by the chat header (Scene zone,
 * expanded) and the Build → Insights → Scene Preview (SCENE_TRACKER_UX_FOLLOWUP
 * step 3).
 *
 * The validated `sceneState` block is always schema-conformant on the server
 * side (SCN-5 strict validation); this component is PRESENTATION ONLY — it walks
 * the user-authored DSL (`schema`) and renders the matching `data` values,
 * falling back to an em-dash `—` for missing/null leaves so a sparse record never
 * renders an empty gap. It never parses or mutates the data.
 *
 * Two variants share one recursive core:
 *  - `"rich"` (default) — bounded numbers render as an a11y `meter` (a neutral
 *    accent bar with `role="meter"` + `aria-valuenow/min/max`); objects/arrays
 *    render as an indented `border-l` tree.
 *  - `"compact"` — dense `key: value` lines with no bar and no tree chrome;
 *    bounded numbers append `(min–max)` since there is no bar to convey range.
 *
 * Recursion is schema-guided at every level, so an array-of-objects renders the
 * object fields (NOT `[object Object]` — the bug the previous flat `String()`
 * leaf shipped). The stale flag dims the whole view (`opacity-50`); callers that
 * need a different treatment can drop the flag and dim externally.
 */
import { type ReactNode } from "react";
import type { SceneTrackerDsl, SceneTrackerSchemaNode } from "@vibe-tavern/domain";
import { cn } from "../../lib/cn.js";

export type SceneStateVariant = "rich" | "compact";

interface SceneStateViewProps {
  /** The user-authored DSL describing the shape (drives rendering, not parsing). */
  schema: SceneTrackerDsl;
  /** The validated scene-state values to display. */
  data: Record<string, unknown>;
  /** Render variant — `"rich"` (graphical) or `"compact"` (dense text). */
  variant?: SceneStateVariant;
  /** When true, dims the whole view (e.g. a stale record in the header). */
  stale?: boolean;
  /** Extra classes merged onto the root column. */
  className?: string;
}

export function SceneStateView({ schema, data, variant = "rich", stale, className }: SceneStateViewProps) {
  return (
    <div className={cn("flex flex-col gap-0.5", stale && "opacity-50", className)}>
      {Object.entries(schema).map(([key, node]) => (
        <Field key={key} label={node.label ?? key} node={node} value={data[key]} variant={variant} />
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Field dispatch — recurses through object/array nodes, leaves to <Leaf>.
// `label` is undefined for array items rendered as bare values (primitives) and
// for object items whose own properties carry the labels.
// ────────────────────────────────────────────────────────────────────────────

function Field({
  label,
  node,
  value,
  variant,
}: {
  label: string | undefined;
  node: SceneTrackerSchemaNode;
  value: unknown;
  variant: SceneStateVariant;
}): ReactNode {
  switch (node.$type) {
    case "object": {
      const child = isPlainObject(value) ? (value as Record<string, unknown>) : null;
      return (
        <div className="flex flex-col gap-0.5">
          {label !== undefined && <ContainerLabel label={label} />}
          <div className={cn(variant === "rich" ? "ml-2 border-l border-border pl-2" : "ml-3", "flex flex-col gap-0.5")}>
            {child
              ? Object.entries(node.properties).map(([k, n]) => (
                  <Field key={k} label={n.label ?? k} node={n} value={child[k]} variant={variant} />
                ))
              : <Dash />}
          </div>
        </div>
      );
    }
    case "array": {
      const items = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-col gap-0.5">
          {label !== undefined && <ContainerLabel label={label} />}
          <div className={cn(variant === "rich" ? "ml-2 border-l border-border pl-2" : "ml-3", "flex flex-col gap-0.5")}>
            {items.length === 0 ? (
              <span className="text-[11px] text-t4">[]</span>
            ) : (
              items.map((item, i) => <ArrayItem key={i} index={i} itemNode={node.items} value={item} variant={variant} />)
            )}
          </div>
        </div>
      );
    }
    case "boolean":
    case "number":
    case "string":
      return <Leaf label={label} node={node} value={value} variant={variant} />;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Array items — object items recurse into their fields (fixing the
// `[object Object]` flat-String bug); primitives render as bare values.
// ────────────────────────────────────────────────────────────────────────────

function ArrayItem({
  index,
  itemNode,
  value,
  variant,
}: {
  index: number;
  itemNode: SceneTrackerSchemaNode;
  value: unknown;
  variant: SceneStateVariant;
}): ReactNode {
  if (itemNode.$type === "object") {
    const child = isPlainObject(value) ? (value as Record<string, unknown>) : null;
    return (
      <div className={cn(variant === "rich" ? "rounded border border-border2 bg-s2/40 px-1.5 py-1" : "", "flex flex-col gap-0.5")}>
        <span className="text-[10px] text-t4">#{index + 1}</span>
        {child
          ? Object.entries(itemNode.properties).map(([k, n]) => (
              <Field key={k} label={n.label ?? k} node={n} value={child[k]} variant={variant} />
            ))
          : <Dash />}
      </div>
    );
  }
  if (itemNode.$type === "array") {
    // Array-of-arrays — recurse via Field (label = the 1-based index).
    return <Field label={`#${index + 1}`} node={itemNode} value={value} variant={variant} />;
  }
  // Primitive item — value only, no key label.
  return <Leaf label={undefined} node={itemNode} value={value} variant={variant} />;
}

// ────────────────────────────────────────────────────────────────────────────
// Leaf — primitive rendering. Bounded numbers get a meter in `rich`.
// ────────────────────────────────────────────────────────────────────────────

function Leaf({
  label,
  node,
  value,
  variant,
}: {
  label: string | undefined;
  node: Extract<SceneTrackerSchemaNode, { $type: "string" | "number" | "boolean" }>;
  value: unknown;
  variant: SceneStateVariant;
}): ReactNode {
  if (node.$type === "boolean") {
    const text = value == null ? "—" : value ? "✓" : "✗";
    return (
      <KvRow label={label}>
        <span className={cn("text-[11px]", value === true ? "text-accent" : "text-t4")}>{text}</span>
      </KvRow>
    );
  }

  if (node.$type === "number") {
    const n = typeof value === "number" ? value : null;
    const { min, max } = node;
    // Inline the null checks so TS narrows `min`/`max` to `number` inside each
    // branch (a `const bounded = …` boolean would NOT carry the narrowing).
    if (min != null && max != null && n != null && variant === "rich") {
      const span = (max - min) || 1;
      const pct = Math.max(0, Math.min(100, ((n - min) / span) * 100));
      return (
        <div className="flex min-w-0 items-center gap-2">
          {label !== undefined && <span className="shrink-0 text-[11px] text-t4">{label}</span>}
          <div
            role="meter"
            aria-valuenow={n}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-label={label}
            className="h-1.5 min-w-[36px] flex-1 overflow-hidden rounded-full bg-s2"
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <span className="shrink-0 text-[11px] font-medium tabular-nums text-t2">{formatNum(n)}</span>
        </div>
      );
    }

    // Unbounded number, compact mode, or missing value → plain text. A bounded
    // number appends `(min–max)` (compact has no bar to convey the range).
    const valueText = n == null ? "—" : formatNum(n);
    const rangeSuffix = min != null && max != null && n != null ? ` (${formatNum(min)}–${formatNum(max)})` : "";
    return (
      <KvRow label={label}>
        <span className="text-[11px] tabular-nums text-t2">{valueText}{rangeSuffix}</span>
      </KvRow>
    );
  }

  // string (and any non-matching primitive falls through to string-ish display).
  const text = value == null ? "—" : typeof value === "string" ? value : String(value);
  return (
    <KvRow label={label}>
      <span className="truncate text-[11px] text-t2">{text}</span>
    </KvRow>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Small presentational helpers
// ────────────────────────────────────────────────────────────────────────────

/** Inline `label:` + value row. Used by every non-meter leaf. */
function KvRow({ label, children }: { label: string | undefined; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      {label !== undefined && <span className="shrink-0 text-[11px] text-t4">{label}:</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function ContainerLabel({ label }: { label: string }) {
  return <span className="text-[10px] font-semibold uppercase tracking-[0.04em] text-t4">{label}</span>;
}

function Dash() {
  return <span className="text-[11px] text-t4">—</span>;
}

// ────────────────────────────────────────────────────────────────────────────
// Pure value helpers
// ────────────────────────────────────────────────────────────────────────────

/** Trim trailing zeros for display: 7.0 → "7", 7.5 → "7.5", 7.25 → "7.25". */
function formatNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
