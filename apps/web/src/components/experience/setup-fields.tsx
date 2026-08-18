/**
 * Setup-fields primitives shared by the launch surfaces (IR-70F setup
 * descriptor rendering). Extracted verbatim from ExperienceSetupModal so the
 * sandbox playground (EXPERIENCE_ENGINE_LOBBY_REPORT, Track A) renders the
 * SAME validated form as the real launcher instead of a raw JSON textarea.
 *
 * What lives here (pure + presentational, zero I/O, zero stores):
 *  - `SetupFieldRow` — one labeled setup field (text / number / boolean /
 *    select) with inline error, the single row renderer both surfaces share.
 *  - `seedSetupDefaults` / `validateSetupFields` — the field-value ⇄ settings
 *    mapping rules (author defaults seeded on a clean discovery; untouched
 *    optional empties omitted; per-kind constraint validation). The value
 *    representation is the modal's: `string | boolean | undefined` per field
 *    id plus a `numberEntered` set distinguishing "entered 0" from untouched.
 *  - `deriveSetupValuesFromSettings` / `mergeAbsentSetupDefaults` — the
 *    playground's JSON-side mapping (settings object → form values, and
 *    seeding absent author defaults INTO a settings object), same omission
 *    semantics as the modal path.
 *  - `matchesStep` / `FieldError` — shared by the functions above.
 *
 * The modal keeps its own `fieldValues`/`numberEntered`/`fieldErrors` state;
 * the playground derives its values from its settings-JSON source of truth.
 * Both converge on `validateSetupFields`, so a launch through either surface
 * sends settings built by identical rules.
 */
import type { ExperienceSetupFieldDto } from "@vibe-tavern/api-contracts";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { Checkbox } from "../shared/Checkbox.js";
import { NumberInput } from "../shared/NumberInput.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { Ic } from "../shared/icons.js";
import type Resources from "../../i18n/resources.js";

/** The four canonical setup-field kinds (IR-70F), discriminated by `kind`. */
export type SetupField = ExperienceSetupFieldDto;

/** The i18n `t` shape both launch surfaces pass down (key-typed). */
export type SetupFieldTFunc = (key: keyof Resources["en"], opts?: Record<string, unknown>) => string;

/** Form-side value representation: string for text/number/select, boolean for
 *  booleans, undefined = absent (untouched). Numbers are held as strings so
 *  partial input is representable; `numberEntered` marks a value as a real
 *  user/authored entry (vs. an untouched placeholder). */
export interface SetupFieldValues {
  readonly values: Record<string, string | boolean | undefined>;
  readonly entered: Set<string>;
}

/** Float-tolerant step check: `value` must be a whole multiple of `step`
 * measured from `min` (or 0 when unbounded). Returns false for non-finite. */
export function matchesStep(value: number, min: number | undefined, step: number | undefined): boolean {
  if (!Number.isFinite(value)) return false;
  if (step === undefined) return true;
  const base = min ?? 0;
  const quotient = (value - base) / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

/** Seed author `default`s for a freshly discovered field list (the modal's
 * clean-discovery seeding). Only fields WITH a `default` are seeded; optional
 * untouched fields with no default stay ABSENT (preservation of omission).
 * Number fields with a default are marked entered so they submit as real
 * values. */
export function seedSetupDefaults(fields: readonly SetupField[]): SetupFieldValues {
  const values: Record<string, string | boolean | undefined> = {};
  const entered = new Set<string>();
  for (const field of fields) {
    if (field.kind === "boolean") {
      if (field.default !== undefined) values[field.id] = field.default;
      // else: undefined → absent (no-default boolean stays absent until checked)
    } else if (field.kind === "number") {
      if (field.default !== undefined) {
        values[field.id] = String(field.default);
        entered.add(field.id);
      }
    } else {
      // text / select
      if (field.default !== undefined) values[field.id] = field.default;
    }
  }
  return { values, entered };
}

/** Validate setup-field values → a clean bounded settings object (omitting
 * optional untouched empties) or per-field error messages. Pure: the caller
 * decides what to do with `errors` (the modal paints them inline and blocks
 * Start; the playground does the same on start/discover/simulate). */
export function validateSetupFields(opts: {
  fields: readonly SetupField[];
  values: Record<string, string | boolean | undefined>;
  entered: ReadonlySet<string>;
  t: SetupFieldTFunc;
}): { ok: true; settings: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const { fields, values, entered, t } = opts;
  const errors: Record<string, string> = {};
  const settings: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.id];
    if (field.kind === "boolean") {
      if (raw === true || raw === false) settings[field.id] = raw;
      // undefined → absent (booleans are never required)
      continue;
    }
    if (field.kind === "number") {
      const hasEntry = entered.has(field.id);
      if (!hasEntry) {
        if (field.required) errors[field.id] = t("experience_setup_field_required_error");
        continue; // optional untouched number → omitted
      }
      const num = typeof raw === "string" ? Number(raw) : NaN;
      if (!Number.isFinite(num)) {
        errors[field.id] = t("experience_setup_field_number_nan");
        continue;
      }
      if (field.min !== undefined && num < field.min) {
        errors[field.id] = t("experience_setup_field_number_below_min", { min: field.min });
        continue;
      }
      if (field.max !== undefined && num > field.max) {
        errors[field.id] = t("experience_setup_field_number_above_max", { max: field.max });
        continue;
      }
      if (!matchesStep(num, field.min, field.step)) {
        errors[field.id] = t("experience_setup_field_number_step", { step: field.step ?? 1 });
        continue;
      }
      settings[field.id] = num;
      continue;
    }
    if (field.kind === "text") {
      const value = typeof raw === "string" ? raw : "";
      if (value === "") {
        if (field.required) errors[field.id] = t("experience_setup_field_required_error");
        continue; // optional untouched text → omitted
      }
      if (field.minLength !== undefined && value.length < field.minLength) {
        errors[field.id] = t("experience_setup_field_text_too_short", { min: field.minLength });
        continue;
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        errors[field.id] = t("experience_setup_field_text_too_long", { max: field.maxLength });
        continue;
      }
      settings[field.id] = value;
      continue;
    }
    // select
    const value = typeof raw === "string" ? raw : "";
    if (value === "") {
      if (field.required) errors[field.id] = t("experience_setup_field_required_error");
      continue; // optional untouched select → omitted
    }
    if (!field.options.some((o) => o.value === value)) {
      errors[field.id] = t("experience_setup_field_select_invalid");
      continue;
    }
    settings[field.id] = value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, settings };
}

