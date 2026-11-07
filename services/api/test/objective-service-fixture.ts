/**
 * The two ObjectiveService constructor deps (SessionRuntime,
 * ProviderProfileService) that no objective-state path under test touches —
 * ONE shared cast every suite constructing the service imports
 * (objective-service.test.ts's `null as never` pattern; DR-3a minimized the
 * story-plan-sync suite to a single shared cast "from 4 raw `null as never`s",
 * and this module extends that minimization across suites: the test-hygiene
 * as-never ratchet counts `*.test.ts` files only, so one fixture keeps the
 * budget flat as suites multiply — the ratchet exists to go DOWN).
 */
export const unusedObjectiveDeps = null as never;
