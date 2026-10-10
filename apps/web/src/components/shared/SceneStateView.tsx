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
 * Four variants share one recursive core. `"rich"` (default) renders bounded
 * numbers as a11y meters and objects/arrays as an indented `border-l` tree;
 * `"compact"` keeps dense `key: value` lines without bars or tree chrome.
 * `"clean"` and `"hud"` are accepted preference values ahead of their visual
 * implementations and use rich's neutral fallback in this shared core.
 *
 * Recursion is schema-guided at every level, so an array-of-objects renders the
 * object fields (NOT `[object Object]` — the bug the previous flat `String()`
 * leaf shipped). The stale flag dims the whole view (`opacity-50`); callers that
 * need a different treatment can drop the flag and dim externally.
 */
import { type ReactNode } from "react";
import type { SceneTrackerDsl, SceneTrackerSchemaNode } from "@vibe-tavern/domain";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import type { SceneRenderVariant } from "../../stores/scene-render-store.js";

const METER_MAX_RANGE = 1000;

interface SceneStateViewProps {
  /** The user-authored DSL describing the shape (drives rendering, not parsing). */
  schema: SceneTrackerDsl;
  /** The validated scene-state values to display. */
  data: Record<string, unknown>;
  /** Render variant preference; unimplemented variants use rich's neutral fallback. */
  variant?: SceneRenderVariant;
  /** When true, dims the whole view (e.g. a stale record in the header). */
  stale?: boolean;
  /** Extra classes merged onto the root column. */
  className?: string;
}

export function SceneStateView({ schema, data, variant = "rich", stale, className }: SceneStateViewProps) {
  const { t } = useT();
  return (
    <div className={cn("flex flex-col gap-0.5", stale && "opacity-50", className)}>
      {Object.entries(schema).map(([key, node]) => (
        <Field key={key} label={node.label ?? key} node={node} value={data[key]} variant={variant} emptyLabel={t("scn_state_empty")} />
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
  emptyLabel,
}: {
  label: string | undefined;
  node: SceneTrackerSchemaNode;
  value: unknown;
  variant: SceneRenderVariant;
  emptyLabel: string;
}): ReactNode {
  switch (node.$type) {
    case "object": {
      const child = isPlainObject(value) ? (value as Record<string, unknown>) : null;
      return (
        <div className="flex flex-col gap-0.5">
          {label !== undefined && <ContainerLabel label={label} />}
          <div className={cn(variant === "compact" ? "ml-3" : "ml-2 border-l border-border pl-2", "flex flex-col gap-0.5")}>
            {child
              ? Object.entries(node.properties).map(([k, n]) => (
                  <Field key={k} label={n.label ?? k} node={n} value={child[k]} variant={variant} emptyLabel={emptyLabel} />
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
          <div className={cn(variant === "compact" ? "ml-3" : "ml-2 border-l border-border pl-2", "flex flex-col gap-0.5")}>
            {items.length === 0 ? (
              <span className="text-[11px] text-t4">{emptyLabel}</span>
            ) : (
              items.map((item, i) => <ArrayItem key={i} index={i} itemNode={node.items} value={item} variant={variant} emptyLabel={emptyLabel} />)
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
  emptyLabel,
}: {
  index: number;
  itemNode: SceneTrackerSchemaNode;
  value: unknown;
  variant: SceneRenderVariant;
  emptyLabel: string;
}): ReactNode {
  if (itemNode.$type === "object") {
    const child = isPlainObject(value) ? (value as Record<string, unknown>) : null;
    return (
      <div className={cn(variant === "compact" ? "" : "rounded border border-border2 bg-s2/40 px-1.5 py-1", "flex flex-col gap-0.5")}>
        <span className="text-[10px] text-t4">{itemNode.label ?? `#${index + 1}`}</span>
        {child
          ? Object.entries(itemNode.properties).map(([k, n]) => (
              <Field key={k} label={n.label ?? k} node={n} value={child[k]} variant={variant} emptyLabel={emptyLabel} />
            ))
          : <Dash />}
      </div>
    );
  }
  if (itemNode.$type === "array") {
    // Array-of-arrays — recurse via Field (label = the 1-based index).
    return <Field label={`#${index + 1}`} node={itemNode} value={value} variant={variant} emptyLabel={emptyLabel} />;
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
  variant: SceneRenderVariant;
}): ReactNode {
  if (node.$type === "boolean") {
    const text = value == null ? "—" : value ? "✓" : "✗";
    return (
      <KvRow label={label} variant={variant}>
        <span className={cn("text-[11px]", value === true ? "text-accent" : "text-t4")}>{text}</span>
      </KvRow>
    );
  }

  if (node.$type === "number") {
    const n = typeof value === "number" ? value : null;
    const { min, max } = node;
    // Inline the null checks so TS narrows `min`/`max` to `number` inside each
    // branch (a `const bounded = …` boolean would NOT carry the narrowing).
    const range = min != null && max != null ? max - min : null;
    if (min != null && max != null && n != null && variant !== "compact" && range !== null && range !== 0 && range <= METER_MAX_RANGE) {
      const pct = Math.max(0, Math.min(100, ((n - min) / range) * 100));
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

    // Unbounded values, fixed values, and compact mode render as text. Compact
    // keeps its established bounded-range suffix. Rich's huge ranges surface the
    // useful maximum without implying progress through a meaningless meter.
    const valueText = n == null ? "—" : formatNum(n);
    const isHugeRange = range !== null && range > METER_MAX_RANGE;
    const rangeSuffix = variant === "compact" && range !== 0 && min != null && max != null && n != null
      ? ` (${formatNum(min)}–${formatNum(max)})`
      : "";
    return (
      <KvRow label={label} variant={variant}>
        <span className="text-[11px] tabular-nums text-t2">
          {valueText}{rangeSuffix}
          {isHugeRange && variant !== "compact" && n != null && max != null && <span className="text-t4"> / {formatNum(max)}</span>}
        </span>
      </KvRow>
    );
  }

  // string (and any non-matching primitive falls through to string-ish display).
  // E1 (MOBILE_DEFECTS_ROUND_2): values WRAP, never truncate — `truncate`'s
  // nowrap both clipped values on desktop (ellipsis past the fold) and inflated
  // the intrinsic min-content width on mobile (horizontal scroll). `anywhere`
  // (not `break-words`) so min-content sizing itself accounts for the break —
  // the column cannot push its container wider than the viewport.
  const text = value == null ? "—" : typeof value === "string" ? value : String(value);
  return (
    <KvRow label={label} variant={variant}>
      <span className="text-[11px] text-t2 [overflow-wrap:anywhere]">{text}</span>
    </KvRow>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Small presentational helpers
// ────────────────────────────────────────────────────────────────────────────

/** Inline label and value row. Compact preserves its established dense colon separator. */
function KvRow({ label, variant, children }: { label: string | undefined; variant: SceneRenderVariant; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      {label !== undefined && <span className="shrink-0 text-[11px] text-t4">{variant === "compact" && !label.endsWith(":") ? `${label}:` : label}</span>}
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
