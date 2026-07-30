/**
 * Preserve the concrete Bun mock type through a named local binding.
 *
 * `mock.module()` changes runtime exports but not TypeScript's imported
 * function declarations, so canary tests bind the mock before registration
 * and pass that binding through this identity helper.
 */
export function mocked<T>(value: T): T {
	return value;
}
