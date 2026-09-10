import type { UseFormRegisterReturn } from "react-hook-form";
import { cn } from "../../lib/cn.js";
import { inputCls, monoMod, readonlyMod } from "../../lib/field-tokens.js";

export type TextInputProps = Omit<React.ComponentProps<"input">, "className"> & {
  /** Optional extension appended AFTER the canon base. Omit it and the
   *  component renders the canonical single-line field (lib/field-tokens.ts
   *  `inputCls`) by definition — a bare TextInput can never drift from the
   *  app-wide input canon. This component has no legacy callers, so it uses
   *  clean composition (base first, extension last — `cn` joins, so extend
   *  with non-conflicting classes or `!`-important overrides where the base
   *  must lose); do not re-inline a full style. */
  className?: string;
  /** Mono variant for opaque technical content (API keys, voice IDs, regex
   *  patterns, template sequences). Composes `monoMod` onto the base; mono
   *  never carries its own size (the `text-xs` mono of the retired build
   *  tokens is dead — see lib/field-tokens.ts). */
  mono?: boolean;
  /** react-hook-form register() result — for uncontrolled fields; spread
   *  after the passthrough props so RHF handlers win when both are present. */
  register?: UseFormRegisterReturn<string>;
};

/** The canonical single-line input (FIELD_SYSTEM_UNIFICATION_REPORT FS-2).
 *
 * The app previously had ~45 raw `<input className={inputCls}>` sites, each
 * one typo away from a style fork — which is exactly how the v1.3 worker
 * wave smeared textarea-shaped mono tokens onto one-line fields. This
 * primitive is the enforcement point: the canon lives here, callers compose.
 *
 * Read-only styling is automatic: passing the standard HTML `readOnly`
 * attribute appends `readonlyMod` (cursor + dimming), replacing the four
 * hand-smears the provider forms carried. */
export function TextInput({ className, mono, register, ...rest }: TextInputProps) {
  return (
    <input
      {...rest}
      {...(register ?? {})}
      className={cn(inputCls, mono && monoMod, rest.readOnly && readonlyMod, className)}
    />
  );
}
