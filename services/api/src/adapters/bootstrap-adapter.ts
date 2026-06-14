import type { BootstrapRuntimeApi } from "../api/contract/runtime-api.js";
import type { SessionRuntime } from "../session/session-runtime.js";

export class BootstrapAdapter implements BootstrapRuntimeApi {
	constructor(private readonly sessionRuntime: SessionRuntime) {}

	bootstrap = () => this.sessionRuntime.getBootstrapState();
}
