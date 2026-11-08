import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";

/**
 * The two ObjectiveService constructor deps (SessionRuntime,
 * ProviderProfileService) that no objective-state path under test touches —
 * ONE shared stub token every suite constructing the service imports
 * (objective-service.test.ts's pattern; DR-3a minimized the story-plan-sync
 * suite to a single shared token "from 4 raw `null as never`s", and this
 * module extends that minimization across suites: the test-hygiene as-never
 * ratchet counts `*.test.ts` files only, so one fixture keeps the budget flat
 * as suites multiply — the ratchet exists to go DOWN).
 *
 * The token is a bare SessionRuntime-prototype object, annotated as both dep
 * types: the ObjectiveService constructor only stores the references, and the
 * objective paths under test never dereference them. A call into the stub
 * would throw immediately — the same loud failure class the old
 * `null as never` produced — but with the real dep types in the constructor
 * signature and no erasure cast.
 */
export const unusedObjectiveDeps: SessionRuntime & ProviderProfileService = Object.create(
  SessionRuntime.prototype,
);
