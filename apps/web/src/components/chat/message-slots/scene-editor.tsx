/**
 * Scene structured editor body (SCN-12d) — the recursive, schema-guided value
 * editor rendered inside the shared Modal (desktop) / BottomSheet (mobile) that
 * `scene-zone.tsx` opens on `Edit Scene`.
 *
 * Edits a local deep-cloned draft of the selected variant's `sceneState`, one
 * input per schema leaf (string → text, number → number w/ min/max, boolean →
 * Toggle), recursing into objects and rendering array templates as add/remove
 * item lists. The server re-validates strictly against the chat's current DSL on
 * save (paths/ranges/bounds/limits/reserved segments/ownership/config revision),
 * so this editor does light client-side shaping and lets the server be the
 * correctness boundary — a save that the server rejects surfaces as a toast
 * (the caller owns the error UX), leaving the prior valid record untouched.
 *
 * Reuses shared primitives: `Toggle`, `inputCls`/`inputPad`/`lblCls` field styles.
 * No bespoke input chrome — see AGENTS.md §9.
 */
import { useState, type ReactNode } from "react";
import type { SceneTrackerDsl, SceneTrackerSchemaNode } from "@vibe-tavern/domain";
import { Toggle } from "../../shared/Toggle.js";
import { inputCls, inputPad, lblCls } from "../../build/fields/field-styles.js";
import type { TFunc } from "../../../i18n/context.js";

export function SceneEditorBody({ schema, initial, onSave, onCancel, t }: {
  schema: SceneTrackerDsl;
  initial: Record<string, unknown>;
  onSave: (next: Record<string, unknown>) => void;
  onCancel: () => void;
  t: TFunc;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => deepClone(initial));

  return (
    <div className="flex flex-col gap-3">
      <FieldsEditor schema={schema} value={draft} onChange={setDraft} t={t} />
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <button type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-sm text-t3 transition-colors hover:bg-s2">
          {t("scn_edit_cancel")}
        </button>
        <button type="button" onClick={() => onSave(draft)} className="rounded bg-accent px-3 py-1.5 text-sm text-white transition-opacity hover:opacity-90">
          {t("scn_edit_save")}
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Recursive fields editor
// ────────────────────────────────────────────────────────────────────────────

function FieldsEditor({ schema, value, onChange, t }: {
  schema: SceneTrackerDsl;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  t: TFunc;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {Object.entries(schema).map(([key, node]) => (
        <FieldRow key={key} label={key} node={node} value={value[key]} onChange={(v) => onChange({ ...value, [key]: v })} t={t} />
      ))}
    </div>
  );
}

function FieldRow({ label, node, value, onChange, t }: {
  label: string;
  node: SceneTrackerSchemaNode;
  value: unknown;
  onChange: (v: unknown) => void;
  t: TFunc;
}) {
  if (node.$type === "object") {
    const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return (
      <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
        <legend className={lblCls + " px-1"}>{label}</legend>
        <FieldsEditor schema={node.properties} value={obj} onChange={onChange} t={t} />
      </fieldset>
    );
  }
  if (node.$type === "array") {
    return <ArrayEditor label={label} items={node.items} value={value} onChange={onChange} t={t} />;
  }
  // Leaves
  return (
    <div className="flex flex-col gap-1">
      <label className={lblCls}>{label}{node.$type === "number" && (node.min != null || node.max != null) ? ` (${rangeHint(node)})` : ""}</label>
      <LeafInput node={node} value={value} onChange={onChange} />
    </div>
  );
}

function LeafInput({ node, value, onChange }: { node: Extract<SceneTrackerSchemaNode, { $type: "string" | "number" | "boolean" }>; value: unknown; onChange: (v: unknown) => void }) {
  if (node.$type === "boolean") {
    return <Toggle checked={value === true} onChange={onChange} />;
  }
  if (node.$type === "number") {
    return (
      <input
        type="number"
        inputMode="decimal"
        value={typeof value === "number" ? value : Number(value) || 0}
        min={node.min}
        max={node.max}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        className={inputCls}
        style={inputPad}
      />
    );
  }
  return (
    <input
      type="text"
      value={typeof value === "string" ? value : value == null ? "" : String(value)}
      maxLength={4000}
      onChange={(e) => onChange(e.target.value)}
      className={inputCls}
      style={inputPad}
    />
  );
}

function ArrayEditor({ label, items, value, onChange, t }: {
  label: string;
  items: SceneTrackerSchemaNode;
  value: unknown;
  onChange: (v: unknown) => void;
  t: TFunc;
}) {
  const arr = Array.isArray(value) ? value : [];
  const isLeaf = items.$type === "string" || items.$type === "number" || items.$type === "boolean";

  function updateAt(i: number, v: unknown) {
    const next = arr.slice();
    next[i] = v;
    onChange(next);
  }
  function removeAt(i: number) {
    onChange(arr.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...arr, defaultLeaf(items)]);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className={lblCls}>{label}</label>
        <button type="button" onClick={add} className="rounded px-2 py-0.5 text-[11px] text-accent transition-colors hover:bg-s2">
          + {t("scn_edit_add_item")}
        </button>
      </div>
      {arr.length === 0 && <p className="text-[11px] text-t4">[]</p>}
      <div className="flex flex-col gap-1.5">
        {arr.map((item, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              {isLeaf ? (
                <LeafInput node={items as Extract<SceneTrackerSchemaNode, { $type: "string" | "number" | "boolean" }>} value={item} onChange={(v) => updateAt(i, v)} />
              ) : items.$type === "object" ? (
                <FieldsEditor schema={(items as { properties: SceneTrackerDsl }).properties} value={(item && typeof item === "object" ? item : {}) as Record<string, unknown>} onChange={(v) => updateAt(i, v)} t={t} />
              ) : (
                <span className="text-[11px] text-t4">{t("scn_edit_nested_array_unsupported")}</span>
              )}
            </div>
            <button type="button" onClick={() => removeAt(i)} className="shrink-0 rounded px-1.5 py-1 text-t4 transition-colors hover:bg-s2 hover:text-danger" aria-label={t("scn_edit_remove_item")}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function rangeHint(node: Extract<SceneTrackerSchemaNode, { $type: "number" }>): string {
  if (node.min != null && node.max != null) return `${node.min}–${node.max}`;
  if (node.min != null) return `≥ ${node.min}`;
  if (node.max != null) return `≤ ${node.max}`;
  return "";
}

/** Default value for a freshly-added array item, per the item schema. */
function defaultLeaf(node: SceneTrackerSchemaNode): unknown {
  switch (node.$type) {
    case "string": return "";
    case "number": return node.min ?? 0;
    case "boolean": return false;
    case "object": return {};
    case "array": return [];
  }
}

function deepClone<T>(v: T): T {
  return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)) as T;
}

// Kept for future toolbar extensions (e.g. a reset-to-generated button); unused
// today but exported so the editor's surface is stable for the zone.
export type { ReactNode };
