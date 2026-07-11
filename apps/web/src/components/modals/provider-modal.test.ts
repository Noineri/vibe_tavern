import { describe, expect, it } from "vitest";
import type { SamplerFieldId } from "@vibe-tavern/domain";
import type { FormState } from "./ProviderModal.js";

// ERA-1: link the UI form state to the canonical sampler field set.
//
// FormState is a concrete interface (its sampler fields carry distinct types —
// number / string[] / logitBias array / nullable seed), so it cannot be
// *derived* from SamplerFieldId the way the wire schema is. Instead this
// non-distributive compile-time assertion binds its KEY SET: every
// SamplerFieldId MUST be a key of FormState.
//
// Because FormState's sampler fields are REQUIRED (non-optional), `profileToForm`
// — whose return type is FormState — is compile-forced to hydrate every one of
// them, so this single assertion transitively guards BOTH FormState key
// coverage AND profileToForm hydration. If a sampler is added to SamplerFieldId
// but forgotten in FormState (or profileToForm stops assigning one), this file
// stops compiling. The tuple-wrapped `[X] extends [Y]` form is deliberate: it
// disables distributivity so a single missing key fails the whole subset check.
type _FormStateCoversSamplers = [SamplerFieldId] extends [keyof FormState] ? true : never;
const _formStateCoversSamplers: _FormStateCoversSamplers = true;

describe("ProviderModal FormState ↔ canonical sampler set (ERA-1)", () => {
  it("FormState keys cover every SamplerFieldId (compile-time assertion above)", () => {
    // The real assertion is the type-level line above; this runtime test keeps
    // vitest from reporting an empty file and pins the invariant at run time too.
    expect(_formStateCoversSamplers).toBe(true);
  });
});