/** Derive form values from a parsed settings OBJECT (the playground path: the
 * settings JSON is the single source of truth and the form renders it). An
 * explicit JSON entry wins regardless of the author default; a type-mismatched
 * entry (e.g. a string where a number is declared) is ignored in favor of the
 * default — the hand-written value stays in the JSON untouched and surfaces as
 * a validation error if the field is entered. Defaults land marked entered
 * (modal parity: a defaulted number submits as a real value). */
export function deriveSetupValuesFromSettings(fields: readonly SetupField[], settings: Record<string, unknown>): SetupFieldValues {
  const values: Record<string, string | boolean | undefined> = {};
  const entered = new Set<string>();
  for (const field of fields) {
    const raw = settings[field.id];
    if (field.kind === "boolean") {
      if (typeof raw === "boolean") {
        values[field.id] = raw;
        continue;
      }
      if (field.default !== undefined) values[field.id] = field.default;
      continue;
    }
    if (field.kind === "number") {
      if (typeof raw === "number" && Number.isFinite(raw)) {
        values[field.id] = String(raw);
        entered.add(field.id);
        continue;
      }
      if (field.default !== undefined) {
        values[field.id] = String(field.default);
        entered.add(field.id);
      }
      continue;
    }
    // text / select
    if (typeof raw === "string") {
      values[field.id] = raw;
      continue;
    }
    if (field.default !== undefined) values[field.id] = field.default;
  }
  return { values, entered };
}

/** Seed ABSENT author defaults into a parsed settings object (the playground's
 * JSON write-through: the declared defaults become visible and persistent in
 * the settings the launch actually sends). Existing explicit entries are never
 * touched. Returns the SAME object reference when nothing was missing, so the
 * caller can skip a state write that would only churn formatting. */
export function mergeAbsentSetupDefaults(
  settings: Record<string, unknown>,
  fields: readonly SetupField[],
): Record<string, unknown> {
  let changed = false;
  const next = { ...settings };
  for (const field of fields) {
    if (field.default === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(next, field.id)) continue;
    next[field.id] = field.default;
    changed = true;
  }
  return changed ? next : settings;
}

/** Inline field error line (role=alert) shared by the setup form rows and the
 * modal's roster/phase errors. */
export function FieldError({ text }: { text: string }) {
  return (
    <p className="font-ui text-[11px] leading-relaxed text-danger-text" role="alert">
      {text}
    </p>
  );
}

interface SetupFieldRowProps {
  field: SetupField;
  value: string | boolean | undefined;
  error: string | undefined;
  t: SetupFieldTFunc;
  onText: (v: string) => void;
  onNumber: (v: number) => void;
  onToggle: () => void;
  onSelect: (v: string) => void;
}

export function SetupFieldRow({ field, value, error, t, onText, onNumber, onToggle, onSelect }: SetupFieldRowProps) {
  const requiredMark = "required" in field && field.required ? ` — ${t("experience_setup_field_required")}` : "";
  return (
    <div className="flex flex-col gap-1" data-field-id={field.id}>
      <div className="flex items-center gap-1">
        <label className="font-ui text-[12px] font-medium text-t2">
          {field.label}
          {requiredMark}
        </label>
        {field.description && (
          <CustomTooltip content={field.description}>
            <span className="mt-px shrink-0 text-t3"><Ic.help /></span>
          </CustomTooltip>
        )}
      </div>
      {field.kind === "text" && (
        <AutoTextarea
          className="rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-[13px] text-t1 outline-none focus:border-accent"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onText(e.target.value)}
          placeholder={"placeholder" in field ? field.placeholder : undefined}
          minRows={1}
          maxRows={4}
          macroAutocomplete={false}
        />
      )}
      {field.kind === "number" && (
        <NumberInput
          value={typeof value === "string" && value !== "" ? Number(value) : 0}
          onChange={onNumber}
          min={"min" in field ? field.min : undefined}
          max={"max" in field ? field.max : undefined}
          step={"step" in field ? field.step : undefined}
        />
      )}
      {field.kind === "boolean" && (
        <Checkbox checked={value === true} onChange={onToggle} label={field.label} />
      )}
      {field.kind === "select" && (
        <DropdownSelect
          value={typeof value === "string" ? value : ""}
          options={field.options.map((o) => ({ id: o.value, label: o.label }))}
          placeholder={t("experience_setup_select_placeholder")}
          onChange={onSelect}
        />
      )}
      {error && <FieldError text={error} />}
    </div>
  );
}
