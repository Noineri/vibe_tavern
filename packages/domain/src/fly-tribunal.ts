/**
 * Shared persisted-memory format version for Fly Tribunal's sparse KC→MBON
 * delta payload. Domain owns it so API contracts, DB persistence, and the
 * browser worker cannot drift independently.
 */
export const FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION = 1;
